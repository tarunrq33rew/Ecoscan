/* =========================================================
   ECOSCAN — Frontend App Logic
   API key lives server-side; this script calls /api/gemini.
   ========================================================= */

const PRIMARY_PROMPT = `You are EcoScan, an expert AI waste analyst. Analyse this waste item and respond ONLY with a valid JSON object. No markdown, no explanation, no code fences. Use exactly this schema: { itemName: string, wasteType: one of plastic or organic or metal or ewaste or paper or glass or general, recyclable: Yes or No or Partially, decomposeTime: string like 450 years or 2 weeks, co2SavedKg: number, confidencePct: number between 80 and 99, upcycleIdeas: array of 3 objects each with title string, description string one sentence, difficulty Easy or Medium or Hard, timeEstimate string, steps array of 4 strings, disposalTip: string 2 to 3 sentences, funFact: string one surprising fact }`;
const MATERIAL_PROMPT_SUFFIX = `Now break down its material composition. Respond ONLY with a valid JSON object, no markdown or code fences. Schema: { materials: array of 4 to 6 objects each with name string, percentage number 0 to 100, toxic boolean, recoverable boolean }, recoverablePct: number 0 to 100, toxicNote: string one sentence about any toxic or hazardous components. The percentages of materials should sum approximately to 100.`;
const MAX_FILE_SIZE = 4 * 1024 * 1024;
const HISTORY_KEY = 'ecoscan_history';
const STREAK_KEY = 'ecoscan_streak';
const MAX_HISTORY = 50;

let state = {
  selectedSample: null,
  selectedFile: null,
  selectedFileBase64: null,
  selectedFileMime: null,
  scanResult: null,
  materials: null,
  abortController: null,
  loadingTimer: null,
  filter: 'All'
};
let session = { scans: 0, co2: 0 };

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', init);

function init() {
  document.querySelectorAll('.sample-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sample-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.selectedSample = btn.dataset.sample;
      clearImage(false);
      updateScanBtn();
    });
  });

  const dz = $('dropzone');
  dz.addEventListener('click', () => $('fileInput').click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });

  document.querySelectorAll('#filterRow .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterRow .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.diff;
      applyFilter();
    });
  });

  $('confirmModal').addEventListener('click', (e) => {
    if (e.target === $('confirmModal')) closeConfirm();
  });

  updateNavBadge();
  updateStreakDisplay();
  updateScanBtn();
}

function handleFile(file) {
  if (!file.type.startsWith('image/')) { showToast('error', 'Only image files are supported.'); return; }
  if (file.size > MAX_FILE_SIZE) { showToast('error', 'File too large. Max size is 4 MB.'); return; }

  state.selectedFile = file;
  state.selectedFileMime = file.type;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    state.selectedFileBase64 = dataUrl.split(',')[1];
    $('previewImg').src = dataUrl;
    $('previewName').textContent = file.name;
    $('previewMeta').textContent = formatBytes(file.size) + ' · ' + file.type;
    $('preview').classList.add('show');

    document.querySelectorAll('.sample-btn').forEach(b => b.classList.remove('selected'));
    state.selectedSample = null;
    updateScanBtn();
  };
  reader.onerror = () => showToast('error', 'Could not read file.');
  reader.readAsDataURL(file);
}

