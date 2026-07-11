// ─── Electron bridge ────────────────────────────────────────────────────────
const { ipcRenderer } = require('electron');
const { createWorker } = require('tesseract.js');
const { providers } = require('./providers');
const { scrubText, scrubEvents, findSensitiveWords } = require('./scrub-timeline');
const { maskAndDownscale, MODEL_IMAGE_MAX_DIMENSION } = require('./redact');

// ─── Constants ──────────────────────────────────────────────────────────────
const CAPTURE_INTERVAL_MS   = 1500;
const DEFAULT_THRESHOLD     = 5;    // hamming bits (0–64) – lower = more sensitive
const MASK_PADDING_PX       = 3;    // padding around auto-detected word boxes (full-res px)
const DURATION_WARNING_MS   = 30 * 60 * 1000; // warn once past 30 minutes
// NOTE: there is deliberately no keyframe cap — recordings run until stopped.
// A long-running recording surfaces a dismissable warning instead (see below).

const $ = (id) => document.getElementById(id);

// ─── Settings ───────────────────────────────────────────────────────────────
const ls  = (k, d) => localStorage.getItem(k) || d;
const set = (k, v) => localStorage.setItem(k, v);

function loadSettings() {
  $('s-ollama-url').value          = ls('ollamaUrl',  'http://localhost:11434');
  $('s-vlm-model').value           = ls('vlmModel',   'llava');
  $('s-text-model').value          = ls('textModel',  'llama3');
  $('s-threshold').value           = ls('threshold',  String(DEFAULT_THRESHOLD));
  $('s-anthropic-key').value       = ls('anthropicApiKey', '');
  $('s-capture-window').checked    = ls('captureWindow', 'true') === 'true';
  $('s-capture-terminal').checked  = ls('captureTerminal', 'true') === 'true';
  $('s-capture-browser').checked   = ls('captureBrowser', 'true') === 'true';
  $('s-transcript-enabled').checked = ls('transcriptEnabled', 'false') === 'true';
  $('s-client-names').value        = ls('scrubClientNames', '');
  applySummaryModel(ls('summaryModel', 'ollama'));
}
function saveSettings() {
  set('ollamaUrl',       $('s-ollama-url').value.trim());
  set('vlmModel',        $('s-vlm-model').value.trim());
  set('textModel',       $('s-text-model').value.trim());
  set('threshold',       $('s-threshold').value.trim());
  set('anthropicApiKey', $('s-anthropic-key').value.trim());
  set('captureWindow',     String($('s-capture-window').checked));
  set('captureTerminal',   String($('s-capture-terminal').checked));
  set('captureBrowser',    String($('s-capture-browser').checked));
  set('transcriptEnabled', String($('s-transcript-enabled').checked));
  set('scrubClientNames',  $('s-client-names').value.trim());
  // summaryModel is persisted live by the model picker (applySummaryModel).
}

// Keep both model pickers (right rail + Settings) and the review footer label
// in sync from one source of truth (localStorage.summaryModel).
function applySummaryModel(id) {
  set('summaryModel', id);
  document.querySelectorAll('.model-item').forEach(el => {
    el.classList.toggle('active', el.dataset.model === id);
  });
  $('review-model-name').textContent = id === 'claude' ? 'Claude' : 'Ollama (local)';
}

// ─── Summary templates ────────────────────────────────────────────────────────
// Persisted in localStorage (same mechanism as every other setting/key in the
// app): `summaryTemplates` = JSON array of { id, title, content }; the active
// selection is `activeTemplateId` ('' = none / baseline only). providers.js
// reads these same keys to layer the active template onto SUMMARY_RULES.
let editingId = null;   // template being edited in the form (null = new)

