# Cardonet Capture

Cardonet Capture records your screen while you resolve an issue, detects and masks sensitive on-screen data (passwords, API keys, tokens, emails, tenant IDs, client names), lets you review and adjust the masks frame by frame, then turns the recording into a work summary. You can generate the note locally with Ollama or with the cloud model (Claude, routed through the org's Azure deployment).

Hidden regions are removed from the pixels before anything is sent, and nothing leaves your machine unless you pick the cloud model.

## Requirements

- Node.js 18 or newer, and npm.
- Windows. Activity capture uses PowerShell and Win32 APIs. The core record, redact, and summarize flow works on other platforms, but the activity-timeline features are Windows only.
- A summary model. Pick one:
  - Ollama running locally (the default, fully on-device). Pull a vision model and a text model, for example `ollama pull llava` and `ollama pull llama3`.
  - Claude (cloud alternative, routed through the org's Azure deployment). Requires `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and `AZURE_OPENAI_KEY` to be set in the environment the app is launched with -- there is no Settings UI for this, it's operator/IT-configured, not technician-configured.

## Install and run

```bash
npm install          # install dependencies -- also vendors tesseract's OCR assets and
                      # rebuilds better-sqlite3 for Electron's ABI (postinstall)
npm start            # launch the app (hot reload)
```

Other scripts:

```bash
npm run dev          # launch with the Node inspector attached
npm run dist         # build + package a Windows installer (dist/*.exe)
npm test             # pixel-level check that redaction masking is destructive
npm run typecheck    # TypeScript, no emit
npm run test:unit    # vitest
npm run test:e2e     # Playwright end-to-end tests
npm run rebuild      # force-rebuild better-sqlite3 manually (postinstall already does this;
                      # only needed if a node_modules reinstall or ABI mismatch leaves it stale)
```

`better-sqlite3` is only needed for the optional browser-history activity source. If the rebuild ever fails or is skipped, the app still runs and browser capture just does nothing.

## How it works

The workflow has three steps: Record, Review and redact, then Summary.

1. Record. Choose a capture source: a single window, or an entire screen (with a display picker when more than one monitor is connected). A keyframe is captured about every 1.5 seconds, and near-identical frames are dropped using a perceptual hash, so only frames that actually changed are kept. There is no frame cap. After 30 minutes you get a dismissable notice that the recording is long, and recording continues.
2. Review and redact. Every keyframe is run through OCR (Tesseract) and scanned for sensitive values, which are pre-masked with pink boxes. You can draw new masks, drag, resize, or delete any box, zoom and pan to check small text, and drop whole frames. The preview always shows the masked render.
3. Summary. The kept frames go to your chosen model and come back as a bullet-point work note. It is saved to `Documents/CardonetCapture/`.

### How redaction works

Each kept keyframe goes through the same pipeline before it's eligible to be sent anywhere:

1. **OCR** (Tesseract, vendored locally) reads every word on the frame and records each word's pixel bounding box.
2. **Auto-detection** (`findSensitiveWords`) scans that OCR text for passwords, usernames, API keys and tokens, GUID tenant IDs, emails, and your configured client names, including labelled values OCR splits across several tokens (`Password = ...`, `User name: ...`, `Secret credentials = ...`). Each hit becomes a pink auto-mask at that word's bounding box.
3. **Review** lets you draw additional masks (dashed navy), and drag, resize, or delete any box, auto or manual. You can also drop an entire frame. The preview canvas always shows the masked render, never the original.
4. **Generation-time masking** (`maskAndDownscale`) is destructive, not an overlay: it unions every auto + manual mask, `fillRect`s each one onto a **full-resolution copy** of the frame, and only _then_ downscales for the model. The pixels underneath are overwritten before the image is ever shrunk or sent — there's no code path where an unmasked full-res frame leaves the review stage.
5. **Text redaction** mirrors the pixel redaction: at generation time, `maskedOcrText()` drops any OCR word whose bounding box falls under a mask, then the remaining text is scrubbed again (`scrubText`) for GUIDs, emails, credential-shaped assignments, and client names — so the raw-OCR fallback path (if you ever click "Use raw OCR text instead" after a generation failure) can't leak what the pixel masks already hid.

Masks are stored in full-resolution canvas coordinates, so they stay aligned with the underlying frame across zoom, pan, and window resizing — what you draw at any zoom level lands on the right pixels when it's burned in.

**What this doesn't cover:** auto-detection is best-effort pattern matching over OCR output, not a guarantee — it can miss sensitive text that doesn't match its patterns, that OCR misread, or that's rendered as an image rather than selectable text. That's why the review stage exists: you're expected to look at every frame, not just trust the pink boxes. `npm test` (`test/mask-verify.html`) is an automated pixel-level check that redaction is actually destructive (the masked region's original pixels are gone from the final output, at both full-res and downscaled sizes) — it does not and cannot verify that auto-detection _found_ everything, only that whatever was masked is truly gone.

### What leaves your device

- Ollama: everything stays on your machine and network. Nothing is transmitted.
- Claude: the redacted, downscaled keyframes are sent to the org's Azure OpenAI deployment. Masked regions are already removed, but any unmasked pixels in a sent frame do leave the device, so mask anything sensitive during review, or use Ollama. The full-resolution originals are never sent, and the recording is cleared from memory once the summary is generated.

## Features

- Summary models: Ollama (local, default) and Claude (cloud, routed through Azure), chosen in the right-rail model picker or in Settings.
- Summary Templates: add your own instructions (typed, or uploaded as a `.md` file) on top of the built-in baseline rules. The baseline always applies, and a template only adds to it. Choose No template for baseline only.
- Activity timeline (Windows, all optional and scrubbed). Captured alongside video and added to the summary prompt:
  - Window and app focus: which tool was focused, and for how long.
  - Terminal commands: locally run PowerShell, with an optional transcript mode for command output.
  - Browser activity: admin portals and sites visited in Chrome or Edge (requires the native module rebuild).
- Scrubbing: client names and tenant or object IDs are stripped from OCR text and the activity timeline before any model sees them.
- HaloPSA: the connection UI is present but disabled (coming soon). Recording and summaries work without it.

## Configuration

Open Settings in the app. The summary model choice and the local-model fields below persist in browser `localStorage` in the app's user-data directory:

- Summary model.
- Ollama URL, vision model, and text model.
- Change threshold (0 to 10): how much a frame must change to be kept as a keyframe. Lower keeps more frames, higher
  keeps fewer.
- Activity capture toggles (window, terminal, transcript, browser).
- Client names to redact (comma-separated).

Claude (routed through Azure) has no Settings UI by design: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and `AZURE_OPENAI_KEY` are operator-configured environment variables, set once for the deployment rather than typed in by each technician.

Generated notes are written to `%USERPROFILE%\Documents\CardonetCapture\`.

## Notes and limitations

- Windows first. The record, redact, and summarize core is portable, but the activity-timeline sources rely on PowerShell and Win32.
- OCR language data (`eng.traineddata`) is bundled at install time (`npm install`'s postinstall step), so recording works offline from the first run.
- The Azure OpenAI key lives only in the environment the app is launched with -- it is never written to `localStorage` or disk by the app itself.
- Commands run inside an RDP or remote session are not captured individually. Only that the remote-session window was focused, and for how long, is recorded.