function clearImage(updateBtn = true) {
  state.selectedFile = null;
  state.selectedFileBase64 = null;
  state.selectedFileMime = null;
  $('preview').classList.remove('show');
  $('fileInput').value = '';
  if (updateBtn) updateScanBtn();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function updateScanBtn() {
  const hasItem = !!state.selectedFile || !!state.selectedSample;
  $('scanBtn').disabled = !hasItem;
}

function showScreen(name) {
  const screens = ['home', 'loading', 'results', 'history', 'map', 'features'];
  screens.forEach(s => {
    const el = $('screen-' + s);
    if (s === name) {
      el.classList.add('active');
      requestAnimationFrame(() => el.classList.add('show'));
    } else {
      el.classList.remove('show');
      setTimeout(() => el.classList.remove('active'), 250);
    }
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === name);
  });
  if (name === 'history') renderHistory();
  if (name === 'map') renderMap();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================
   GEOLOCATION + HEATMAP
   ========================================================= */
const USER_LOC_KEY = 'ecoscan_user_loc';

const COMMUNITY_HOTSPOTS = [
  { city: 'Mumbai',       lat: 19.0760, lng: 72.8777, weight: 95 },
  { city: 'Delhi',        lat: 28.6139, lng: 77.2090, weight: 88 },
  { city: 'Bangalore',    lat: 12.9716, lng: 77.5946, weight: 82 },
  { city: 'New York',     lat: 40.7128, lng: -74.0060, weight: 90 },
  { city: 'Los Angeles',  lat: 34.0522, lng: -118.2437, weight: 78 },
  { city: 'San Francisco',lat: 37.7749, lng: -122.4194, weight: 72 },
  { city: 'London',       lat: 51.5074, lng: -0.1278, weight: 86 },
  { city: 'Berlin',       lat: 52.5200, lng: 13.4050, weight: 70 },
  { city: 'Paris',        lat: 48.8566, lng: 2.3522, weight: 68 },
  { city: 'Amsterdam',    lat: 52.3676, lng: 4.9041, weight: 60 },
  { city: 'Tokyo',        lat: 35.6762, lng: 139.6503, weight: 92 },
  { city: 'Seoul',        lat: 37.5665, lng: 126.9780, weight: 75 },
  { city: 'Shanghai',     lat: 31.2304, lng: 121.4737, weight: 80 },
  { city: 'Singapore',    lat: 1.3521,  lng: 103.8198, weight: 65 },
  { city: 'Sydney',       lat: -33.8688, lng: 151.2093, weight: 64 },
  { city: 'Melbourne',    lat: -37.8136, lng: 144.9631, weight: 50 },
  { city: 'São Paulo',    lat: -23.5505, lng: -46.6333, weight: 73 },
  { city: 'Rio de Janeiro',lat: -22.9068, lng: -43.1729, weight: 58 },
  { city: 'Mexico City',  lat: 19.4326, lng: -99.1332, weight: 62 },
  { city: 'Toronto',      lat: 43.6532, lng: -79.3832, weight: 55 },
  { city: 'Vancouver',    lat: 49.2827, lng: -123.1207, weight: 48 },
  { city: 'Dubai',        lat: 25.2048, lng: 55.2708, weight: 67 },
  { city: 'Cape Town',    lat: -33.9249, lng: 18.4241, weight: 42 },
  { city: 'Lagos',        lat: 6.5244,  lng: 3.3792, weight: 58 },
  { city: 'Nairobi',      lat: -1.2921, lng: 36.8219, weight: 38 },
  { city: 'Istanbul',     lat: 41.0082, lng: 28.9784, weight: 64 },
  { city: 'Stockholm',    lat: 59.3293, lng: 18.0686, weight: 45 },
  { city: 'Madrid',       lat: 40.4168, lng: -3.7038, weight: 52 },
  { city: 'Barcelona',    lat: 41.3851, lng: 2.1734, weight: 48 },
  { city: 'Rome',         lat: 41.9028, lng: 12.4964, weight: 50 },
  { city: 'Bangkok',      lat: 13.7563, lng: 100.5018, weight: 60 },
  { city: 'Jakarta',      lat: -6.2088, lng: 106.8456, weight: 56 }
];

let _map = null;
let _heatLayer = null;
let _userMarker = null;
let _hotspotIdx = 0;

function getUserLoc() {
  try { return JSON.parse(localStorage.getItem(USER_LOC_KEY) || 'null'); }
  catch (_) { return null; }
}
function setUserLoc(loc) {
  localStorage.setItem(USER_LOC_KEY, JSON.stringify(loc));
}

function requestUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
        setUserLoc(loc);
        resolve(loc);
      },
      (_err) => resolve(null),
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

const MAP_GATE_KEY = 'ecoscan_map_gate';

function jitter(seed) {
  // deterministic pseudo-random offset in ~±0.4° (~45km) so coincident scans spread visibly
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return (x - Math.floor(x) - 0.5) * 0.8;
}

function buildHistoryHeatPoints() {
  const history = getHistory();
  const userLoc = getUserLoc();
  const points = [];

  history.forEach((h, idx) => {
    const base = (h.coords && Number.isFinite(h.coords.lat) && Number.isFinite(h.coords.lng))
      ? h.coords
      : userLoc;
    if (!base) return;
    const w = Math.min(1, 0.4 + (Number(h.co2SavedKg) || 1) / 12);
    points.push([
      base.lat + jitter(idx * 2 + 1),
      base.lng + jitter(idx * 2 + 7),
      w
    ]);
  });
  return points;
}