function loadTemplates() {
  try { const v = JSON.parse(ls('summaryTemplates', '[]')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function saveTemplates(list) { set('summaryTemplates', JSON.stringify(list)); }
function getActiveTemplateId() { return localStorage.getItem('activeTemplateId') || ''; }
function setActiveTemplateId(id) { set('activeTemplateId', id || ''); }

function renderTemplates() {
  const list = loadTemplates();
  const activeId = getActiveTemplateId();
  const el = $('tpl-list');
  if (!el) return;
  el.innerHTML = '';
  el.appendChild(makeTemplateCard({ id: '', title: 'No template', sub: 'Baseline rules only' }, activeId, false));
  list.forEach(t => el.appendChild(makeTemplateCard(t, activeId, true)));
}

function makeTemplateCard(t, activeId, editable) {
  const card = document.createElement('div');
  card.className = 'tpl-item' + (t.id === activeId ? ' active' : '');
  card.dataset.tplId = t.id;
  card.innerHTML =
    `<span class="radio"></span>` +
    `<div class="grow"><div class="name">${escapeHtml(t.title || 'Untitled')}</div>` +
    (t.sub ? `<div class="sub">${escapeHtml(t.sub)}</div>` : '') + `</div>`;
  // Clicking the card selects (activates) this template — or "No template".
  card.addEventListener('click', () => { setActiveTemplateId(t.id); renderTemplates(); });
  if (editable) {
    const actions = document.createElement('div');
    actions.className = 'tpl-actions';
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'tpl-mini'; edit.textContent = 'Edit';
    edit.addEventListener('click', (e) => { e.stopPropagation(); openTemplateEditor(t.id); });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'tpl-mini danger'; del.textContent = 'Delete';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTemplate(t.id); });
    actions.append(edit, del);
    card.appendChild(actions);
  }
  return card;
}

function openTemplateEditor(id) {
  const t = loadTemplates().find(x => x.id === id);
  editingId = t ? t.id : null;
  $('tpl-title').value = t ? t.title : '';
  $('tpl-content').value = t ? t.content : '';
  $('tpl-title').classList.remove('error');
  $('tpl-editor-label').textContent = t ? `Editing: ${t.title || 'Untitled'}` : 'New template';
  $('tpl-delete').style.display = t ? '' : 'none';
  $('tpl-file-note').textContent = '';
}
function newTemplateEditor() { openTemplateEditor(null); }

function saveTemplate() {
  const title = $('tpl-title').value.trim();
  const content = $('tpl-content').value;
  if (!title) { $('tpl-title').classList.add('error'); $('tpl-title').focus(); return; }
  const list = loadTemplates();
  if (editingId) {
    const t = list.find(x => x.id === editingId);
    if (t) { t.title = title; t.content = content; }
  } else {
    const id = `tpl-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    list.push({ id, title, content });
    editingId = id;
    setActiveTemplateId(id);   // a freshly authored template becomes the active one
  }
  saveTemplates(list);
  renderTemplates();
  openTemplateEditor(editingId);
  const note = $('tpl-file-note');
  note.textContent = 'Saved';
  setTimeout(() => { if (note.textContent === 'Saved') note.textContent = ''; }, 1500);
}

function deleteTemplate(id) {
  if (!confirm('Delete this template?')) return;
  saveTemplates(loadTemplates().filter(x => x.id !== id));
  // If the active template was deleted, fall back to baseline-only (no dangling id).
  if (getActiveTemplateId() === id) setActiveTemplateId('');
  if (editingId === id) newTemplateEditor();
  renderTemplates();
}

async function loadTemplateFile(file) {
  if (!file) return;
  let text = '';
  try { text = await file.text(); } catch { text = ''; }
  $('tpl-content').value = text;
  if (!$('tpl-title').value.trim()) {
    $('tpl-title').value = file.name.replace(/\.(md|markdown|txt)$/i, '');
    $('tpl-title').classList.remove('error');
  }
  $('tpl-file-note').textContent = `Loaded ${file.name}`;
}

// ─── Screen / stage machine ──────────────────────────────────────────────────
// screen: work | settings.  stage (within work): ready | countdown | recording
//         | review | processing | sent
function setScreen(s) {
  document.body.dataset.screen = s;
  $('nav-work').classList.toggle('active', s === 'work');
  $('nav-settings').classList.toggle('active', s === 'settings');
  $('nav-templates').classList.toggle('active', s === 'templates');
}
function setStage(s) {
  document.body.dataset.stage = s;
  updateStepper(s);
}
function updateStepper(stage) {
  // step 0 Record · 1 Review & redact · 2 Summary
  let active;
  if (stage === 'review') active = 1;
  else if (stage === 'processing' || stage === 'sent') active = 2;
  else active = 0;
  const allDone = stage === 'sent';
  document.querySelectorAll('#stepper .step').forEach(el => {
    const n = parseInt(el.dataset.step, 10);
    el.classList.toggle('done', n < active || (allDone && n <= active));
    el.classList.toggle('active', n === active && !allDone);
  });
}

// ─── Recording state ──────────────────────────────────────────────────────────
let stream         = null;
let captureHandle  = null;
let timerHandle    = null;
let countdownHandle = null;
let keyframes      = [];
let lastHash       = null;
let startTime      = 0;
let currentTicket  = '';
let activityTimelineText = '';
let captureSource  = 'window';     // window | screen
let durationWarned = false;

const video = $('capture-video');

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

// ─── Capture source selection ─────────────────────────────────────────────────
async function populateWindows() {
  const sel = $('window-select');
  try {
    const sources = await ipcRenderer.invoke('get-sources', { types: ['window'] });
    if (!sources.length) {
      sel.innerHTML = '<option value="">No capturable windows found</option>';
      return;
    }
    sel.innerHTML = sources
      .map(s => `<option value="${s.id}">${escapeHtml(s.name || s.id)}</option>`)
      .join('');
  } catch {
    sel.innerHTML = '<option value="">Could not list windows</option>';
  }
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Populate the display picker. The picker row is only surfaced when more than
// one display is attached -- with a single monitor there is nothing to choose,
// so "Entire screen" just records it. Multi-monitor labels (resolution +
// Primary) come from main.js's get-sources mapping.
async function populateScreens() {
  const sel = $('screen-select');
  const picker = $('screen-picker');
  let sources = [];
  try {
    sources = await ipcRenderer.invoke('get-sources', { types: ['screen'] });
  } catch {
    sel.innerHTML = '<option value="">Could not list displays</option>';
    picker.style.display = 'none';
    return;
  }
  if (!sources.length) {
    sel.innerHTML = '<option value="">No displays found</option>';
    picker.style.display = 'none';
    return;
  }
  const prev = sel.value;
  sel.innerHTML = sources
    .map(s => `<option value="${s.id}">${escapeHtml(s.name || s.id)}</option>`)
    .join('');
  // Keep a prior valid choice; otherwise default to the primary display.
  if (prev && sources.some(s => s.id === prev)) {
    sel.value = prev;
  } else {
    const primary = sources.find(s => / · Primary$/.test(s.name));
    sel.value = (primary || sources[0]).id;
  }
  picker.style.display = (captureSource === 'screen' && sources.length > 1) ? 'flex' : 'none';
}

async function resolveSourceId() {
  if (captureSource === 'window') {
    const id = $('window-select').value;
    if (id) return id;
    // fall through to picking the first window if the select is empty
    const wins = await ipcRenderer.invoke('get-sources', { types: ['window'] });
    if (wins.length) return wins[0].id;
    throw new Error('No capturable window is available. Try "Entire screen" instead.');
  }
  // Screen mode: use the display the user picked (when multiple are attached),
  // falling back to the first/primary screen for a single-display setup.
  const chosen = $('screen-select').value;
  if (chosen) return chosen;
  const screens = await ipcRenderer.invoke('get-sources', { types: ['screen'] });
  if (!screens.length) throw new Error('No screen sources found.');
  return screens[0].id;
}

async function startCapture() {
  const sourceId = await resolveSourceId();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource:   'desktop',
        chromeMediaSourceId: sourceId,
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

// Each kept keyframe stores the pristine full-res canvas (used for OCR and as
// the masking source). dataUrl is derived only at generation time, AFTER masks
// are applied — see generateSummary(). masks[] are in full-res canvas pixels.
function captureFrame() {
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
    keyframes.push({ timestamp: Date.now(), canvas, ocrText: '', ocrWords: [], masks: [], removed: false });
    $('frame-count').textContent = keyframes.length;
  }
}

// ─── Timer ───────────────────────────────────────────────────────────────────
function startTimer() {
  startTime = Date.now();
  durationWarned = false;
  const el = $('timer');
  const badge = $('rec-badge-time');
  timerHandle = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const s = Math.floor(elapsed / 1000);
    const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    el.textContent = text;
    badge.textContent = text;
    if (!durationWarned && elapsed >= DURATION_WARNING_MS) {
      durationWarned = true;
      $('duration-modal').classList.remove('hidden'); // recording keeps running
    }
  }, 1000);
}
function stopTimer() { clearInterval(timerHandle); timerHandle = null; }

// ─── OCR worker ────────────────────────────────────────────────────────────────
let ocrWorker = null;
async function ensureOCRWorker() {
  if (!ocrWorker) ocrWorker = await createWorker('eng', 1, { logger: () => {} });
}
async function runOCR(canvas) {
  try {
    await ensureOCRWorker();
    const { data } = await ocrWorker.recognize(canvas);
    const text = data.text.replace(/\s+/g, ' ').trim().slice(0, 600);
    const words = (data.blocks || [])
      .flatMap(b => b.paragraphs || [])
      .flatMap(p => p.lines || [])
      .flatMap(l => l.words || [])
      .filter(w => w.text && w.text.trim())
      .map(w => ({ text: w.text, bbox: w.bbox }));
    return { text, words };
  } catch {
    return { text: '', words: [] };
  }
}

// ─── Activity timeline (unchanged formatting) ──────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════
//  REVIEW & REDACT
// ═══════════════════════════════════════════════════════════════════════════
let reviewIndex  = 0;
let reviewReady  = false;
let interaction  = null;   // { type:'draw'|'move'|'resize', maskId, handle, dx, dy, x0, y0 }
let draftRect    = null;   // { x, y, w, h } in full-res canvas px
// Zoom is expressed relative to the fit-to-view scale (1 = fit). Zooming
// re-renders the SAME masked preview (burnPreview) at a larger backing-store
// resolution — never a separate unmasked source — and lets #frame-stage scroll
// to pan. Because masks are stored in full-res canvas coords and boxes/pointer
// mapping are derived from the overlay's live rect, the interactions stay
// correct at any zoom without extra math.
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
let zoomLevel  = 1;

// After Stop: OCR every frame, scrub its text, and seed auto-detected masks
// (in full-res canvas coordinates) from the sensitive words Tesseract found.
async function analyzeFrames() {
  reviewReady = false;
  const empty = $('frame-empty');
  for (let i = 0; i < keyframes.length; i++) {
    empty.innerHTML = `<span class="mini-spin"></span> Scanning frame ${i + 1} of ${keyframes.length} for sensitive data…`;
    const { text, words } = await runOCR(keyframes[i].canvas);
    keyframes[i].ocrText  = scrubText(text);
    keyframes[i].ocrWords = words;
    keyframes[i].masks    = autoMasksFor(keyframes[i]);
  }
  reviewReady = true;
  reviewIndex = 0;
  resetZoom();
  renderReview();
}

function autoMasksFor(kf) {
  const c = kf.canvas;
  return findSensitiveWords(kf.ocrWords).map((w, i) => {
    const x = Math.max(0, w.bbox.x0 - MASK_PADDING_PX);
    const y = Math.max(0, w.bbox.y0 - MASK_PADDING_PX);
    const wd = Math.min(c.width  - x, (w.bbox.x1 - w.bbox.x0) + MASK_PADDING_PX * 2);
    const ht = Math.min(c.height - y, (w.bbox.y1 - w.bbox.y0) + MASK_PADDING_PX * 2);
    return { id: `auto-${kf.timestamp}-${i}`, x, y, w: wd, h: ht, auto: true };
  });
}

function totalMaskCount() {
  return keyframes.reduce((n, kf) => n + (kf.removed ? 0 : kf.masks.length), 0);
}

// Render the whole review view for the current frame.
function renderReview() {
  const total = keyframes.length;
  $('masked-total').textContent = totalMaskCount();
  $('frame-pos').textContent = total ? `Frame ${reviewIndex + 1} of ${total}` : 'No frames';
  renderFilmstrip();

  const kf = keyframes[reviewIndex];
  const canvas = $('preview-canvas');
  const empty  = $('frame-empty');
  const overlay = $('mask-overlay');
  const removedOverlay = $('frame-removed-overlay');

  if (!reviewReady || !kf) {
    canvas.classList.add('hidden');
    overlay.classList.add('hidden');
    removedOverlay.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  $('frame-title').textContent = `Keyframe ${reviewIndex + 1} · ${new Date(kf.timestamp).toLocaleTimeString()}`;
  empty.classList.add('hidden');
  canvas.classList.remove('hidden');

  burnPreview(kf);          // destructive masked render onto the preview canvas
  removedOverlay.classList.toggle('hidden', !kf.removed);

  if (kf.removed) {
    overlay.classList.add('hidden');
  } else {
    overlay.classList.remove('hidden');
    positionOverlay();
    renderMaskBoxes(kf);
  }
  updateZoomLabel();
  // At fit there's nothing to pan; keep the view anchored top-left/centered.
  if (zoomLevel === 1) { const s = $('frame-stage'); s.scrollLeft = 0; s.scrollTop = 0; }
}

// Base fit-to-view scale for the current frame (source px → screen px at
// zoom 1). Kept as a helper so the zoom label and clamping share one definition.
function fitScale(kf) {
  const stage = $('frame-stage');
  const maxW = stage.clientWidth;
  const maxH = stage.clientHeight;
  return Math.min(maxW / kf.canvas.width, maxH / kf.canvas.height, 1) || 1;
}

// Draw the frame at the current effective scale (fit × zoom), then destructively
// paint every mask on the preview canvas itself — so no readable secret pixels
// are ever shown beneath a box, even mid-drag or zoomed in (re-run on every
// mask change and every zoom change). Zooming enlarges the backing store and
// re-reads the full-res source for real detail; it NEVER reads an unmasked
// render, so the masking guarantee holds at any zoom.
function burnPreview(kf) {
  const src = kf.canvas;
  const effScale = fitScale(kf) * zoomLevel;
  const dw = Math.max(1, Math.round(src.width * effScale));
  const dh = Math.max(1, Math.round(src.height * effScale));

  const canvas = $('preview-canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, dw, dh);

  // Fill masks in preview-space px (mask coords are full-res → scale to effScale).
  ctx.fillStyle = '#18161E';
  for (const m of kf.masks) {
    ctx.fillRect(m.x * effScale, m.y * effScale, m.w * effScale, m.h * effScale);
  }
}

// Line up the interactive overlay exactly over the (centered) preview canvas.
function positionOverlay() {
  const canvas = $('preview-canvas');
  const overlay = $('mask-overlay');
  overlay.style.left   = canvas.offsetLeft + 'px';
  overlay.style.top    = canvas.offsetTop + 'px';
  overlay.style.width  = canvas.offsetWidth + 'px';
  overlay.style.height = canvas.offsetHeight + 'px';
}

// Build the editable box DOM. Boxes are positioned as PERCENTAGES of the
// full-res canvas dimensions, so they stay on-target across window resizes and
// re-renders (canvas-space is the source of truth; display coords are derived).
function renderMaskBoxes(kf) {
  const overlay = $('mask-overlay');
  overlay.innerHTML = '';
  const cw = kf.canvas.width, ch = kf.canvas.height;

  for (const m of kf.masks) {
    const box = document.createElement('div');
    box.className = 'mask-box ' + (m.auto ? 'auto' : 'user');
    box.dataset.maskId = m.id;
    applyBoxGeometry(box, m, cw, ch);

    const tag = document.createElement('span');
    tag.className = 'mask-tag';
    tag.textContent = m.auto ? 'Auto' : 'Manual';
    box.appendChild(tag);

    const del = document.createElement('button');
    del.className = 'mask-del';
    del.textContent = '✕';
    del.addEventListener('mousedown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      kf.masks = kf.masks.filter(x => x.id !== m.id);
      renderReview();
    });
    box.appendChild(del);

    ['nw', 'ne', 'sw', 'se'].forEach(h => {
      const handle = document.createElement('span');
      handle.className = `mask-handle mh-${h}`;
      handle.addEventListener('mousedown', (e) => beginResize(e, m.id, h));
      box.appendChild(handle);
    });

    box.addEventListener('mousedown', (e) => beginMove(e, m.id));
    overlay.appendChild(box);
  }
}

function applyBoxGeometry(box, m, cw, ch) {
  box.style.left   = (m.x / cw * 100) + '%';
  box.style.top    = (m.y / ch * 100) + '%';
  box.style.width  = (m.w / cw * 100) + '%';
  box.style.height = (m.h / ch * 100) + '%';
}

function renderFilmstrip() {
  const strip = $('filmstrip');
  strip.innerHTML = '';
  keyframes.forEach((kf, i) => {
    const b = document.createElement('button');
    b.className = 'fs-thumb' + (i === reviewIndex ? ' active' : '') + (kf.removed ? ' removed' : '');
    b.innerHTML = `<div class="num">${i + 1}</div>`;
    if (!kf.removed && kf.masks.length) {
      const dot = document.createElement('span');
      dot.className = 'marker';
      b.appendChild(dot);
    }
    b.addEventListener('click', () => { reviewIndex = i; resetZoom(); renderReview(); });
    strip.appendChild(b);
  });
}

// ── draw / move / resize (all in full-res canvas px) ──────────────────────────
function pointerToCanvas(e) {
  const kf = keyframes[reviewIndex];
  const rect = $('mask-overlay').getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width  * kf.canvas.width;
  const y = (e.clientY - rect.top)  / rect.height * kf.canvas.height;
  return {
    x: Math.max(0, Math.min(kf.canvas.width, x)),
    y: Math.max(0, Math.min(kf.canvas.height, y)),
  };
}

function beginDraw(e) {
  if (e.button !== 0) return;
  const p = pointerToCanvas(e);
  interaction = { type: 'draw', x0: p.x, y0: p.y };
  draftRect = { x: p.x, y: p.y, w: 0, h: 0 };
  renderDraft();
}
function beginMove(e, id) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const kf = keyframes[reviewIndex];
  const m = kf.masks.find(x => x.id === id);
  const p = pointerToCanvas(e);
  interaction = { type: 'move', maskId: id, dx: p.x - m.x, dy: p.y - m.y };
}
function beginResize(e, id, handle) {
  if (e.button !== 0) return;
  e.stopPropagation();
  interaction = { type: 'resize', maskId: id, handle };
}

function onPointerMove(e) {
  if (!interaction) return;
  const kf = keyframes[reviewIndex];
  const cw = kf.canvas.width, ch = kf.canvas.height;
  const p = pointerToCanvas(e);
  const MIN = Math.max(6, cw * 0.01);

  if (interaction.type === 'draw') {
    draftRect = {
      x: Math.min(interaction.x0, p.x),
      y: Math.min(interaction.y0, p.y),
      w: Math.abs(p.x - interaction.x0),
      h: Math.abs(p.y - interaction.y0),
    };
    renderDraft();
    return;
  }

  const m = kf.masks.find(x => x.id === interaction.maskId);
  if (!m) return;

  if (interaction.type === 'move') {
    m.x = Math.max(0, Math.min(cw - m.w, p.x - interaction.dx));
    m.y = Math.max(0, Math.min(ch - m.h, p.y - interaction.dy));
  } else if (interaction.type === 'resize') {
    const h = interaction.handle;
    let { x, y, w, ht } = { x: m.x, y: m.y, w: m.w, ht: m.h };
    const right = x + w, bottom = y + ht;
    if (h.includes('w')) { x = Math.min(p.x, right - MIN);  w = right - x; }
    if (h.includes('e')) { w = Math.max(MIN, Math.min(cw, p.x) - x); }
    if (h.includes('n')) { y = Math.min(p.y, bottom - MIN); ht = bottom - y; }
    if (h.includes('s')) { ht = Math.max(MIN, Math.min(ch, p.y) - y); }
    m.x = Math.max(0, x); m.y = Math.max(0, y);
    m.w = Math.min(cw - m.x, w); m.h = Math.min(ch - m.y, ht);
  }

  // In-place update (no DOM rebuild during drag) + re-burn so pixels under the
  // box's CURRENT position are always masked.
  const box = document.querySelector(`.mask-box[data-mask-id="${cssEscape(m.id)}"]`);
  if (box) applyBoxGeometry(box, m, cw, ch);
  burnPreview(kf);
}

function onPointerUp() {
  if (!interaction) return;
  if (interaction.type === 'draw') {
    const kf = keyframes[reviewIndex];
    const d = draftRect;
    const MIN = Math.max(6, kf.canvas.width * 0.01);
    if (d && d.w > MIN && d.h > MIN) {
      kf.masks.push({ id: `user-${Date.now()}`, x: d.x, y: d.y, w: d.w, h: d.h, auto: false });
    }
    draftRect = null;
    interaction = null;
    renderReview();
    return;
  }
  interaction = null;
  renderReview();  // rebuild for consistent state + counts
}

function renderDraft() {
  const overlay = $('mask-overlay');
  let el = overlay.querySelector('.mask-draft');
  if (!draftRect) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'mask-draft'; overlay.appendChild(el); }
  const kf = keyframes[reviewIndex];
  el.style.left   = (draftRect.x / kf.canvas.width * 100) + '%';
  el.style.top    = (draftRect.y / kf.canvas.height * 100) + '%';
  el.style.width  = (draftRect.w / kf.canvas.width * 100) + '%';
  el.style.height = (draftRect.h / kf.canvas.height * 100) + '%';
  // keep preview masked while drafting (draft not yet a committed mask)
  burnPreview(kf);
}

function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// ── Zoom & pan ────────────────────────────────────────────────────────────────
// Set the zoom level, re-render the masked preview at the new scale, and keep
// the point under `anchorClientX/Y` (defaults to the viewport centre) fixed so
// zooming feels stable. Panning is via #frame-stage's native scrollbars.
function setZoom(newZoom, anchorClientX, anchorClientY) {
  const kf = keyframes[reviewIndex];
  if (!reviewReady || !kf || kf.removed) return;
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  const stage = $('frame-stage');
  const canvas = $('preview-canvas');
  const rect = stage.getBoundingClientRect();
  const ax = (anchorClientX == null ? rect.left + stage.clientWidth / 2 : anchorClientX) - rect.left;
  const ay = (anchorClientY == null ? rect.top + stage.clientHeight / 2 : anchorClientY) - rect.top;
  // Fraction of the content currently under the anchor point (old canvas space).
  const oldW = canvas.width || 1, oldH = canvas.height || 1;
  const fx = (stage.scrollLeft + ax) / oldW;
  const fy = (stage.scrollTop + ay) / oldH;

  zoomLevel = z;
  burnPreview(kf);      // same masked render, larger backing store
  positionOverlay();    // overlay tracks the resized canvas; %-boxes follow
  updateZoomLabel();

  // Restore the anchor so the same pixel stays under the cursor/centre.
  stage.scrollLeft = fx * canvas.width - ax;
  stage.scrollTop  = fy * canvas.height - ay;
}

function updateZoomLabel() {
  const label = $('zoom-label');
  if (label) label.textContent = Math.round(zoomLevel * 100) + '%';
  const out = $('zoom-out'), zin = $('zoom-in'), fit = $('zoom-fit');
  if (out) out.disabled = zoomLevel <= MIN_ZOOM + 1e-3;
  if (zin) zin.disabled = zoomLevel >= MAX_ZOOM - 1e-3;
  if (fit) fit.disabled = zoomLevel === 1;
}

function resetZoom() { zoomLevel = 1; }

// ═══════════════════════════════════════════════════════════════════════════
//  GENERATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════
function resetProcSteps() {
  document.querySelectorAll('#proc-steps .proc-step').forEach(el => {
    el.classList.remove('active', 'done');
    const ico = el.querySelector('.ico');
    ico.textContent = String(parseInt(el.dataset.pstep, 10) + 1);
  });
}
function procStep(index, state) {
  document.querySelectorAll('#proc-steps .proc-step').forEach(el => {
    const n = parseInt(el.dataset.pstep, 10);
    el.classList.remove('active', 'done');
    const ico = el.querySelector('.ico');
    if (n < index) { el.classList.add('done'); ico.textContent = '✓'; }
    else if (n === index && state !== 'done') { el.classList.add('active'); ico.textContent = '◜'; }
    else if (n === index && state === 'done') { el.classList.add('done'); ico.textContent = '✓'; }
    else { ico.textContent = String(n + 1); }
  });
}
function setProgress(pct, label) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  $('progress-fill').style.width = p + '%';
  $('progress-pct').textContent = p + '%';
  if (label) $('progress-label').textContent = label;
}

// Compute the OCR text actually sent for a frame: any word whose bbox falls
// under a mask (auto OR user-drawn) is dropped, then the rest is scrubbed. This
// routes the raw-OCR/fallback text through the same redaction gate as the
// pixels — a value the user masked can't leak back via the text channel.
function maskedOcrText(kf) {
  const words = kf.ocrWords || [];
  if (!words.length) return kf.ocrText || '';
  if (!kf.masks.length) return kf.ocrText || '';
  const kept = words.filter(w => {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    return !kf.masks.some(m => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h);
  });
  const text = kept.map(w => w.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  return scrubText(text);
}

async function generateSummary() {
  const live = keyframes.filter(kf => !kf.removed);
  if (!live.length) {
    alert('Every frame has been removed — there is nothing to send. Keep at least one frame or discard the recording.');
    return;
  }

  setStage('processing');
  resetProcSteps();
  $('btn-use-raw-text').classList.add('hidden');

  const providerId = ls('summaryModel', 'ollama');
  $('pstep-send-lbl').textContent = providerId === 'claude'
    ? 'Sending redacted frames to Claude' : 'Sending redacted frames to Ollama';

  // Step 0: OCR already ran in the review stage.
  procStep(0, 'done');
  setProgress(15, 'On-screen text already read');

  // Step 1: apply masks destructively on full-res, then downscale. Build light
  // send-objects that hold NO canvas references, so we can free the big
  // keyframe canvases immediately afterwards.
  procStep(1);
  setProgress(30, 'Applying redaction masks to frames');
  const sendFrames = live.map(kf => ({
    timestamp: kf.timestamp,
    dataUrl: maskAndDownscale(kf.canvas, kf.masks),
    ocrText: maskedOcrText(kf),
  }));
  const rawFallbackText = sendFrames.map(f => f.ocrText).filter(Boolean).join('\n\n');
  procStep(1, 'done');

  // Free full-res canvases now (see CLAUDE.md memory note) — review is over.
  keyframes = [];

  procStep(2);
  setProgress(45, 'Sending redacted frames to the model');

  if (providerId === 'claude') {
    await runClaudePipeline(sendFrames, rawFallbackText);
  } else {
    await runOllamaPipeline(sendFrames, rawFallbackText);
  }
}

async function runOllamaPipeline(sendFrames, rawFallbackText) {
  const descriptions = [];
  let lastVlmError = null;
  for (let i = 0; i < sendFrames.length; i++) {
    setProgress(45 + (i / sendFrames.length) * 35, `Describing frame ${i + 1} of ${sendFrames.length}`);
    try {
      const text = await providers.ollama.describeFrame(sendFrames[i].dataUrl, sendFrames[i].ocrText);
      descriptions.push({ timestamp: sendFrames[i].timestamp, text });
    } catch (err) {
      lastVlmError = err;
    }
  }

  if (descriptions.length === 0) {
    procStep(2); // leave send step spinning-as-error context
    setProgress(80, 'Frame analysis failed');
    showGenerationFailure(lastVlmError ? lastVlmError.message : 'No descriptions generated — is Ollama running?', rawFallbackText);
    return;
  }
  procStep(3);
  setProgress(85, 'Generating summary from the frame sequence');
  try {
    const summary = await providers.ollama.generateSummary(descriptions, activityTimelineText);
    procStep(3, 'done');
    setProgress(100, 'Done');
    finishWithSummary(summary);
  } catch (err) {
    showGenerationFailure(err.message, rawFallbackText || descriptions.map(d => d.text).join('\n\n'));
  }
}

async function runClaudePipeline(sendFrames, rawFallbackText) {
  procStep(3);
  setProgress(70, 'Generating summary with Claude');
  try {
    const ocrTexts = sendFrames.map(f => f.ocrText);
    const summary = await providers.claude.generate(sendFrames, ocrTexts, activityTimelineText);
    procStep(3, 'done');
    setProgress(100, 'Done');
    finishWithSummary(summary);
  } catch (err) {
    showGenerationFailure(err.message, rawFallbackText);
  }
}

function finishWithSummary(summary) {
  $('summary-text').value = summary;
  $('sent-heading').textContent = currentTicket ? `Ticket-ready work log for #${currentTicket}` : 'Ticket-ready work log';
  $('sent-eyebrow').textContent = `Summary generated · ${ls('summaryModel', 'ollama') === 'claude' ? 'Claude' : 'Ollama'}`;
  $('save-note').classList.add('hidden');
  setStage('sent');
}

// A generation failure stays visibly a failure. The raw-OCR opt-in is
// separately labeled and only ever surfaces text that has ALREADY passed
// through the redaction gate (mask-dropped words + scrubText).
function showGenerationFailure(message, fallbackText) {
  setProgress(100, `Generation failed: ${message}`);
  $('proc-eyebrow').textContent = 'Generation failed';
  const btn = $('btn-use-raw-text');
  if (!fallbackText) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.onclick = () => finishWithSummary(fallbackText);
}

// ─── Reset helpers ─────────────────────────────────────────────────────────
function resetToReady() {
  keyframes = [];
  activityTimelineText = '';
  reviewReady = false;
  reviewIndex = 0;
  interaction = null;
  draftRect = null;
  $('frame-count').textContent = '0';
  $('timer').textContent = '00:00';
  $('proc-eyebrow').textContent = 'Working';
  $('save-note').classList.add('hidden');
  setStage('ready');
}

// ═══════════════════════════════════════════════════════════════════════════
//  EVENT WIRING
// ═══════════════════════════════════════════════════════════════════════════

// Nav
$('nav-work').addEventListener('click', () => setScreen('work'));
$('nav-settings').addEventListener('click', () => setScreen('settings'));

// Coming-soon guards: any element flagged coming-soon does nothing on click.
document.querySelectorAll('.coming-soon').forEach(el => {
  el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
});

// Settings
$('btn-save-settings').addEventListener('click', () => { saveSettings(); setScreen('work'); });
$('btn-copy-transcript-snippet').addEventListener('click', async () => {
  const snippet = await ipcRenderer.invoke('events:get-transcript-snippet');
  await navigator.clipboard.writeText(snippet);
  const btn = $('btn-copy-transcript-snippet');
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = original; }, 1500);
});
// Model pickers — both the right rail and the Settings list use the same
// component. Disabled providers (ChatGPT/Gemini, coming soon) aren't selectable.
document.querySelectorAll('.model-item').forEach(el => {
  el.addEventListener('click', () => {
    if (el.classList.contains('is-disabled')) return;
    applySummaryModel(el.dataset.model);
  });
});

