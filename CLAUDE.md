# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm install        # install dependencies (run once after cloning)
npm start          # launch the Electron app
npm run dev        # launch with Node inspector attached (port 9229)
```

There are no tests or linting scripts configured.

## Architecture

TicketScribe is an Electron app with a strict two-process split enforced by Electron's security model.

**Main process (`main.js`)** — Node.js, runs with full OS access. Hosts three IPC handlers:
- `get-sources` — calls `desktopCapturer.getSources()` (unavailable in renderer since Electron 20) and returns serialised source objects
- `save-summary` — writes confirmed `.txt` notes to `Documents/TicketScribe/`
- `open-folder` — opens that folder in Explorer via `shell.openPath`

**Renderer process (`renderer/`)** — Chromium, runs with `nodeIntegration: true` / `contextIsolation: false` so it can `require()` Node modules directly. All application logic lives here:

1. **Capture** (`startCapture` / `captureFrame`) — calls `ipcRenderer.invoke('get-sources')` to get the source ID, then `navigator.mediaDevices.getUserMedia` with `chromeMediaSource: 'desktop'`. A `setInterval` at 1 500 ms draws the live `<video>` to a canvas.

2. **Frame deduplication** (`aHash` / `hamming`) — pure-JS average perceptual hash over an 8×8 `OffscreenCanvas` downscale. A frame is only kept as a keyframe when its Hamming distance from the previous kept frame exceeds the configured threshold (default 5 bits out of 64).

3. **OCR** (`runOCR`) — a single `tesseract.js` worker (`createWorker('eng')`) is created lazily on first use and reused across all keyframes. The worker is warmed up in the background immediately after recording starts.

4. **VLM analysis** (`describeFrame`) — sends each keyframe as a base64 JPEG (stripped of the `data:…,` prefix) to `POST /api/generate` on the local Ollama server with the OCR text injected into the prompt. Falls back to OCR text if Ollama is unreachable.

5. **Summarisation** (`generateSummary`) — a second Ollama call with the text model only; receives the ordered timestamped descriptions and returns a 3–5 sentence professional work note.

6. **State machine** (`setState`) — five linear states: `idle → recording → processing → review → done → idle`. `document.body.dataset.state` drives CSS visibility; each state maps to a `#view-<state>` `<div>`.

**Settings** are persisted to `localStorage` (Ollama URL, VLM model name, text model name, hash threshold). Defaults: `llava` for vision, `llama3` for text, `http://localhost:11434`.

## Key constraints

- `desktopCapturer` must always be called from the main process via the `get-sources` IPC channel.
- `getUserMedia` constraints for desktop capture must use the `mandatory: {}` wrapper — top-level constraints silently fall back to webcam.
- The base64 image sent to Ollama must have the `data:image/…;base64,` prefix stripped: `dataUrl.split(',')[1]`.
- Keyframe `canvas` elements are kept in memory for the OCR pass; clear `keyframes = []` after the pipeline completes or on discard to avoid unbounded memory use.
- Summaries are saved to `%USERPROFILE%\Documents\TicketScribe\ticket-<id>-<timestamp>.txt`. No data is sent outside the local machine.
