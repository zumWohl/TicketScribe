// ─── Electron bridge ────────────────────────────────────────────────────────
const { ipcRenderer } = require('electron');
const { createWorker } = require('tesseract.js');
const { providers } = require('./providers');
const { scrubText, scrubEvents } = require('./scrub-timeline');

// ─── Constants ──────────────────────────────────────────────────────────────
const CAPTURE_INTERVAL_MS = 1500;
const DEFAULT_THRESHOLD   = 5;    // hamming bits (0–64) – lower = more sensitive
const MAX_KEYFRAMES       = 60;

// ─── Settings ───────────────────────────────────────────────────────────────
function loadSettings() {
  document.getElementById('s-ollama-url').value     = ls('ollamaUrl',  'http://localhost:11434');
  document.getElementById('s-vlm-model').value      = ls('vlmModel',   'llava');
  document.getElementById('s-text-model').value     = ls('textModel',  'llama3');
  document.getElementById('s-threshold').value      = ls('threshold',  String(DEFAULT_THRESHOLD));
  document.getElementById('s-summary-model').value  = ls('summaryModel', 'ollama');
  document.getElementById('s-anthropic-key').value  = ls('anthropicApiKey', '');
  document.getElementById('s-capture-window').checked   = ls('captureWindow', 'true') === 'true';
  document.getElementById('s-capture-terminal').checked = ls('captureTerminal', 'true') === 'true';
  document.getElementById('s-capture-browser').checked  = ls('captureBrowser', 'true') === 'true';
  document.getElementById('s-transcript-enabled').checked = ls('transcriptEnabled', 'false') === 'true';
  document.getElementById('s-client-names').value   = ls('scrubClientNames', '');
}
function saveSettings() {
  set('ollamaUrl',       document.getElementById('s-ollama-url').value.trim());
  set('vlmModel',        document.getElementById('s-vlm-model').value.trim());
  set('textModel',       document.getElementById('s-text-model').value.trim());
  set('threshold',       document.getElementById('s-threshold').value.trim());
  set('summaryModel',    document.getElementById('s-summary-model').value);
  set('anthropicApiKey', document.getElementById('s-anthropic-key').value.trim());
  set('captureWindow',     String(document.getElementById('s-capture-window').checked));
  set('captureTerminal',   String(document.getElementById('s-capture-terminal').checked));
  set('captureBrowser',    String(document.getElementById('s-capture-browser').checked));
  set('transcriptEnabled', String(document.getElementById('s-transcript-enabled').checked));
  set('scrubClientNames',  document.getElementById('s-client-names').value.trim());
}
const ls  = (k, d) => localStorage.getItem(k) || d;
const set = (k, v) => localStorage.setItem(k, v);

// ─── State machine ──────────────────────────────────────────────────────────
// States: idle | recording | processing | review | done
let appState = 'idle';

