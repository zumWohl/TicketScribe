# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm install          # install dependencies (run once after cloning)
npm run rebuild       # rebuild better-sqlite3 for Electron's Node ABI (one-time, needed for browser-history capture)
npm start             # launch the Electron app
npm run dev           # launch with Node inspector attached (port 9229)
```

There are no tests or linting scripts configured.

## Architecture

TicketScribe is an Electron app with a strict two-process split enforced by Electron's security model.

**Main process** — Node.js, runs with full OS access.
- `main.js` hosts the original three IPC handlers (`get-sources`, `save-summary`, `open-folder`) plus three new ones: `events:start`, `events:stop`, `events:get-transcript-snippet` (see below).
- `main/events-capture.js` — OS-level "activity" telemetry, captured alongside video. Built for an IT support engineer's workflow (RDP/remote tools, admin portals, the PSA) rather than a developer's — there is no git integration anywhere in this codebase, intentionally.

**Renderer process (`renderer/`)** — Chromium, runs with `nodeIntegration: true` / `contextIsolation: false` so it can `require()` Node modules directly. All application logic lives here:

1. **Capture** (`startCapture` / `captureFrame`) — calls `ipcRenderer.invoke('get-sources')` to get the source ID, then `navigator.mediaDevices.getUserMedia` with `chromeMediaSource: 'desktop'`. A `setInterval` at 1500ms draws the live `<video>` to a canvas.

2. **Frame deduplication** (`aHash` / `hamming`) — pure-JS average perceptual hash over an 8×8 `OffscreenCanvas` downscale. A frame is only kept as a keyframe when its Hamming distance from the previous kept frame exceeds the configured threshold (default 5 bits out of 64).

3. **OCR** (`runOCR`) — a single `tesseract.js` worker (`createWorker('eng')`) is created lazily on first use and reused across all keyframes.

4. **Summary generation** (`renderer/providers.js`) — provider-dispatched via `processPipeline()` in `app.js`. **Ollama stays the default** (unchanged two-step shape: per-frame VLM description via `describeFrame`, then a text-summary call via `generateSummary`). **Claude is an optional, user-selected alternative** (`summaryModel` setting) that does both in a single Anthropic Messages API call — every keyframe image plus its OCR caption, followed by the activity timeline (see below) and the work-note instruction. **Both providers throw on failure — nothing silently falls back to a raw OCR dump presented as a finished summary.** On failure the UI shows an actionable error (for Ollama: told to start Ollama / pull the configured models) and a separately-labeled "Use raw OCR text instead" button that the user must click explicitly — see `showGenerationFailure()` in `app.js`. This exists specifically because the old silent-fallback behavior was the root cause of summaries reading like a fake template.
   - `describeFrame()` sends `think: false` to Ollama. Reasoning-capable vision models (e.g. `qwen3-vl`) can otherwise spend most of a call generating a hidden chain-of-thought before this short, factual description — there's little for reasoning to do on a "describe this screenshot" task, and it was observed to turn a ~2s call into minutes.
   - All three prompts (`describeFrame`, `buildTimelinePrompt` for Ollama, and Claude's inline instruction) explicitly tell the model to describe only what's directly evidenced (no inferring problems/causes/intentions), omit incidental UI noise (notifications, prompts, mentions of the recording tool itself), and never repeat credentials verbatim — added after real-world testing showed the model fabricating a "troubleshooting" narrative from incidental on-screen text and echoing a password's presence.

5. **Event-stream capture** (`main/events-capture.js`, orchestrated from `app.js`'s start/stop recording handlers) — three sources, merged into one timestamp-sorted array and rendered as an "Activity timeline" appended to the summary prompt:
   - **Window/app-focus activity (primary source)** — a long-lived PowerShell child process polls the foreground window (`GetForegroundWindow`/`GetWindowText`/owning process, ~1500ms) via a `user32.dll` P/Invoke snippet. Focus-change events carry `durationMs` (dwell time, accumulated across repeated samples of the same window) and a coarse `category` (`remote`/`admin-console`/`psa`/`terminal`/`other`) from a small lookup table in `classifyWindow()`.
   - **Terminal commands** — PowerShell only, via a PSReadLine history-file line-count diff (`snapshotPsHistory`/`diffPsHistory`). An **opt-in** PowerShell transcript mode (`Start-Transcript`) captures command *output* too, but requires the user to paste a one-time snippet into their `$PROFILE` (`getTranscriptProfileSnippet()`, exposed via a "Copy setup snippet" Settings button) — TicketScribe cannot force an already-open shell to start transcribing itself. **cmd.exe command text is not captured** (no reliable way to read another process's console history buffer without a native console-attach helper); cmd.exe sessions are still visible via the window-activity source (category `terminal`, with dwell time), just without the actual commands typed.
   - **Browser activity (Chrome/Edge)** — copies the locked `History` SQLite file to a temp path, queries `visits`/`urls` for the recording window, classifies each visit (`admin-portal`/`psa`/`kb-docs`/`other`). Requires the native `better-sqlite3` module, rebuilt for Electron's ABI via `npm run rebuild` — wrapped in a `try/catch` at require time in `events-capture.js` so a missing/unbuilt module makes browser-history capture silently no-op rather than crashing the app.
   - **Scrubbing** (`renderer/scrub-timeline.js`) — masks GUID-shaped tenant/object IDs, email addresses, password/username/secret assignments (`password: ...`, `username: ...`), API-key-like tokens, and a user-configured list of client names (`scrubClientNames` setting). Applied in two places: `scrubEvents()` on every activity-timeline event's free-text fields before either provider sees the timeline, and directly on `keyframes[i].ocrText` in `app.js`, **immediately after OCR runs** — scrubbing at that single source point means the VLM's OCR context, the raw-OCR fallback text, and Claude's per-frame captions are all automatically scrubbed without needing separate call sites. Text-only: a screenshot's raw pixels aren't touched (see Key constraints).

6. **State machine** (`setState`) — five linear states: `idle → recording → processing → review → done → idle`. `document.body.dataset.state` drives CSS visibility; each state maps to a `#view-<state>` `<div>`.

