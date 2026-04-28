# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Single-file static web app. The entire application — HTML, CSS, and vanilla JS — lives in [ECOSCAN/ecoscan.html](ECOSCAN/ecoscan.html) (~1995 lines). No build system, no `package.json`, no tests, no lint config, no README.

EcoScan is an AI waste scanner that takes a photo of an item and uses the Google Gemini API to identify it, classify the waste type, suggest upcycling ideas, and break down material composition.

## Run / develop

There is no build step. Either:
- Open `ECOSCAN/ecoscan.html` directly in a browser, or
- Serve the folder: `python -m http.server` from `ECOSCAN/`, then visit `http://localhost:8000/ecoscan.html`.

No tests, no linter — verification is manual in the browser.

## Architecture

The single file is split into three logical sections:
1. CSS (top of `<style>`)
2. HTML markup (the `<body>`)
3. `<script>` block starting around [line 1110](ECOSCAN/ecoscan.html:1110)

### Screen-based SPA
`showScreen(name)` ([ecoscan.html:1279](ECOSCAN/ecoscan.html:1279)) toggles among `home`, `loading`, `results`, `history` by adding/removing `.active` / `.show` classes on `#screen-*` elements. Only one screen is visible at a time.

### Gemini integration
- `callGemini()` ([ecoscan.html:1361](ECOSCAN/ecoscan.html:1361)) POSTs to `gemini-1.5-flash` `:generateContent`. The model and URL builder are constants at the top of the script (`GEMINI_MODEL`, `GEMINI_URL`).
- Two-stage prompting: `PRIMARY_PROMPT` identifies the item / waste type / upcycle ideas; a follow-up using `MATERIAL_PROMPT_SUFFIX` asks for material composition.
- Responses are parsed with `parseJsonStrict()` (strips code fences, extracts the first `{...}` block) and sanitized via `normalizeResult()` / `normalizeMaterials()` / `clampNum()` before rendering. Treat model output as untrusted — do not bypass these normalizers.

### State & persistence
- In-memory `state` object holds `selectedFile`, `selectedSample`, `scanResult`, `abortController`.
- `sessionStorage` key `ecoscan_key` (`SESSION_KEY`) caches the user's API key for the session.
- `localStorage` keys `ecoscan_history` (`HISTORY_KEY`, capped at `MAX_HISTORY = 50`) and `ecoscan_streak` (`STREAK_KEY`).

### Image input
File picker + drag-and-drop into `#dropzone`. Hard limit `MAX_FILE_SIZE = 4 * 1024 * 1024` (4 MB). Image is read as a data URL (base64) and sent inline to Gemini in the `inlineData` part.

## Security note

A `DEFAULT_API_KEY` for Gemini is hardcoded in the source around [line 1125](ECOSCAN/ecoscan.html:1125) and ships to the browser as plain text. Any change touching API key handling, deployment, or auth flow should be aware this key is publicly exposed by design of the current implementation.