function backfillHistoryCoords(loc) {
  if (!loc) return 0;
  let history = getHistory();
  let changed = 0;
  history = history.map(h => {
    if (!h.coords) { changed++; return { ...h, coords: { lat: loc.lat, lng: loc.lng } }; }
    return h;
  });
  if (changed) localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return changed;
}

function topRegionFromHistory() {
  const history = getHistory();
  if (history.length === 0) return '—';
  const counts = {};
  history.forEach(h => {
    if (h.coords) {
      const key = Math.round(h.coords.lat) + ',' + Math.round(h.coords.lng);
      counts[key] = (counts[key] || 0) + 1;
    }
  });
  const entries = Object.entries(counts);
  if (entries.length === 0) return '—';
  entries.sort((a, b) => b[1] - a[1]);
  const [lat, lng] = entries[0][0].split(',');
  return `${lat}°, ${lng}° · ${entries[0][1]} scans`;
}

function updateMapStats() {
  const history = getHistory();
  const userLoc = getUserLoc();
  $('mapTotal').textContent = history.length;
  const cities = new Set(history.filter(h => h.coords).map(h => Math.round(h.coords.lat * 2) + ',' + Math.round(h.coords.lng * 2)));
  $('mapCities').textContent = cities.size;
  $('mapTop').textContent = topRegionFromHistory();
  $('mapYou').textContent = userLoc ? `${userLoc.lat.toFixed(2)}, ${userLoc.lng.toFixed(2)}` : 'Not set';
}

function showMapGate(show) {
  const gate = $('mapGate');
  const legend = $('mapLegend');
  const pulse = $('mapPulse');
  if (show) {
    gate.classList.remove('hidden');
    legend.style.display = 'none';
    pulse.style.display = 'none';
  } else {
    gate.classList.add('hidden');
    legend.style.display = 'block';
    pulse.style.display = 'inline-flex';
  }
}