// Capture source tiles
$('src-window').addEventListener('click', () => selectSource('window'));
$('src-screen').addEventListener('click', () => selectSource('screen'));
function selectSource(kind) {
  captureSource = kind;
  $('src-window').classList.toggle('active', kind === 'window');
  $('src-screen').classList.toggle('active', kind === 'screen');
  $('window-picker').style.display = kind === 'window' ? 'flex' : 'none';
  // populateScreens re-shows #screen-picker itself when >1 display is attached.
  $('screen-picker').style.display = 'none';
  if (kind === 'window') populateWindows();
  else populateScreens();
}

// Start recording → countdown → capture
$('btn-start').addEventListener('click', () => {
  startCountdown();
});

function startCountdown() {
  setStage('countdown');
  $('countdown-overlay').classList.remove('hidden');
  $('countdown-sub').textContent = `Recording ${captureSource === 'window' ? 'the selected window' : 'the entire screen'} in…`;
  let n = 3;
  $('countdown-ring').textContent = n;
  clearInterval(countdownHandle);
  countdownHandle = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(countdownHandle);
      $('countdown-overlay').classList.add('hidden');
      beginRecording();
    } else {
      const ring = $('countdown-ring');
      ring.textContent = n;
      // retrigger the pop animation
      ring.style.animation = 'none';
      // eslint-disable-next-line no-unused-expressions
      ring.offsetHeight;
      ring.style.animation = '';
    }
  }, 800);
}
$('btn-cancel-countdown').addEventListener('click', () => {
  clearInterval(countdownHandle);
  $('countdown-overlay').classList.add('hidden');
  setStage('ready');
});