**Settings** are persisted to `localStorage`: the original Ollama fields (URL, VLM model, text model, hash threshold) plus `summaryModel` (`ollama` default), `anthropicApiKey`, three capture toggles (`captureWindow`, `captureTerminal`, `captureBrowser` — all default `true`), `transcriptEnabled` (default `false`), and `scrubClientNames`.

## Key constraints

- `desktopCapturer` must always be called from the main process via the `get-sources` IPC channel.
- `getUserMedia` constraints for desktop capture must use the `mandatory: {}` wrapper — top-level constraints silently fall back to webcam.
- The base64 image sent to Ollama/Claude must have the `data:image/…;base64,` prefix stripped: `dataUrl.split(',')[1]`.
- **Never silently substitute raw OCR text for a real summary.** Both providers in `renderer/providers.js` must throw on failure; `app.js`'s `showGenerationFailure()` is the only path that surfaces OCR text, and only via an explicit user click.
- **Don't re-add an "include account names/important text" instruction to `describeFrame`'s prompt.** That line was deliberately removed (and explicit anti-fabrication/anti-clutter/anti-credential-echo instructions added to all three model prompts) after a real test showed the VLM echoing "password configuration entries" into the final summary and inventing an unrelated "troubleshooting" narrative from incidental on-screen text.
- **Always scrub OCR text before it reaches a model.** `keyframes[i].ocrText` must be passed through `scrubText()` (`renderer/scrub-timeline.js`) immediately after `runOCR()` returns, in `app.js` — not just at the activity-timeline layer. This is the only thing standing between a credential typed on screen and it reaching the VLM/summarizer as literal text.
- Keyframe `canvas` elements are kept in memory for the OCR pass; clear `keyframes = []` after the pipeline completes or on discard to avoid unbounded memory use.
- PSReadLine history has no per-command timestamp — diffed terminal lines are bucketed at the recording's start time, not sequenced precisely against window/video events.
- Commands run *inside* an RDP or other remote session are invisible to local capture; only that the remote-session window was focused (and for how long) is visible, via the window-activity source.
- `main/events-capture.js`'s `require('better-sqlite3')` is wrapped in `try/catch` — do not remove that guard, since the module needs a one-time `npm run rebuild` that not every environment will have run.
- Summaries are saved to `%USERPROFILE%\Documents\TicketScribe\ticket-<id>-<timestamp>.txt`. Image data still leaves the device when Claude is selected as the summary model; scrubbing (both layers above) only ever touches text, never screenshot pixels. If a credential is visible on screen, Ollama's exposure is contained to the local machine, but a raw Claude call still sends that frame's actual pixels to Anthropic regardless of any text scrubbing.