function setState(s) {
  appState = s;
  document.body.dataset.state = s;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${s}`).classList.remove('hidden');
}

// ─── Recording state ────────────────────────────────────────────────────────
let stream         = null;
let captureHandle  = null;
let timerHandle    = null;
let keyframes      = [];
let lastHash       = null;
let startTime      = 0;
let currentTicket  = '';
let activityTimelineText = '';

// ─── perceptual average-hash (pure JS, OffscreenCanvas) ─────────────────────
function aHash(sourceCanvas) {
  const SIZE = 8;
  const off  = new OffscreenCanvas(SIZE, SIZE);
  const ctx  = off.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;

  const grays = [];
  for (let i = 0; i < px.length; i += 4)
    grays.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);

  const mean = grays.reduce((a, b) => a + b, 0) / grays.length;
  return grays.map(g => (g >= mean ? 1 : 0));
}

function hamming(h1, h2) {
  let d = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) d++;
  return d;
}

// ─── Screen capture ──────────────────────────────────────────────────────────
const video = document.getElementById('capture-video');

async function startCapture() {
  const sources = await ipcRenderer.invoke('get-sources');
  if (!sources.length) throw new Error('No screen sources found.');

  // Primary screen is always sources[0]
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource:   'desktop',
        chromeMediaSourceId: sources[0].id,
        maxWidth:            1920,
        maxHeight:           1080,
        maxFrameRate:        2,
      },
    },
  });

  video.srcObject = stream;
  await new Promise(r => { video.onloadedmetadata = r; });
  video.play();

  keyframes = [];
  lastHash  = null;
  captureHandle = setInterval(captureFrame, CAPTURE_INTERVAL_MS);
}

function stopCapture() {
  clearInterval(captureHandle);
  captureHandle = null;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
}

function captureFrame() {
  if (keyframes.length >= MAX_KEYFRAMES) return;

  const w = video.videoWidth  || 1280;
  const h = video.videoHeight || 720;

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0);

  const hash      = aHash(canvas);
  const threshold = parseInt(ls('threshold', String(DEFAULT_THRESHOLD)), 10);

  if (!lastHash || hamming(hash, lastHash) > threshold) {
    lastHash = hash;
    keyframes.push({ timestamp: Date.now(), canvas, dataUrl: canvas.toDataURL('image/jpeg', 0.75) });
    document.getElementById('frame-count').textContent = keyframes.length;
  }
}

// ─── Timer ───────────────────────────────────────────────────────────────────
function startTimer() {
  startTime = Date.now();
  const el  = document.getElementById('timer');
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}
function stopTimer() { clearInterval(timerHandle); timerHandle = null; }

// ─── OCR worker ──────────────────────────────────────────────────────────────
let ocrWorker = null;

async function ensureOCRWorker() {
  if (!ocrWorker) {
    ocrWorker = await createWorker('eng', 1, { logger: () => {} });
  }
}

async function runOCR(canvas) {
  try {
    await ensureOCRWorker();
    const { data: { text } } = await ocrWorker.recognize(canvas);
    return text.replace(/\s+/g, ' ').trim().slice(0, 600);
  } catch {
    return '';
  }
}

// ─── Activity timeline (window/terminal/browser events, scrubbed) ─────────────
// Events arrive already timestamp-sorted from main/events-capture.js. Window
// entries carry dwell time and are the spine of the session -- formatting
// them with their duration up front is what lets the model weight a 7-minute
// focus differently from a 4-second alt-tab, without needing a separate
// re-ordering pass (chronological order already keeps them interleaved).
function formatDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function formatActivityEvent(e) {
  const t = new Date(e.timestamp).toLocaleTimeString();
  if (e.type === 'window') {
    const { processName, windowTitle, category, durationMs } = e.detail;
    return `${t} (${formatDuration(durationMs)}) [${category}] ${windowTitle} (${processName})`;
  }
  if (e.type === 'terminal') {
    if (e.detail.shell === 'powershell-transcript') {
      return `${t} [terminal transcript: ${e.detail.file}]\n${e.detail.content}`;
    }
    return `${t} [terminal] ${e.detail.command}`;
  }
  if (e.type === 'browser') {
    return `${t} [${e.detail.category}] ${e.detail.title || e.detail.url} (${e.detail.browser})`;
  }
  return `${t} ${JSON.stringify(e.detail)}`;
}

function buildActivityTimelineText(events) {
  if (!events || events.length === 0) return '';
  return events.map(formatActivityEvent).join('\n');
}

// ─── Step helpers ────────────────────────────────────────────────────────────
function stepActive(id, detail) {
  const el = document.getElementById(id);
  el.dataset.status = 'active';
  document.getElementById(`detail-${id.replace('step-', '')}`).textContent = detail;
}
function stepDone(id, detail) {
  const el = document.getElementById(id);
  el.dataset.status = 'done';
  document.getElementById(`detail-${id.replace('step-', '')}`).textContent = detail;
}
function stepError(id, detail) {
  const el = document.getElementById(id);
  el.dataset.status = 'error';
  document.getElementById(`detail-${id.replace('step-', '')}`).textContent = detail;
}

// Reset all steps to waiting
function resetSteps() {
  ['step-ocr', 'step-vlm', 'step-sum'].forEach(id => {
    document.getElementById(id).dataset.status = 'waiting';
  });
  ['detail-ocr', 'detail-vlm', 'detail-sum'].forEach(id => {
    document.getElementById(id).textContent = 'Waiting…';
  });
}

// ─── Processing pipeline ─────────────────────────────────────────────────────
// Ollama is the default provider and keeps its original two-step shape
// (per-frame VLM description, then a text summary). Claude is an optional
// cloud alternative that does both in a single call. Either way, a failure
// must be visibly a failure -- never silently replaced with a raw OCR dump
// dressed up as a finished summary. See showGenerationFailure().
async function processPipeline() {
  setState('processing');
  resetSteps();
  document.getElementById('btn-use-raw-text').classList.add('hidden');

  const providerId = ls('summaryModel', 'ollama');

  // ── Step 1: OCR (always runs -- feeds both providers and the manual fallback) ──
  stepActive('step-ocr', `Running on ${keyframes.length} keyframe(s)…`);
  try {
    for (let i = 0; i < keyframes.length; i++) {
      document.getElementById('detail-ocr').textContent =
        `Frame ${i + 1} / ${keyframes.length}`;
      // Scrub right at the source -- everything downstream (the VLM's OCR
      // context, the raw-OCR fallback text, Claude's per-frame captions)
      // reads keyframes[i].ocrText, so this one call covers all of them.
      keyframes[i].ocrText = scrubText(await runOCR(keyframes[i].canvas));
    }
    stepDone('step-ocr', `Done — ${keyframes.length} frame(s) scanned`);
  } catch (err) {
    stepError('step-ocr', err.message);
    keyframes.forEach(kf => { kf.ocrText = kf.ocrText || ''; });
    stepDone('step-ocr', 'Completed with errors — continuing');
  }

  const rawFallbackText = keyframes.map(k => k.ocrText).filter(Boolean).join('\n\n');

  if (providerId === 'claude') {
    await runClaudePipeline(rawFallbackText);
  } else {
    await runOllamaPipeline(rawFallbackText);
  }
}

async function runOllamaPipeline(rawFallbackText) {
  const descriptions = [];

  // ── Step 2: VLM ──
  stepActive('step-vlm', 'Connecting to Ollama…');
  let lastVlmError = null;
  for (let i = 0; i < keyframes.length; i++) {
    document.getElementById('detail-vlm').textContent =
      `Frame ${i + 1} / ${keyframes.length}`;
    try {
      const text = await providers.ollama.describeFrame(keyframes[i].dataUrl, keyframes[i].ocrText);
      descriptions.push({ timestamp: keyframes[i].timestamp, text });
    } catch (err) {
      lastVlmError = err;
    }
  }

  if (descriptions.length === 0) {
    stepError('step-vlm', lastVlmError ? lastVlmError.message : 'No descriptions generated — is Ollama running?');
    stepError('step-sum', 'Skipped');
    showGenerationFailure(rawFallbackText);
    return;
  }
  stepDone('step-vlm', `${descriptions.length} description(s) generated`);

  // ── Step 3: Summarise ──
  stepActive('step-sum', 'Generating with Ollama…');
  try {
    const summary = await providers.ollama.generateSummary(descriptions, activityTimelineText);
    stepDone('step-sum', 'Done');
    finishWithSummary(summary);
  } catch (err) {
    stepError('step-sum', err.message);
    showGenerationFailure(rawFallbackText || descriptions.map(d => d.text).join('\n\n'));
  }
}

async function runClaudePipeline(rawFallbackText) {
  stepDone('step-vlm', 'Skipped — using Claude');
  stepActive('step-sum', 'Generating with Claude…');
  try {
    const ocrTexts = keyframes.map(k => k.ocrText);
    const summary = await providers.claude.generate(keyframes, ocrTexts, activityTimelineText);
    stepDone('step-sum', 'Done');
    finishWithSummary(summary);
  } catch (err) {
    stepError('step-sum', err.message);
    showGenerationFailure(rawFallbackText);
  }
}

function finishWithSummary(summary) {
  document.getElementById('summary-text').value = summary;
  document.getElementById('review-ticket-id').textContent = `#${currentTicket}`;
  setState('review');
}