async function beginRecording() {
  try {
    await startCapture();
  } catch (err) {
    alert(`Could not start capture:\n${err.message}`);
    setStage('ready');
    return;
  }
  $('rec-title').textContent = currentTicket ? `Resolution recording · #${currentTicket}` : 'Resolution recording';
  $('frame-count').textContent = '0';
  $('timer').textContent = '00:00';
  $('rec-outline').classList.remove('hidden');
  $('rec-badge').classList.remove('hidden');
  startTimer();
  setStage('recording');

  ensureOCRWorker().catch(() => {});

  ipcRenderer.invoke('events:start', {
    window: ls('captureWindow', 'true') === 'true',
    transcript: ls('transcriptEnabled', 'false') === 'true',
  }).catch(() => {});
}

// Stop recording → analyze → review
$('btn-stop').addEventListener('click', async () => {
  stopCapture();
  stopTimer();
  $('rec-outline').classList.add('hidden');
  $('rec-badge').classList.add('hidden');
  $('duration-modal').classList.add('hidden');

  let rawEvents = [];
  try {
    rawEvents = await ipcRenderer.invoke('events:stop', {
      terminal: ls('captureTerminal', 'true') === 'true',
      browserHistory: ls('captureBrowser', 'true') === 'true',
    });
  } catch { rawEvents = []; }
  activityTimelineText = buildActivityTimelineText(scrubEvents(rawEvents));

  if (keyframes.length === 0) {
    alert('No keyframes were captured — the screen may not have changed enough.');
    setStage('ready');
    return;
  }

  setStage('review');
  renderReview();      // shows the scanning spinner
  analyzeFrames();     // async: OCR + auto-mask, then re-renders
});