function renderMap() {
  updateMapStats();

  const userLoc = getUserLoc();
  const skipped = localStorage.getItem(MAP_GATE_KEY) === 'skipped';

  if (!userLoc && !skipped) {
    showMapGate(true);
    return;
  }
  showMapGate(false);

  if (typeof L === 'undefined') {
    setTimeout(renderMap, 200);
    return;
  }

  if (!_map) {
    _map = L.map('mapCanvas', {
      center: userLoc ? [userLoc.lat, userLoc.lng] : [22, 12],
      zoom: userLoc ? 4 : 2,
      minZoom: 2,
      maxZoom: 8,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(_map);
  } else {
    _map.invalidateSize();
  }

  if (_heatLayer) { _map.removeLayer(_heatLayer); _heatLayer = null; }
  const heatPoints = buildHistoryHeatPoints();
  if (heatPoints.length && typeof L.heatLayer === 'function') {
    _heatLayer = L.heatLayer(heatPoints, {
      radius: 32,
      blur: 24,
      maxZoom: 6,
      max: 1.0,
      gradient: {
        0.0: '#1e40af',
        0.25: '#06b6d4',
        0.45: '#84cc16',
        0.65: '#facc15',
        0.82: '#f97316',
        1.0: '#ef4444'
      }
    }).addTo(_map);
  }

  if (_userMarker) { _map.removeLayer(_userMarker); _userMarker = null; }
  if (userLoc) {
    const icon = L.divIcon({
      className: '',
      html: '<div class="user-pin"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
    _userMarker = L.marker([userLoc.lat, userLoc.lng], { icon })
      .addTo(_map)
      .bindPopup(`<strong>You</strong><br/>${getHistory().length} scans pinned here`);
  }

  // Empty state if no scans
  const existingEmpty = document.querySelector('.map-empty');
  if (existingEmpty) existingEmpty.remove();
  if (heatPoints.length === 0) {
    const shell = document.querySelector('.map-shell');
    const empty = document.createElement('div');
    empty.className = 'map-empty';
    empty.innerHTML = `
      <div class="map-empty-inner">
        <div class="map-empty-title">No scans yet</div>
        <div class="map-empty-sub">Scan your first waste item — it'll appear right here on your personal heatmap.</div>
      </div>`;
    shell.appendChild(empty);
  }
}

function grantMapLocation() {
  showToast('info', 'Requesting location…');
  requestUserLocation().then(loc => {
    if (!loc) {
      showToast('error', 'Location denied or unavailable.');
      return;
    }
    const filled = backfillHistoryCoords(loc);
    if (filled > 0) showToast('success', `Pinned ${filled} past scan${filled === 1 ? '' : 's'} on the map!`);
    else showToast('success', 'Location locked in!');
    localStorage.removeItem(MAP_GATE_KEY);
    renderMap();
    if (_map) _map.flyTo([loc.lat, loc.lng], 5, { duration: 1.6 });
  });
}

function skipMapLocation() {
  localStorage.setItem(MAP_GATE_KEY, 'skipped');
  renderMap();
}

function addMyLocation() { grantMapLocation(); }

function flyToHotspot() {
  if (!_map) return;
  const history = getHistory();
  const withCoords = history.filter(h => h.coords);
  if (withCoords.length === 0) {
    showToast('info', 'Scan some items first to build your map.');
    return;
  }
  const target = withCoords[_hotspotIdx % withCoords.length];
  _hotspotIdx++;
  _map.flyTo([target.coords.lat, target.coords.lng], 6, { duration: 1.6 });
  L.popup({ closeButton: false, autoClose: true })
    .setLatLng([target.coords.lat, target.coords.lng])
    .setContent(`<strong>${escapeHtml(target.itemName)}</strong><br/>${target.wasteType} · ${Number(target.co2SavedKg).toFixed(2)} kg CO₂`)
    .openOn(_map);
}

async function startScan() {
  const hasItem = !!state.selectedFile || !!state.selectedSample;
  if (!hasItem) { showToast('error', 'Pick a sample or upload an image first.'); return; }

  showScreen('loading');
  startLoadingMessages();
  state.abortController = new AbortController();

  try {
    const primaryResult = await callBackend(PRIMARY_PROMPT, state.abortController.signal, false);
    const parsed = parseJsonStrict(primaryResult);
    if (!parsed) {
      stopLoadingMessages();
      showToast('error', 'Could not parse AI response. Try again.');
      showScreen('home');
      return;
    }

    state.scanResult = normalizeResult(parsed);

    try {
      const itemContext = `The waste item just identified is: ${state.scanResult.itemName} (type: ${state.scanResult.wasteType}). ` + MATERIAL_PROMPT_SUFFIX;
      const matResult = await callBackend(itemContext, state.abortController.signal, true);
      const matParsed = parseJsonStrict(matResult);
      if (matParsed) state.materials = normalizeMaterials(matParsed);
    } catch (matErr) {
      console.warn('Material call failed', matErr);
      state.materials = null;
    }

    stopLoadingMessages();
    const cachedLoc = getUserLoc();
    if (!cachedLoc) requestUserLocation();
    if (cachedLoc) state.scanResult.coords = { lat: cachedLoc.lat, lng: cachedLoc.lng };
    saveScan(state.scanResult);
    updateStreak();
    session.scans += 1;
    session.co2 += Number(state.scanResult.co2SavedKg) || 0;
    renderResults(state.scanResult);
    showScreen('results');
  } catch (err) {
    stopLoadingMessages();
    if (err.name === 'AbortError') return;
    showToast('error', err.message || 'Scan failed. Please try again.');
    showScreen('home');
  }
}

function cancelScan() {
  if (state.abortController) state.abortController.abort();
  stopLoadingMessages();
  showScreen('home');
}

async function callBackend(prompt, signal, textOnly = false) {
  let finalPrompt = prompt;
  let imagePayload = null;

  if (!textOnly && state.selectedFileBase64) {
    imagePayload = { mimeType: state.selectedFileMime, data: state.selectedFileBase64 };
  } else if (!textOnly && state.selectedSample) {
    finalPrompt = prompt + ` The item is: ${state.selectedSample}.`;
  }

  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: finalPrompt, image: imagePayload }),
    signal
  });

  if (!res.ok) {
    let msg = 'Server error: ' + res.status;
    try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (!data.text) throw new Error('Empty response from AI.');
  return data.text;
}

function parseJsonStrict(text) {
  try { return JSON.parse(text); } catch (_) {}
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  }
  try { return JSON.parse(cleaned); } catch (_) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

function normalizeResult(r) {
  const validTypes = ['plastic','organic','metal','ewaste','paper','glass','general'];
  const wasteType = validTypes.includes(r.wasteType) ? r.wasteType : 'general';
  const ideas = Array.isArray(r.upcycleIdeas) ? r.upcycleIdeas.slice(0, 3) : [];
  return {
    id: 'scan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    itemName: r.itemName || (state.selectedSample || 'Unknown Item'),
    wasteType,
    recyclable: r.recyclable || 'Partially',
    decomposeTime: r.decomposeTime || 'Unknown',
    co2SavedKg: clampNum(r.co2SavedKg, 0, 200, 1.0),
    confidencePct: clampNum(r.confidencePct, 80, 99, 90),
    upcycleIdeas: ideas.map(i => ({
      title: i.title || 'Upcycle project',
      description: i.description || '',
      difficulty: ['Easy','Medium','Hard'].includes(i.difficulty) ? i.difficulty : 'Medium',
      timeEstimate: i.timeEstimate || '1 hour',
      steps: Array.isArray(i.steps) ? i.steps.slice(0, 4) : []
    })),
    disposalTip: r.disposalTip || 'Check your local recycling guidelines for proper disposal.',
    funFact: r.funFact || 'Recycling reduces global emissions significantly.',
    timestamp: new Date().toISOString()
  };
}

function normalizeMaterials(m) {
  const mats = Array.isArray(m.materials) ? m.materials : [];
  return {
    materials: mats.map(x => ({
      name: x.name || 'Material',
      percentage: clampNum(x.percentage, 0, 100, 0),
      toxic: !!x.toxic,
      recoverable: !!x.recoverable
    })),
    recoverablePct: clampNum(m.recoverablePct, 0, 100, 50),
    toxicNote: m.toxicNote || ''
  };
}

function clampNum(v, min, max, fb) {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return fb;
}

const LOADING_MSGS = [
  'Identifying waste material…',
  'Calculating environmental impact…',
  'Generating upcycle ideas…'
];
function startLoadingMessages() {
  let idx = 0;
  $('loadingMsg').textContent = LOADING_MSGS[0];
  state.loadingTimer = setInterval(() => {
    idx = (idx + 1) % LOADING_MSGS.length;
    const el = $('loadingMsg');
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = LOADING_MSGS[idx]; el.style.opacity = '1'; }, 200);
  }, 1500);
}
function stopLoadingMessages() {
  if (state.loadingTimer) { clearInterval(state.loadingTimer); state.loadingTimer = null; }
}

