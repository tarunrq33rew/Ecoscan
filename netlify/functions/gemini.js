const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'google/gemma-4-31b-it';

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

exports.handler = async (event, context) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!GEMINI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured on server.' }) };
  }

  let bodyData;
  try {
    bodyData = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { prompt, image } = bodyData;
  if (!prompt || typeof prompt !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing prompt.' }) };
  }

  const parts = [{ text: prompt }];
  if (image && image.data && image.mimeType) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }

  const geminiPayload = {
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
        body: JSON.stringify(geminiPayload)
      });

      if (r.ok) {
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) return { statusCode: 502, body: JSON.stringify({ error: 'Empty response from AI.' }) };
        return { statusCode: 200, body: JSON.stringify({ text }) };
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
          try {
            const text = await callNvidia(prompt);
            return { statusCode: 200, body: JSON.stringify({ text }) };
          } catch (nvErr) {
            return { statusCode: 429, body: JSON.stringify({ error: 'Both Gemini and NVIDIA failed.' }) };
          }
        }
        return { statusCode: 429, body: JSON.stringify({ error: 'Rate limit reached.' }) };
      }
      return { statusCode: r.status, body: JSON.stringify({ error: msg }) };
    }
    return { statusCode: lastErr?.status || 500, body: JSON.stringify({ error: lastErr?.msg || 'Request failed.' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Function execution failed.' }) };
  }
};
