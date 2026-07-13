# Cardonet Capture

Cardonet Capture records your screen while you resolve an issue, detects and masks sensitive on-screen data (passwords, API keys, tokens, emails, tenant IDs, client names), lets you review and adjust the masks frame by frame, then turns the recording into a work summary. You can generate the note locally with Ollama or with cloud AI (Claude, ChatGPT, etc.).

Hidden regions are removed from the pixels before anything is sent, and nothing leaves your machine unless you pick a cloud model.

## Requirements

- Node.js 18 or newer, and npm.
- Windows. Activity capture uses PowerShell and Win32 APIs. The core record, redact, and summarize flow works on other platforms, but the activity-timeline features are Windows only.
- A summary model. Pick one:
  - Ollama running locally (the default, fully on-device). Pull a vision model and a text model, for example `ollama pull llava` and `ollama pull llama3`.
  - An Anthropic API key for Claude (optional cloud alternative).

## Install and run

```bash
npm install          # install dependencies (run once)
npm run rebuild      # rebuild better-sqlite3 for Electron's ABI (needed for browser-history capture)
npm start            # launch the app
```

Other scripts:

```bash
npm run dev          # launch with the Node inspector attached (port 9229)
npm test             # pixel-level check that redaction masking is destructive
```

`npm run rebuild` is only needed for the optional browser-history activity source. If you skip it, the app still runs and browser capture just does nothing.

## How it works

The workflow has three steps: Record, Review and redact, then Summary.

1. Record. Choose a capture source: a single window, or an entire screen (with a display picker when more than one monitor is connected). A keyframe is captured about every 1.5 seconds, and near-identical frames are dropped using a perceptual hash, so only frames that actually changed are kept. There is no frame cap. After 30 minutes you get a dismissable notice that the recording is long, and recording continues.
2. Review and redact. Every keyframe is run through OCR (Tesseract) and scanned for sensitive values, which are pre-masked with pink boxes. You can draw new masks, drag, resize, or delete any box, zoom and pan to check small text, and drop whole frames. The preview always shows the masked render.
3. Summary. The kept frames go to your chosen model and come back as a bullet-point work note. It is saved to `Documents/TicketScribe/`.

### Sensitive-data redaction

- Auto-detection flags passwords, usernames, API keys and tokens, GUID tenant IDs, emails, and configured client names. It handles labelled values that OCR splits across several tokens, such as `Password = ...`, `User name: ...`, and `Secret credentials = ...`.
- Masking is destructive and is applied to the full-resolution frame before it is downscaled. The pixels under every box, whether auto-detected or drawn by you, are overwritten rather than covered by an overlay. Masked regions never reach the model.
- Masks are stored in full-resolution canvas coordinates, so they stay on target across zoom, pan, and window resizing.
- An automated pixel-level test covers this. See `npm test`.

### What leaves your device

- Ollama: everything stays on your machine and network. Nothing is transmitted.
- Claude: the redacted, downscaled keyframes are sent to the Anthropic API. Masked regions are already removed, but any unmasked pixels in a sent frame do leave the device, so mask anything sensitive during review, or use Ollama. The full-resolution originals are never sent, and the recording is cleared from memory once the summary is generated.

## Features

- Summary models: Ollama (local, default) and Claude (cloud), chosen in the right-rail model picker or in Settings.
- Summary Templates: add your own instructions (typed, or uploaded as a `.md` file) on top of the built-in baseline rules. The baseline always applies, and a template only adds to it. Choose No template for baseline only.
- Activity timeline (Windows, all optional and scrubbed). Captured alongside video and added to the summary prompt:
  - Window and app focus: which tool was focused, and for how long.
  - Terminal commands: locally run PowerShell, with an optional transcript mode for command output.
  - Browser activity: admin portals and sites visited in Chrome or Edge (requires the native module rebuild).
- Scrubbing: client names and tenant or object IDs are stripped from OCR text and the activity timeline before any model sees them.
- HaloPSA: the connection UI is present but disabled (coming soon). Recording and summaries work without it.

## Configuration

Open Settings in the app. Everything persists locally, in browser `localStorage` in the app's user-data directory:

- Summary model, and Anthropic API key (used only if Claude is selected).
- Ollama URL, vision model, and text model.
- Change threshold (0 to 10): how much a frame must change to be kept as a keyframe. Lower keeps more frames, higher
keeps fewer.
- Activity capture toggles (window, terminal, transcript, browser).
- Client names to redact (comma-separated).

Generated notes are written to `%USERPROFILE%\Documents\TicketScribe\`.


## Notes and limitations

- Windows first. The record, redact, and summarize core is portable, but the activity-timeline sources rely on PowerShell and Win32.
- OCR language data (`eng.traineddata`) is fetched on first use, so the first recording after install needs network access for that download.
- API key storage currently uses `localStorage`, in the app's user-data directory, outside the project and git. Treat the machine as trusted accordingly.
- Commands run inside an RDP or remote session are not captured individually. Only that the remote-session window was focused, and for how long, is recorded.