// Duration warning dismiss (recording keeps running)
$('btn-dismiss-duration').addEventListener('click', () => $('duration-modal').classList.add('hidden'));

// Review controls
$('btn-prev-frame').addEventListener('click', () => { if (reviewIndex > 0) { reviewIndex--; resetZoom(); renderReview(); } });
$('btn-next-frame').addEventListener('click', () => { if (reviewIndex < keyframes.length - 1) { reviewIndex++; resetZoom(); renderReview(); } });
$('btn-remove-frame').addEventListener('click', () => { if (keyframes[reviewIndex]) { keyframes[reviewIndex].removed = true; renderReview(); } });
$('btn-restore-frame').addEventListener('click', () => { if (keyframes[reviewIndex]) { keyframes[reviewIndex].removed = false; renderReview(); } });
$('btn-generate').addEventListener('click', () => generateSummary());
$('btn-discard').addEventListener('click', () => {
  if (confirm('Discard this recording and return to the start?')) resetToReady();
});

// Zoom controls (buttons zoom about the centre; Fit / double-click reset).
$('zoom-in').addEventListener('click', () => setZoom(zoomLevel * 1.25));
$('zoom-out').addEventListener('click', () => setZoom(zoomLevel / 1.25));
$('zoom-fit').addEventListener('click', () => setZoom(1));
// Scroll-to-zoom, anchored on the cursor. Pan while zoomed via the scrollbars.
$('frame-stage').addEventListener('wheel', (e) => {
  if (!reviewReady) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  setZoom(zoomLevel * factor, e.clientX, e.clientY);
}, { passive: false });
// Double-click resets to fit.
$('frame-stage').addEventListener('dblclick', () => setZoom(1));

