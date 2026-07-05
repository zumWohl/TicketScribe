// ─── Electron bridge ────────────────────────────────────────────────────────
const { ipcRenderer } = require('electron');
const { createWorker } = require('tesseract.js');

// ─── Constants ──────────────────────────────────────────────────────────────
const CAPTURE_INTERVAL_MS = 1500;
const DEFAULT_THRESHOLD   = 5;    // hamming bits (0–64) – lower = more sensitive
const MAX_KEYFRAMES       = 60;

// ─── Settings ───────────────────────────────────────────────────────────────
function loadSettings() {
  document.getElementById('s-ollama-url').value  = ls('ollamaUrl',  'http://localhost:11434');
  document.getElementById('s-vlm-model').value   = ls('vlmModel',   'llava');
  document.getElementById('s-text-model').value  = ls('textModel',  'llama3');
  document.getElementById('s-threshold').value   = ls('threshold',  String(DEFAULT_THRESHOLD));
}
function saveSettings() {
  set('ollamaUrl', document.getElementById('s-ollama-url').value.trim());
  set('vlmModel',  document.getElementById('s-vlm-model').value.trim());
  set('textModel', document.getElementById('s-text-model').value.trim());
  set('threshold', document.getElementById('s-threshold').value.trim());
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

// ─── Ollama helpers ──────────────────────────────────────────────────────────
async function ollamaGenerate(payload) {
  const url = ls('ollamaUrl', 'http://localhost:11434');
  const res  = await fetch(`${url}/api/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ...payload, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).response.trim();
}

async function describeFrame(dataUrl, ocrText) {
  return ollamaGenerate({
    model:  ls('vlmModel', 'llava'),
    images: [dataUrl.split(',')[1]],
    prompt: `You are reviewing a screenshot from an IT support engineer's screen.
In 1–2 concise sentences, describe the specific action being performed.
Include: which application is visible, what the engineer is doing, and any important text (commands, errors, account names).
OCR context: "${ocrText.slice(0, 300)}"`,
  });
}

async function generateSummary(descriptions) {
  const timeline = descriptions
    .map((d, i) => `${i + 1}. [${new Date(d.timestamp).toLocaleTimeString()}] ${d.text}`)
    .join('\n');

  return ollamaGenerate({
    model:  ls('textModel', 'llama3'),
    prompt: `You are writing a professional work note for an IT support ticket.
Below is a timestamped timeline of observed actions.
Write a clear, past-tense, professional summary in 3–5 sentences suitable as a ticket note.
Describe what was done and any outcomes. No bullet points.

Timeline:
${timeline}

Work note:`,
  });
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
async function processPipeline() {
  setState('processing');
  resetSteps();

  const descriptions = [];

  // ── Step 1: OCR ──
  stepActive('step-ocr', `Running on ${keyframes.length} keyframe(s)…`);
  try {
    for (let i = 0; i < keyframes.length; i++) {
      document.getElementById('detail-ocr').textContent =
        `Frame ${i + 1} / ${keyframes.length}`;
      keyframes[i].ocrText = await runOCR(keyframes[i].canvas);
    }
    stepDone('step-ocr', `Done — ${keyframes.length} frame(s) scanned`);
  } catch (err) {
    stepError('step-ocr', err.message);
    keyframes.forEach(kf => { kf.ocrText = kf.ocrText || ''; });
    stepDone('step-ocr', 'Completed with errors — continuing');
  }

  // ── Step 2: VLM ──
  stepActive('step-vlm', 'Connecting to Ollama…');
  for (let i = 0; i < keyframes.length; i++) {
    document.getElementById('detail-vlm').textContent =
      `Frame ${i + 1} / ${keyframes.length}`;
    try {
      const text = await describeFrame(keyframes[i].dataUrl, keyframes[i].ocrText);
      descriptions.push({ timestamp: keyframes[i].timestamp, text });
    } catch (err) {
      // Fall back to OCR text so the summary still has something to work with
      if (keyframes[i].ocrText) {
        descriptions.push({
          timestamp: keyframes[i].timestamp,
          text: `[OCR fallback] ${keyframes[i].ocrText.slice(0, 200)}`,
        });
      }
    }
  }

  if (descriptions.length === 0) {
    stepError('step-vlm', 'No descriptions generated — is Ollama running?');
    stepError('step-sum', 'Skipped');
    return;
  }
  stepDone('step-vlm', `${descriptions.length} description(s) generated`);

  // ── Step 3: Summarise ──
  stepActive('step-sum', 'Generating work note…');
  let summary;
  try {
    summary = await generateSummary(descriptions);
    stepDone('step-sum', 'Done');
  } catch (err) {
    stepError('step-sum', err.message);
    // Surface raw descriptions so the engineer still has something
    summary = descriptions.map(d => d.text).join('\n\n');
  }

  document.getElementById('summary-text').value = summary;
  document.getElementById('review-ticket-id').textContent = `#${currentTicket}`;
  setState('review');
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
});

// Stop recording
document.getElementById('btn-stop').addEventListener('click', async () => {
  stopCapture();
  stopTimer();

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
