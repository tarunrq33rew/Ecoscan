/**
 * EcoScan — AI backend function
 * Primary provider: NVIDIA NIM (google/gemma-4-31b-it)
 * Endpoint called from frontend as /api/gemini
 */

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'google/gemma-4-31b-it';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * Build the user message content.
 * NVIDIA NIM supports multimodal messages via the OpenAI-compatible vision format.
 * Images are passed as base64 data URLs inside a content array.
 */
function buildMessages(prompt, image) {
  if (image && image.data && image.mimeType) {
    // Vision-capable models accept content arrays with text + image_url parts
    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${image.mimeType};base64,${image.data}`
            }
          }
        ]
      }
    ];
  }
  return [{ role: 'user', content: prompt }];
}

async function callNvidia(prompt, image) {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not configured on server.');

  const messages = buildMessages(prompt, image);

  const response = await fetch(NVIDIA_URL, {
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
      stream: false,
      // Enable extended thinking for Gemma 4 if supported
      chat_template_kwargs: { enable_thinking: false }
    })
  });

  if (!response.ok) {
    let msg = `NVIDIA API error ${response.status}`;
    try {
      const j = await response.json();
      msg = j.error?.message || j.detail || msg;
    } catch (_) {}
    throw new Error(msg);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Empty response from NVIDIA AI.');
  return text;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  if (!NVIDIA_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'AI service not configured. Please contact support.' })
    };
  }

  let bodyData;
  try {
    bodyData = JSON.parse(event.body);
  } catch (_) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

  const { prompt, image } = bodyData;
  if (!prompt || typeof prompt !== 'string') {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing or invalid prompt.' })
    };
  }

  // Retry logic: up to 2 attempts with a short back-off
  const MAX_ATTEMPTS = 2;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callNvidia(prompt, image);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ text })
      };
    } catch (err) {
      lastError = err;
      // Back off 2 s before retry
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({ error: lastError?.message || 'AI request failed. Please try again.' })
  };
};
