# EcoScan — AI Waste Scanner & Upcycler

AI-powered waste analyzer that identifies items, computes environmental impact, and suggests upcycle projects via Google Gemini.

## Project structure

```
ECOSCAN/
├── backend/
│   ├── server.js        Express server, proxies Gemini API
│   ├── package.json
│   ├── .env             GEMINI_API_KEY lives here (gitignored)
│   └── .env.example
├── frontend/
│   ├── index.html       Markup only
│   ├── styles.css       All styles
│   └── app.js           App logic; calls /api/gemini
├── .gitignore
└── README.md
```

The frontend never sees the Gemini API key. Browser → `POST /api/gemini` → backend reads `GEMINI_API_KEY` from `.env` → Gemini.

## Setup

```bash
cd backend
npm install
npm start
```

Visit `http://localhost:3000`.

The `.env` file is pre-populated with the provided API key. To use a different key, edit `backend/.env`.

## Endpoints

- `GET /` — frontend
- `POST /api/gemini` — body `{ prompt: string, image?: { mimeType, data(base64) } }` → `{ text }`
- `GET /api/health` — `{ ok: true, model }`

## Requirements

Node.js 18+ (for built-in `fetch`).