// A generation failure must stay visibly a failure. This offers raw OCR text
// as an explicit, separately-labeled opt-in -- never an automatic substitute.
function showGenerationFailure(fallbackText) {
  const btn = document.getElementById('btn-use-raw-text');
  if (!fallbackText) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  btn.onclick = () => finishWithSummary(fallbackText);
}

// ─── Event wiring ────────────────────────────────────────────────────────────

// Settings toggle
document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('hidden');
});
document.getElementById('btn-save-settings').addEventListener('click', () => {
  saveSettings();
  document.getElementById('settings-panel').classList.add('hidden');
});
document.getElementById('btn-copy-transcript-snippet').addEventListener('click', async () => {
  const snippet = await ipcRenderer.invoke('events:get-transcript-snippet');
  await navigator.clipboard.writeText(snippet);
  const btn = document.getElementById('btn-copy-transcript-snippet');
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = original; }, 1500);
});

// Start recording
document.getElementById('btn-start').addEventListener('click', async () => {
  const input = document.getElementById('ticket-id');
  currentTicket = input.value.trim();
  if (!currentTicket) {
    input.classList.add('error');
    input.focus();
    return;
  }
  input.classList.remove('error');

  try {
    await startCapture();
  } catch (err) {
    alert(`Could not start capture:\n${err.message}`);
    return;
  }

  document.getElementById('rec-ticket-badge').textContent = `#${currentTicket}`;
  document.getElementById('frame-count').textContent = '0';
  document.getElementById('timer').textContent = '00:00';
  startTimer();
  setState('recording');

  // Warm up the OCR worker in the background while recording
  ensureOCRWorker().catch(() => {});

  // Kick off the event-stream capture (window/app activity, terminal
  // history, browser history) alongside video -- see main/events-capture.js.
  ipcRenderer.invoke('events:start', {
    window: ls('captureWindow', 'true') === 'true',
    transcript: ls('transcriptEnabled', 'false') === 'true',
  }).catch(() => {});
});

