require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.2-90b-vision-instruct';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

if (!NVIDIA_API_KEY) {
  console.error('FATAL: NVIDIA_API_KEY missing from .env');
  process.exit(1);
}

function buildMessages(prompt, image) {
  if (image && image.data && image.mimeType) {
    return [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }
        ]
      }
    ];
  }
  return [{ role: 'user', content: prompt }];
}

async function callNvidia(prompt, image) {
  const messages = buildMessages(prompt, image);
  const r = await fetch(NVIDIA_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages,
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 4096,
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

  const MAX_ATTEMPTS = 2;
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callNvidia(prompt, image);
      return res.json({ text });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(rs => setTimeout(rs, 2000));
      }
    }
  }

  res.status(502).json({ error: lastErr?.message || 'AI request failed. Please try again.' });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: NVIDIA_MODEL }));

app.listen(PORT, () => {
  console.log(`EcoScan running at http://localhost:${PORT}`);
});