function renderResults(r) {
  $('resItem').textContent = r.itemName;
  const badge = $('resBadge');
  badge.textContent = r.wasteType;
  badge.className = 'badge badge-' + r.wasteType;

  $('resRecycle').textContent = r.recyclable;
  $('resDecompose').textContent = r.decomposeTime;
  $('resCo2').textContent = (r.co2SavedKg).toFixed(2) + ' kg';
  $('resConf').textContent = r.confidencePct + '%';
  $('resFunFact').textContent = r.funFact;
  $('resDisposal').textContent = r.disposalTip;

  setTimeout(() => {
    const co2Pct = Math.min(100, (r.co2SavedKg / 10) * 100);
    $('resCo2Bar').style.width = co2Pct + '%';
    $('resConfBar').style.width = r.confidencePct + '%';
  }, 100);

  $('sessionScans').textContent = session.scans;
  $('sessionCo2').textContent = session.co2.toFixed(2);

  renderComparison(r);
  renderMaterials();

  state.filter = 'All';
  document.querySelectorAll('#filterRow .filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.diff === 'All');
  });
  renderIdeas(r.upcycleIdeas);
  renderImpactCounters();
}

function renderComparison(r) {
  const history = getHistory();
  const previous = history.filter(h => h.id !== r.id);
  const card = $('compareCard');
  if (previous.length === 0) { card.style.display = 'none'; return; }
  const last = previous[0];
  const diff = r.co2SavedKg - last.co2SavedKg;
  const absDiff = Math.abs(diff).toFixed(2);
  const direction = diff >= 0 ? 'higher' : 'lower';
  const symbol = diff >= 0 ? '↑' : '↓';
  card.className = 'compare-card';
  card.style.display = 'inline-flex';
  card.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
    <span>This is <strong>${absDiff} kg ${direction}</strong> than your last scan (${escapeHtml(last.itemName)})</span>
    <span style="margin-left:6px;">${symbol}</span>
  `;
}

function renderMaterials() {
  const list = $('materialsList');
  const summary = $('materialSummary');
  if (!state.materials) {
    list.innerHTML = `<div style="color:#9ba1ae; font-size:13px;">Material breakdown unavailable for this scan.</div>`;
    summary.style.display = 'none';
    return;
  }
  const mats = state.materials.materials;
  const colors = ['#34d399', '#60a5fa', '#a78bfa', '#fbbf24', '#f472b6', '#5eead4'];
  list.innerHTML = mats.map((m, i) => {
    const color = colors[i % colors.length];
    const tags = [];
    if (m.toxic) tags.push('<span class="material-tag">⚠ Toxic</span>');
    if (m.recoverable) tags.push('<span class="material-tag recover">♻ Recoverable</span>');
    return `
      <div class="material-item">
        <div class="material-name">${escapeHtml(m.name)} ${tags.join('')}</div>
        <div class="material-bar-wrap"><div class="material-bar" style="background:${color}; width:0%;" data-pct="${m.percentage}"></div></div>
        <div class="material-pct">${m.percentage.toFixed(0)}%</div>
      </div>
    `;
  }).join('');

  setTimeout(() => {
    list.querySelectorAll('.material-bar').forEach(bar => {
      bar.style.width = bar.dataset.pct + '%';
    });
  }, 150);

  if (state.materials.toxicNote || state.materials.recoverablePct) {
    summary.style.display = 'block';
    summary.innerHTML = `
      <div><strong>${state.materials.recoverablePct}%</strong> of this item is recoverable through proper recycling.</div>
      ${state.materials.toxicNote ? `<div style="margin-top:6px;">${escapeHtml(state.materials.toxicNote)}</div>` : ''}
    `;
  } else {
    summary.style.display = 'none';
  }
}

function renderIdeas(ideas) {
  const grid = $('ideasGrid');
  grid.innerHTML = ideas.map((idea, idx) => `
    <div class="idea-card" data-diff="${idea.difficulty}">
      <div class="idea-title">${escapeHtml(idea.title)}</div>
      <div class="idea-desc">${escapeHtml(idea.description)}</div>
      <div class="idea-meta">
        <span class="diff-badge diff-${idea.difficulty}">${idea.difficulty}</span>
        <span class="time-est">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          ${escapeHtml(idea.timeEstimate)}
        </span>
      </div>
      <button class="steps-toggle" onclick="toggleSteps(${idx}, this)">
        See Steps
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="steps-list" id="steps-${idx}">
        <ol>${idea.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
      </div>
    </div>
  `).join('');
}

function toggleSteps(idx, btn) {
  const list = $('steps-' + idx);
  const isOpen = list.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  btn.firstChild.textContent = isOpen ? 'Hide Steps ' : 'See Steps ';
}

function applyFilter() {
  document.querySelectorAll('.idea-card').forEach(card => {
    if (state.filter === 'All' || card.dataset.diff === state.filter) card.classList.remove('hidden');
    else card.classList.add('hidden');
  });
}

function renderImpactCounters() {
  const history = getHistory();
  const today = new Date().toDateString();
  const todayCount = history.filter(h => new Date(h.timestamp).toDateString() === today).length;
  const totalCo2 = history.reduce((s, h) => s + (Number(h.co2SavedKg) || 0), 0);
  $('todayScans').textContent = todayCount;
  $('totalCo2').innerHTML = `<span>${totalCo2.toFixed(2)}</span> kg`;
}

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveScan(r) {
  const entry = {
    id: r.id, itemName: r.itemName, wasteType: r.wasteType,
    recyclable: r.recyclable, decomposeTime: r.decomposeTime,
    co2SavedKg: r.co2SavedKg, confidencePct: r.confidencePct,
    disposalTip: r.disposalTip, funFact: r.funFact,
    upcycleIdeas: r.upcycleIdeas, timestamp: r.timestamp,
    coords: r.coords || null
  };
  let history = getHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  updateNavBadge();
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  updateNavBadge();
  renderHistory();
  showToast('success', 'History cleared.');
}

function updateNavBadge() {
  const count = getHistory().length;
  const badge = $('historyBadge');
  if (count > 0) { badge.textContent = count; badge.style.display = 'inline-block'; }
  else badge.style.display = 'none';
}

function updateStreak() {
  const today = new Date().toDateString();
  let streak;
  try { streak = JSON.parse(localStorage.getItem(STREAK_KEY) || '{}'); } catch (_) { streak = {}; }

  if (streak.lastDate === today) {
    // already counted today
  } else if (streak.lastDate) {
    const lastD = new Date(streak.lastDate);
    const diffDays = Math.round((new Date(today) - lastD) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) streak.count = (streak.count || 0) + 1;
    else streak.count = 1;
  } else {
    streak.count = 1;
  }
  streak.lastDate = today;
  localStorage.setItem(STREAK_KEY, JSON.stringify(streak));
  updateStreakDisplay();
}

function updateStreakDisplay() {
  let streak;
  try { streak = JSON.parse(localStorage.getItem(STREAK_KEY) || '{}'); } catch (_) { streak = {}; }
  const today = new Date().toDateString();
  let count = streak.count || 0;
  if (streak.lastDate) {
    const diffDays = Math.round((new Date(today) - new Date(streak.lastDate)) / (1000 * 60 * 60 * 24));
    if (diffDays > 1) count = 0;
  }
  if (count > 0) {
    $('streakPill').style.display = 'inline-flex';
    $('streakText').textContent = count + ' day streak';
  } else {
    $('streakPill').style.display = 'none';
  }
}

function renderHistory() {
  const list = $('historyList');
  const history = getHistory();

  $('histTotal').textContent = history.length;
  const totalCo2 = history.reduce((s, h) => s + (Number(h.co2SavedKg) || 0), 0);
  $('histCo2').textContent = totalCo2.toFixed(2) + ' kg';

  let streak;
  try { streak = JSON.parse(localStorage.getItem(STREAK_KEY) || '{}'); } catch (_) { streak = {}; }
  const today = new Date().toDateString();
  let count = streak.count || 0;
  if (streak.lastDate) {
    const diffDays = Math.round((new Date(today) - new Date(streak.lastDate)) / (1000 * 60 * 60 * 24));
    if (diffDays > 1) count = 0;
  }
  $('histStreak').textContent = count + ' day' + (count === 1 ? '' : 's');

  if (history.length === 0) {
    $('leaderboardSection').style.display = 'none';
    list.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>
        <div class="empty-state-title">No scans yet</div>
        <div>Scan your first waste item to start tracking your impact.</div>
      </div>
    `;
    return;
  }

  const top5 = [...history].sort((a, b) => b.co2SavedKg - a.co2SavedKg).slice(0, 5);
  $('leaderboardSection').style.display = 'block';
  $('lbList').innerHTML = top5.map((h, i) => `
    <div class="lb-item">
      <div class="lb-rank r${i+1 <= 3 ? i+1 : ''}">${i + 1}</div>
      <div class="lb-name">${escapeHtml(h.itemName)} <span class="badge badge-${h.wasteType}" style="margin-left:6px;">${h.wasteType}</span></div>
      <div class="lb-co2">${(h.co2SavedKg).toFixed(2)} kg</div>
    </div>
  `).join('');

  list.innerHTML = `
    <div class="history-list">
      ${history.map(h => `
        <div class="history-item">
          <div class="history-info">
            <div class="history-name">${escapeHtml(h.itemName)} <span class="badge badge-${h.wasteType}" style="margin-left:6px;">${h.wasteType}</span></div>
            <div class="history-meta">${formatDate(h.timestamp)}</div>
          </div>
          <div class="history-co2">
            <div class="history-co2-val">${(h.co2SavedKg).toFixed(2)} kg</div>
            <div class="history-co2-lbl">CO₂ saved</div>
          </div>
        </div>
      `).join('')}
    </div>
    <button class="clear-btn" onclick="confirmClear()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      Clear History
    </button>
  `;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (_) { return iso; }
}