// Stop recording
document.getElementById('btn-stop').addEventListener('click', async () => {
  stopCapture();
  stopTimer();

  let rawEvents = [];
  try {
    rawEvents = await ipcRenderer.invoke('events:stop', {
      terminal: ls('captureTerminal', 'true') === 'true',
      browserHistory: ls('captureBrowser', 'true') === 'true',
    });
  } catch {
    rawEvents = [];
  }
  activityTimelineText = buildActivityTimelineText(scrubEvents(rawEvents));

  if (keyframes.length === 0) {
    alert('No keyframes were captured — the screen may not have changed enough.');
    setState('idle');
    return;
  }

  await processPipeline();
});

// Confirm summary → save
document.getElementById('btn-confirm').addEventListener('click', async () => {
  const summary = document.getElementById('summary-text').value.trim();
  if (!summary) return;

  const filename = `ticket-${currentTicket}-${Date.now()}.txt`;
  const content  = [
    'TicketScribe Work Note',
    '='.repeat(40),
    `Ticket:  #${currentTicket}`,
    `Date:    ${new Date().toLocaleString()}`,
    '',
    summary,
    '',
  ].join('\n');

  const result = await ipcRenderer.invoke('save-summary', { filename, content });
  if (!result.ok) {
    alert(`Save failed: ${result.error}`);
    return;
  }

  document.getElementById('done-ticket-id').textContent = `#${currentTicket}`;
  document.getElementById('done-path').textContent = result.path;
  setState('done');
});

// Discard summary
document.getElementById('btn-discard').addEventListener('click', () => {
  if (confirm('Discard this summary and return to idle?')) {
    keyframes = [];
    activityTimelineText = '';
    setState('idle');
  }
});

// Open folder
document.getElementById('btn-open-folder').addEventListener('click', () => {
  ipcRenderer.invoke('open-folder');
});

// New recording
document.getElementById('btn-new').addEventListener('click', () => {
  keyframes = [];
  activityTimelineText = '';
  document.getElementById('ticket-id').value = '';
  setState('idle');
});

// Remove error class on input change
document.getElementById('ticket-id').addEventListener('input', () => {
  document.getElementById('ticket-id').classList.remove('error');
});

// ─── Init ────────────────────────────────────────────────────────────────────
loadSettings();
setState('idle');
