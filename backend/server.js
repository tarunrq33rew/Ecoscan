require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'google/gemma-4-31b-it';

if (!GEMINI_API_KEY) {
  console.error('FATAL: GEMINI_API_KEY missing from .env');
  process.exit(1);
}

async function callNvidia(prompt) {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not configured.');
  const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 2048,
      stream: false
    })
  });
  if (!r.ok) {
    let msg = `NVIDIA error ${r.status}`;
    try { const j = await r.json(); msg = j.error?.message || j.detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from NVIDIA.');
  return text;
}

app.use(express.json({ limit: '8mb' }));

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

app.post('/api/gemini', async (req, res) => {
  const { prompt, image } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing prompt.' });
  }

  const parts = [{ text: prompt }];
  if (image && image.data && image.mimeType) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json'
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [1500, 4000];

  try {
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (r.ok) {
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) return res.status(502).json({ error: 'Empty response from AI.' });
        return res.json({ text });
      }

      let msg = `Gemini error ${r.status}`;
      try { const j = await r.json(); msg = j.error?.message || msg; } catch (_) {}
      lastErr = { status: r.status, msg };

      if (r.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        await new Promise(rs => setTimeout(rs, BACKOFF_MS[attempt]));
        continue;
      }
      if (r.status === 429) {
        if (!image && NVIDIA_API_KEY) {
          console.warn('[fallback] Gemini 429 -> NVIDIA NIM');
          try {
            const text = await callNvidia(prompt);
            return res.json({ text });
          } catch (nvErr) {
            console.warn('[fallback] NVIDIA also failed:', nvErr.message);
            return res.status(429).json({ error: 'Both Gemini and NVIDIA failed. Please wait and try again.' });
          }
        }
        return res.status(429).json({ error: 'Rate limit reached. Please wait ~30 seconds and try again.' });
      }
      return res.status(r.status).json({ error: msg });
    }
    return res.status(lastErr?.status || 500).json({ error: lastErr?.msg || 'Request failed.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upstream request failed.' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: GEMINI_MODEL }));

app.listen(PORT, () => {
  console.log(`EcoScan running at http://localhost:${PORT}`);
});