// draw-to-mask: pointer down on the empty overlay begins a draft
$('mask-overlay').addEventListener('mousedown', (e) => {
  if (e.target === $('mask-overlay')) beginDraw(e);
});
window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mouseup', onPointerUp);
window.addEventListener('resize', () => {
  if (document.body.dataset.stage === 'review' && reviewReady) renderReview();
});

// Sent controls
$('btn-save').addEventListener('click', async () => {
  const summary = $('summary-text').value.trim();
  if (!summary) return;
  const filename = `ticket-${currentTicket || 'general'}-${Date.now()}.txt`;
  // Deliberately no date/time in the note body or header (per spec).
  const content = [
    'Cardonet Capture — Work Note',
    '='.repeat(40),
    `Ticket:  #${currentTicket || '(none)'}`,
    '',
    summary,
    '',
  ].join('\n');
  const result = await ipcRenderer.invoke('save-summary', { filename, content });
  const note = $('save-note');
  if (!result.ok) {
    note.classList.remove('hidden');
    note.style.color = 'var(--cn-red)';
    note.textContent = `Save failed: ${result.error}`;
    return;
  }
  note.classList.remove('hidden');
  note.style.color = '';
  note.textContent = `Saved to ${result.path}`;
});
$('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('summary-text').value);
  const btn = $('btn-copy');
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = original; }, 1500);
});
$('btn-open-folder').addEventListener('click', () => ipcRenderer.invoke('open-folder'));
$('btn-new').addEventListener('click', () => { resetToReady(); });

// ─── Init ────────────────────────────────────────────────────────────────────
loadSettings();
selectSource('window');
setScreen('work');
setStage('ready');