function shareResult() {
  const r = state.scanResult;
  if (!r) return;
  const topIdea = r.upcycleIdeas[0]?.title || 'creative reuse';
  const msg = `I just scanned a ${r.itemName} with EcoScan. Recycling it saves ${r.co2SavedKg.toFixed(2)} kg CO2. Top upcycle idea: ${topIdea}. Try EcoScan!`;
  copyToClipboard(msg).then(ok => {
    if (ok) showToast('success', 'Copied to clipboard!');
    else showToast('error', 'Could not copy. Please try again.');
  });
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

function downloadReport() {
  const r = state.scanResult;
  if (!r) return;
  const lines = [];
  lines.push('================================================');
  lines.push('       ECOSCAN — WASTE ANALYSIS REPORT');
  lines.push('================================================');
  lines.push('');
  lines.push('Item:           ' + r.itemName);
  lines.push('Waste Type:     ' + r.wasteType);
  lines.push('Recyclable:     ' + r.recyclable);
  lines.push('Decompose Time: ' + r.decomposeTime);
  lines.push('CO2 Saved:      ' + r.co2SavedKg.toFixed(2) + ' kg');
  lines.push('Confidence:     ' + r.confidencePct + '%');
  lines.push('Date of Scan:   ' + formatDate(r.timestamp));
  lines.push('');
  lines.push('------------------------------------------------');
  lines.push('FUN FACT');
  lines.push('------------------------------------------------');
  lines.push(r.funFact);
  lines.push('');
  lines.push('------------------------------------------------');
  lines.push('DISPOSAL GUIDE');
  lines.push('------------------------------------------------');
  lines.push(r.disposalTip);
  lines.push('');
  lines.push('------------------------------------------------');
  lines.push('UPCYCLE IDEAS');
  lines.push('------------------------------------------------');
  r.upcycleIdeas.forEach((idea, i) => {
    lines.push('');
    lines.push((i + 1) + '. ' + idea.title + '  [' + idea.difficulty + ' · ' + idea.timeEstimate + ']');
    lines.push('   ' + idea.description);
    lines.push('   Steps:');
    idea.steps.forEach((s, si) => { lines.push('     ' + (si + 1) + '. ' + s); });
  });
  if (state.materials) {
    lines.push('');
    lines.push('------------------------------------------------');
    lines.push('MATERIAL COMPOSITION');
    lines.push('------------------------------------------------');
    state.materials.materials.forEach(m => {
      const tags = [];
      if (m.toxic) tags.push('toxic');
      if (m.recoverable) tags.push('recoverable');
      lines.push('  - ' + m.name + ': ' + m.percentage.toFixed(0) + '%' + (tags.length ? ' (' + tags.join(', ') + ')' : ''));
    });
    lines.push('');
    lines.push('  Recoverable: ' + state.materials.recoverablePct + '%');
    if (state.materials.toxicNote) lines.push('  Note: ' + state.materials.toxicNote);
  }
  lines.push('');
  lines.push('================================================');
  lines.push('Generated by EcoScan · AI Waste Scanner');
  lines.push('================================================');

  const text = lines.join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ecoscan-report-' + r.itemName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('success', 'Report downloaded.');
}

function openMap() {
  const r = state.scanResult;
  if (!r) return;
  const typeMap = {
    plastic: 'plastic recycling center',
    organic: 'compost drop-off',
    metal: 'metal recycling center',
    ewaste: 'ewaste collection',
    paper: 'paper recycling center',
    glass: 'glass recycling center',
    general: 'recycling center'
  };
  const query = typeMap[r.wasteType] || 'recycling center';
  const url = 'https://www.google.com/maps/search/' + encodeURIComponent(query + ' near me');
  window.open(url, '_blank', 'noopener,noreferrer');
}

function confirmClear() {
  $('confirmTitle').textContent = 'Clear all history?';
  $('confirmText').textContent = 'This will permanently delete all your scan history. This cannot be undone.';
  $('confirmYes').textContent = 'Clear History';
  $('confirmYes').onclick = () => { closeConfirm(); clearHistory(); };
  $('confirmModal').classList.add('show');
}
function closeConfirm() { $('confirmModal').classList.remove('show'); }

function showToast(type, message) {
  const c = $('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const icons = {
    error: '<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    success: '<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    info: '<svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  t.innerHTML = (icons[type] || icons.info) + '<div class="toast-text">' + escapeHtml(message) + '</div>';
  c.appendChild(t);
  setTimeout(() => {
    t.classList.add('fadeout');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
}
