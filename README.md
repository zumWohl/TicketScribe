# Cardonet Capture

> Package name: `ticketscribe` · Product/UI name: **Cardonet Capture**

An Electron desktop app for MSP support technicians. It records your screen while
you fix an issue, **automatically detects and redacts sensitive on-screen data**
(passwords, API keys, tokens, emails, tenant IDs, client names), lets you review
and adjust the redactions frame-by-frame, then turns the recording into a
**ticket-ready work note** — locally with Ollama, or with Claude.

Nothing leaves your machine unless you explicitly choose a cloud model, and even
then redacted regions are destroyed in the pixels *before* anything is sent.

---

## Requirements

- **Node.js** (18+) and **npm**
- **Windows** — activity capture uses PowerShell + Win32 APIs, and API keys are
  stored via the OS. The core record → redact → summarize flow is cross-platform,
  but the activity-timeline features are Windows-specific.
- A summary model (pick one):
  - **[Ollama](https://ollama.com)** running locally (default, fully on-device) — pull a
    vision model and a text model (e.g. `ollama pull llava` and `ollama pull llama3`).
  - **An Anthropic API key** for Claude (optional cloud alternative).

## Install & run

```bash
npm install          # install dependencies (run once)
npm run rebuild      # rebuild better-sqlite3 for Electron's ABI (needed for browser-history capture)
npm start            # launch the app
```

Other scripts:

```bash
npm run dev          # launch with the Node inspector attached (port 9229)
npm test             # pixel-level verification that redaction masking is destructive
```

> `npm run rebuild` is only required for the optional browser-history activity
> source. If you skip it, the app still runs — browser capture just no-ops.

## How it works

The workflow is a three-step flow: **Record → Review & redact → Summary**.

1. **Record.** Choose a capture source — a single window, or an entire screen
   (with a display picker when multiple monitors are connected). A keyframe is
   captured ~every 1.5s; near-identical frames are dropped via a perceptual hash,
   so only frames that actually changed are kept. There's no frame cap; past
   30 minutes you get a dismissable "long recording" heads-up (recording keeps
   going).
2. **Review & redact.** Every keyframe is OCR'd (Tesseract) and scanned for
   sensitive values, which are pre-masked (pink boxes). You can draw new masks,
   drag/resize/delete any box, zoom/pan to verify small text, and drop whole
   frames. The preview always shows the **masked** render.
3. **Summary.** The kept frames are sent to your chosen model and returned as a
   bullet-point work note. The note is written in impersonal passive past tense —
   no names, no dates/times, no verbatim credentials — and is saved to
   `Documents/TicketScribe/`.

### Sensitive-data redaction (security-critical)

- Auto-detection flags passwords, usernames, API keys/tokens, GUID tenant IDs,
  emails, and configured client names — including labelled values split across
  OCR tokens (`Password = …`, `User name: …`, `Secret credentials = …`).
- Masking is **destructive and applied to the full-resolution frame before it is
  downscaled** — the pixels under every box (auto or user-drawn) are overwritten,
  not just covered by an overlay. Masked regions never reach the model.
- Masks are stored in full-res canvas coordinates, so they stay on-target across
  zoom, pan, and window resizing.
- This is covered by an automated pixel-level test — see `npm test`.

### What leaves your device

- **Ollama** — everything stays on your machine/network; nothing is transmitted.
- **Claude** — the redacted, downscaled keyframes are sent to the Anthropic API.
  Masked regions are already burned out, but **any unmasked pixels in a sent
  frame do leave the device**, so mask anything sensitive during review (or use
  Ollama). The full-resolution originals are never sent, and the recording is
  discarded from memory once the summary is generated.

## Features

- **Summary models** — Ollama (local, default) and Claude (cloud), chosen in the
  right-rail model picker or in Settings.
- **Summary Templates** — layer your own instructions (typed or uploaded `.md`)
  on top of the built-in baseline rules. The baseline always applies; a template
  only adds to it. Choose *No template* for baseline-only.
- **Activity timeline** (Windows, all optional & scrubbed) — captured alongside
  video and appended to the summary prompt:
  - **Window/app focus** — which tool was focused and for how long.
  - **Terminal commands** — locally-run PowerShell (optional transcript mode for
    command output).
  - **Browser activity** — admin portals/sites visited (Chrome/Edge; requires the
    native module rebuild).
- **Scrubbing** — client names and tenant/object IDs are stripped from OCR text
  and the activity timeline before any model sees them.
- **HaloPSA** — connection UI is present but disabled (**coming soon**); recording
  and summaries work fully without it.

## Configuration

Open **Settings** in the app. Everything persists locally (browser `localStorage`
in the app's user-data directory):

- **Summary model** and **Anthropic API key** (used only if Claude is selected).
- **Ollama** URL, vision model, and text model.
- **Change threshold** — how much a frame must change to be kept as a keyframe.
- **Activity capture** toggles (window / terminal / transcript / browser).
- **Client names to redact** (comma-separated).

Generated notes are written to `%USERPROFILE%\Documents\TicketScribe\`.

## Project structure

```
main.js                     Electron main process: window, IPC (capture sources, save, events)
main/events-capture.js      OS activity telemetry (window focus, PowerShell, browser history)
renderer/
  index.html                UI markup (Record / Review / Summary / Settings / Templates)
  styles.css                Cardonet-branded styling
  app.js                    All renderer logic: capture, OCR, review/redact, generation, settings
  providers.js              Ollama & Claude summary generation + shared baseline rules
  redact.js                 Destructive mask + downscale (the send-path); shared with the test
  scrub-timeline.js         Text scrubbing + word-level sensitive-value detection
  assets/                   Cardonet logo + Open Sans fonts
test/                       Pixel-level destructive-masking verification (npm test)
CLAUDE.md                   Architecture notes & constraints for contributors
```

## Testing

```bash
npm test
```

Runs a headless pixel-level check that reads pixels inside a masked region of the
final sent image and confirms the original data is genuinely overwritten (not
merely covered) — on both a below-cap frame and an above-cap frame that goes
through downscaling.

## Notes & limitations

- **Windows-first.** The record → redact → summarize core is portable, but the
  activity-timeline sources rely on PowerShell/Win32.
- **OCR language data** (`eng.traineddata`) is fetched on first use; the first
  recording after install needs network access for that download.
- **API key storage** currently uses `localStorage` (in the app's user-data dir,
  outside the project and git). Treat the machine as trusted accordingly.
- Commands run *inside* an RDP/remote session are not individually captured — only
  that the remote-session window was focused, and for how long.
