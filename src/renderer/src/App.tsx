// Port of renderer/app.js + renderer/index.html to React. "Port, not
// redesign": class names, ids-as-data-attributes, and the
// document.body.dataset.screen/.stage CSS-driven visibility mechanism are
// unchanged (see styles.css) -- every screen/stage stays mounted in the DOM
// at all times, same as the legacy app, and CSS alone decides what's visible.
// Highly imperative sections (capture, review/redact canvas) keep using
// refs for direct DOM/canvas access rather than being redesigned into
// "idiomatic React", matching the plan's port-not-redesign instruction.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import logoUrl from './assets/cardonet-logo.png';
import './styles.css';
import { aHash, hamming, type AHash } from './lib/hash';
import { buildActivityTimelineText } from './lib/activity';
import {
  DEFAULT_THRESHOLD,
  ls,
  set as setLs,
  loadTemplates,
  saveTemplates,
  getActiveTemplateId,
  setActiveTemplateId,
  activeTemplateContentForGenerate,
  type SummaryTemplate,
} from './lib/settings';
import { runOCR, ensureOCRWorker, type OcrWord } from './lib/ocr';
import { maskAndDownscale, type Mask } from './lib/redact';
import { scrubText, scrubEvents, findSensitiveWords } from './lib/scrub-timeline';
import type { ActivityEvent } from '../../shared/events';
import type { GenerateRequest, ProviderId } from '../../shared/generate';

const CAPTURE_INTERVAL_MS = 1500;
const MASK_PADDING_PX = 3;
const DURATION_WARNING_MS = 30 * 60 * 1000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

type Screen = 'work' | 'settings' | 'templates';
type Stage = 'ready' | 'countdown' | 'recording' | 'review' | 'processing' | 'sent';
type CaptureSource = 'window' | 'screen';
type SummaryModel = 'claude' | 'ollama';

function summaryModelLabel(model: SummaryModel): string {
  if (model === 'claude') return 'Claude';
  return 'Ollama';
}

interface SourceInfo {
  id: string;
  name: string;
  type: 'window' | 'screen';
  thumbnail: string;
}

interface Keyframe {
  timestamp: number;
  canvas: HTMLCanvasElement;
  ocrText: string;
  ocrWords: OcrWord[];
  masks: Mask[];
  removed: boolean;
}

interface Interaction {
  type: 'draw' | 'move' | 'resize';
  maskId?: string;
  handle?: string;
  dx?: number;
  dy?: number;
  x0?: number;
  y0?: number;
}

interface DraftRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// Compute the OCR text actually sent for a frame: any word whose bbox falls
// under a mask (auto OR user-drawn) is dropped, then the rest is scrubbed.
function maskedOcrText(kf: Keyframe): string {
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

function autoMasksFor(kf: Keyframe): Mask[] {
  const c = kf.canvas;
  return findSensitiveWords(kf.ocrWords).map((w, i) => {
    const x = Math.max(0, w.bbox.x0 - MASK_PADDING_PX);
    const y = Math.max(0, w.bbox.y0 - MASK_PADDING_PX);
    const wd = Math.min(c.width - x, w.bbox.x1 - w.bbox.x0 + MASK_PADDING_PX * 2);
    const ht = Math.min(c.height - y, w.bbox.y1 - w.bbox.y0 + MASK_PADDING_PX * 2);
    return { id: `auto-${kf.timestamp}-${i}`, x, y, w: wd, h: ht, auto: true };
  });
}

export default function App() {
  // ─── Screen / stage ───────────────────────────────────────────────────
  const [screen, setScreenState] = useState<Screen>('work');
  const [stage, setStageState] = useState<Stage>('ready');
  const setScreen = useCallback((s: Screen) => setScreenState(s), []);
  const setStage = useCallback((s: Stage) => setStageState(s), []);

  useEffect(() => {
    document.body.dataset.screen = screen;
  }, [screen]);
  useEffect(() => {
    document.body.dataset.stage = stage;
  }, [stage]);

  // ─── Settings ───────────────────────────────────────────────────────────
  const [ollamaUrl, setOllamaUrl] = useState(() => ls('ollamaUrl', 'http://localhost:11434'));
  const [vlmModel, setVlmModel] = useState(() => ls('vlmModel', 'llava'));
  const [textModel, setTextModel] = useState(() => ls('textModel', 'llama3'));
  const [threshold, setThreshold] = useState(() => ls('threshold', String(DEFAULT_THRESHOLD)));
  const [captureWindowEnabled, setCaptureWindowEnabled] = useState(() => ls('captureWindow', 'true') === 'true');
  const [captureTerminalEnabled, setCaptureTerminalEnabled] = useState(() => ls('captureTerminal', 'true') === 'true');
  const [captureBrowserEnabled, setCaptureBrowserEnabled] = useState(() => ls('captureBrowser', 'true') === 'true');
  const [transcriptEnabled, setTranscriptEnabled] = useState(() => ls('transcriptEnabled', 'false') === 'true');
  const [clientNames, setClientNames] = useState(() => ls('scrubClientNames', ''));
  const [summaryModel, setSummaryModelState] = useState<SummaryModel>(() => {
    const stored = ls('summaryModel', 'ollama');
    return stored === 'claude' ? stored : 'ollama';
  });
  const [transcriptSnippetCopied, setTranscriptSnippetCopied] = useState(false);

  const applySummaryModel = useCallback((id: SummaryModel) => {
    setLs('summaryModel', id);
    setSummaryModelState(id);
  }, []);

  const saveSettings = useCallback(() => {
    setLs('ollamaUrl', ollamaUrl.trim());
    setLs('vlmModel', vlmModel.trim());
    setLs('textModel', textModel.trim());
    setLs('threshold', threshold.trim());
    setLs('captureWindow', String(captureWindowEnabled));
    setLs('captureTerminal', String(captureTerminalEnabled));
    setLs('captureBrowser', String(captureBrowserEnabled));
    setLs('transcriptEnabled', String(transcriptEnabled));
    setLs('scrubClientNames', clientNames.trim());
  }, [ollamaUrl, vlmModel, textModel, threshold, captureWindowEnabled, captureTerminalEnabled, captureBrowserEnabled, transcriptEnabled, clientNames]);

  const copyTranscriptSnippet = useCallback(async () => {
    const snippet = await window.cardonetCapture.getTranscriptSnippet();
    await navigator.clipboard.writeText(snippet);
    setTranscriptSnippetCopied(true);
    setTimeout(() => setTranscriptSnippetCopied(false), 1500);
  }, []);

  // ─── Summary templates ────────────────────────────────────────────────
  const [templates, setTemplatesState] = useState<SummaryTemplate[]>(() => loadTemplates());
  const [activeTemplateId, setActiveTemplateIdState] = useState(() => getActiveTemplateId());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tplTitle, setTplTitle] = useState('');
  const [tplContent, setTplContent] = useState('');
  const [tplTitleError, setTplTitleError] = useState(false);
  const [tplFileNote, setTplFileNote] = useState('');
  const tplFileInputRef = useRef<HTMLInputElement | null>(null);

  const openTemplateEditor = useCallback((id: string | null) => {
    const t = templates.find(x => x.id === id);
    setEditingId(t ? t.id : null);
    setTplTitle(t ? t.title : '');
    setTplContent(t ? t.content : '');
    setTplTitleError(false);
    setTplFileNote('');
  }, [templates]);

  const selectTemplate = useCallback((id: string) => {
    setActiveTemplateId(id);
    setActiveTemplateIdState(id);
  }, []);

  const saveTemplate = useCallback(() => {
    const title = tplTitle.trim();
    if (!title) {
      setTplTitleError(true);
      return;
    }
    const list = loadTemplates();
    let nextEditingId = editingId;
    if (editingId) {
      const t = list.find(x => x.id === editingId);
      if (t) {
        t.title = title;
        t.content = tplContent;
      }
    } else {
      const id = `tpl-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
      list.push({ id, title, content: tplContent });
      nextEditingId = id;
      setActiveTemplateId(id);
      setActiveTemplateIdState(id);
    }
    saveTemplates(list);
    setTemplatesState(list);
    setEditingId(nextEditingId);
    setTplFileNote('Saved');
    setTimeout(() => setTplFileNote(n => (n === 'Saved' ? '' : n)), 1500);
  }, [tplTitle, tplContent, editingId]);

  const deleteTemplate = useCallback((id: string) => {
    if (!confirm('Delete this template?')) return;
    const list = loadTemplates().filter(x => x.id !== id);
    saveTemplates(list);
    setTemplatesState(list);
    if (getActiveTemplateId() === id) {
      setActiveTemplateId('');
      setActiveTemplateIdState('');
    }
    if (editingId === id) openTemplateEditor(null);
  }, [editingId, openTemplateEditor]);

  const loadTemplateFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    let text = '';
    try { text = await file.text(); } catch { text = ''; }
    setTplContent(text);
    setTplTitle(prev => {
      if (prev.trim()) return prev;
      setTplTitleError(false);
      return file.name.replace(/\.(md|markdown|txt)$/i, '');
    });
    setTplFileNote(`Loaded ${file.name}`);
  }, []);

  // ─── Recording state (refs: mutable, non-reactive across callbacks) ────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHashRef = useRef<AHash | null>(null);
  const startTimeRef = useRef(0);
  const durationWarnedRef = useRef(false);
  const keyframesRef = useRef<Keyframe[]>([]);
  const activityTimelineTextRef = useRef('');
  const currentTicket = ''; // no UI sets this yet; preserved from legacy (always '')

  const [captureSource, setCaptureSource] = useState<CaptureSource>('window');
  const [windowSources, setWindowSources] = useState<SourceInfo[]>([]);
  const [windowSourceId, setWindowSourceId] = useState('');
  const [windowSourcesError, setWindowSourcesError] = useState<string | null>(null);
  const [screenSources, setScreenSources] = useState<SourceInfo[]>([]);
  const [screenSourceId, setScreenSourceId] = useState('');
  const [screenSourcesError, setScreenSourcesError] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [timerText, setTimerText] = useState('00:00');
  const [recTitle, setRecTitle] = useState('Resolution recording');
  const [recordingOverlayVisible, setRecordingOverlayVisible] = useState(false);
  const [durationModalVisible, setDurationModalVisible] = useState(false);
  const [countdownN, setCountdownN] = useState(3);

  const populateWindows = useCallback(async () => {
    try {
      const sources = await window.cardonetCapture.getSources({ types: ['window'] });
      setWindowSources(sources);
      setWindowSourcesError(sources.length ? null : 'No capturable windows found');
      if (sources.length) setWindowSourceId(prev => (sources.some((s: SourceInfo) => s.id === prev) ? prev : sources[0].id));
    } catch {
      setWindowSources([]);
      setWindowSourcesError('Could not list windows');
    }
  }, []);

  const populateScreens = useCallback(async () => {
    try {
      const sources = await window.cardonetCapture.getSources({ types: ['screen'] });
      if (!sources.length) {
        setScreenSources([]);
        setScreenSourcesError('No displays found');
        return;
      }
      setScreenSources(sources);
      setScreenSourcesError(null);
      setScreenSourceId(prev => {
        if (prev && sources.some((s: SourceInfo) => s.id === prev)) return prev;
        const primary = sources.find((s: SourceInfo) => / · Primary$/.test(s.name));
        return (primary || sources[0]).id;
      });
    } catch {
      setScreenSources([]);
      setScreenSourcesError('Could not list displays');
    }
  }, []);

  const selectSource = useCallback((kind: CaptureSource) => {
    setCaptureSource(kind);
    if (kind === 'window') populateWindows();
    else populateScreens();
  }, [populateWindows, populateScreens]);

  useEffect(() => {
    selectSource('window');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveSourceId = useCallback(async (): Promise<string> => {
    if (captureSource === 'window') {
      if (windowSourceId) return windowSourceId;
      const wins = await window.cardonetCapture.getSources({ types: ['window'] });
      if (wins.length) return wins[0].id;
      throw new Error('No capturable window is available. Try "Entire screen" instead.');
    }
    if (screenSourceId) return screenSourceId;
    const screens = await window.cardonetCapture.getSources({ types: ['screen'] });
    if (!screens.length) throw new Error('No screen sources found.');
    return screens[0].id;
  }, [captureSource, windowSourceId, screenSourceId]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(video, 0, 0);

    const hash = aHash(canvas);
    let thr = parseInt(ls('threshold', String(DEFAULT_THRESHOLD)), 10);
    if (!Number.isFinite(thr)) thr = DEFAULT_THRESHOLD;
    thr = Math.max(0, Math.min(10, thr));

    if (!lastHashRef.current || hamming(hash, lastHashRef.current) > thr) {
      lastHashRef.current = hash;
      keyframesRef.current.push({ timestamp: Date.now(), canvas, ocrText: '', ocrWords: [], masks: [], removed: false });
      setFrameCount(keyframesRef.current.length);
    }
  }, []);

  const startCapture = useCallback(async () => {
    const sourceId = await resolveSourceId();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 2,
        },
      },
    } as MediaStreamConstraints);
    streamRef.current = stream;
    const video = videoRef.current!;
    video.srcObject = stream;
    await new Promise<void>(res => { video.onloadedmetadata = () => res(); });
    video.play();

    keyframesRef.current = [];
    lastHashRef.current = null;
    captureHandleRef.current = setInterval(captureFrame, CAPTURE_INTERVAL_MS);
  }, [resolveSourceId, captureFrame]);

  const stopCapture = useCallback(() => {
    if (captureHandleRef.current) clearInterval(captureHandleRef.current);
    captureHandleRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    durationWarnedRef.current = false;
    timerHandleRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const s = Math.floor(elapsed / 1000);
      const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      setTimerText(text);
      if (!durationWarnedRef.current && elapsed >= DURATION_WARNING_MS) {
        durationWarnedRef.current = true;
        setDurationModalVisible(true);
      }
    }, 1000);
  }, []);
  const stopTimer = useCallback(() => {
    if (timerHandleRef.current) clearInterval(timerHandleRef.current);
    timerHandleRef.current = null;
  }, []);

  const beginRecording = useCallback(async () => {
    try {
      await startCapture();
    } catch (err) {
      alert(`Could not start capture:\n${(err as Error).message}`);
      setStage('ready');
      return;
    }
    setRecTitle(currentTicket ? `Resolution recording · #${currentTicket}` : 'Resolution recording');
    setFrameCount(0);
    setTimerText('00:00');
    setRecordingOverlayVisible(true);
    startTimer();
    setStage('recording');

    ensureOCRWorker().catch(() => {});

    window.cardonetCapture.eventsStart({
      window: ls('captureWindow', 'true') === 'true',
      transcript: ls('transcriptEnabled', 'false') === 'true',
    }).catch(() => {});
  }, [startCapture, startTimer, setStage]);

  const startCountdown = useCallback(() => {
    setStage('countdown');
    let n = 3;
    setCountdownN(n);
    if (countdownHandleRef.current) clearInterval(countdownHandleRef.current);
    countdownHandleRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        if (countdownHandleRef.current) clearInterval(countdownHandleRef.current);
        beginRecording();
      } else {
        setCountdownN(n);
      }
    }, 800);
  }, [beginRecording, setStage]);

  const cancelCountdown = useCallback(() => {
    if (countdownHandleRef.current) clearInterval(countdownHandleRef.current);
    setStage('ready');
  }, [setStage]);

  // ─── Review & redact ────────────────────────────────────────────────────
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewReady, setReviewReady] = useState(false);
  const [reviewTick, setReviewTick] = useState(0); // bump to force a re-render after mutating keyframesRef in place
  const bumpReview = useCallback(() => setReviewTick(t => t + 1), []);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [scanningLabel, setScanningLabel] = useState('');

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskOverlayRef = useRef<HTMLDivElement | null>(null);
  const frameStageRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const draftRectRef = useRef<DraftRect | null>(null);
  const boxRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const liveKeyframes = useMemo(() => keyframesRef.current.filter(kf => !kf.removed), [reviewTick]);
  const currentKf = keyframesRef.current[reviewIndex];

  const totalMaskCount = useCallback(() => {
    return keyframesRef.current.reduce((n, kf) => n + (kf.removed ? 0 : kf.masks.length), 0);
  }, []);

  const fitScale = useCallback((kf: Keyframe): number => {
    const stage_ = frameStageRef.current;
    if (!stage_) return 1;
    const maxW = stage_.clientWidth;
    const maxH = stage_.clientHeight;
    return Math.min(maxW / kf.canvas.width, maxH / kf.canvas.height, 1) || 1;
  }, []);

  const burnPreview = useCallback((kf: Keyframe) => {
    const src = kf.canvas;
    const effScale = fitScale(kf) * zoomLevel;
    const dw = Math.max(1, Math.round(src.width * effScale));
    const dh = Math.max(1, Math.round(src.height * effScale));
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(src, 0, 0, dw, dh);
    ctx.fillStyle = '#18161E';
    for (const m of kf.masks) {
      ctx.fillRect(m.x * effScale, m.y * effScale, m.w * effScale, m.h * effScale);
    }
  }, [fitScale, zoomLevel]);

  const positionOverlay = useCallback(() => {
    const canvas = previewCanvasRef.current;
    const overlay = maskOverlayRef.current;
    if (!canvas || !overlay) return;
    overlay.style.left = canvas.offsetLeft + 'px';
    overlay.style.top = canvas.offsetTop + 'px';
    overlay.style.width = canvas.offsetWidth + 'px';
    overlay.style.height = canvas.offsetHeight + 'px';
  }, []);

  // Re-burn/reposition whenever the visible frame, its masks, or zoom change.
  useEffect(() => {
    if (!reviewReady || !currentKf || currentKf.removed) return;
    burnPreview(currentKf);
    positionOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewReady, reviewIndex, reviewTick, zoomLevel, currentKf, burnPreview, positionOverlay]);

  const resetZoom = useCallback(() => setZoomLevel(1), []);

  const analyzeFrames = useCallback(async () => {
    setReviewReady(false);
    const kfs = keyframesRef.current;
    for (let i = 0; i < kfs.length; i++) {
      setScanningLabel(`Scanning frame ${i + 1} of ${kfs.length} for sensitive data…`);
      const { text, words } = await runOCR(kfs[i].canvas);
      kfs[i].ocrText = scrubText(text);
      kfs[i].ocrWords = words;
      kfs[i].masks = autoMasksFor(kfs[i]);
    }
    setReviewReady(true);
    setReviewIndex(0);
    resetZoom();
    bumpReview();
  }, [resetZoom, bumpReview]);

  const pointerToCanvas = useCallback((e: { clientX: number; clientY: number }) => {
    const kf = keyframesRef.current[reviewIndex];
    const overlay = maskOverlayRef.current!;
    const rect = overlay.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * kf.canvas.width;
    const y = (e.clientY - rect.top) / rect.height * kf.canvas.height;
    return {
      x: Math.max(0, Math.min(kf.canvas.width, x)),
      y: Math.max(0, Math.min(kf.canvas.height, y)),
    };
  }, [reviewIndex]);

  const applyBoxGeometry = useCallback((box: HTMLDivElement, m: Mask, cw: number, ch: number) => {
    box.style.left = (m.x / cw * 100) + '%';
    box.style.top = (m.y / ch * 100) + '%';
    box.style.width = (m.w / cw * 100) + '%';
    box.style.height = (m.h / ch * 100) + '%';
  }, []);

  const renderDraft = useCallback(() => {
    const overlay = maskOverlayRef.current;
    if (!overlay) return;
    let el = overlay.querySelector<HTMLDivElement>('.mask-draft');
    const d = draftRectRef.current;
    if (!d) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'mask-draft';
      overlay.appendChild(el);
    }
    const kf = keyframesRef.current[reviewIndex];
    el.style.left = (d.x / kf.canvas.width * 100) + '%';
    el.style.top = (d.y / kf.canvas.height * 100) + '%';
    el.style.width = (d.w / kf.canvas.width * 100) + '%';
    el.style.height = (d.h / kf.canvas.height * 100) + '%';
    burnPreview(kf);
  }, [reviewIndex, burnPreview]);

  const beginDraw = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = pointerToCanvas(e);
    interactionRef.current = { type: 'draw', x0: p.x, y0: p.y };
    draftRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
    renderDraft();
  }, [pointerToCanvas, renderDraft]);

  const beginMove = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const kf = keyframesRef.current[reviewIndex];
    const m = kf.masks.find(x => x.id === id)!;
    const p = pointerToCanvas(e);
    interactionRef.current = { type: 'move', maskId: id, dx: p.x - m.x, dy: p.y - m.y };
  }, [reviewIndex, pointerToCanvas]);

  const beginResize = useCallback((e: React.MouseEvent, id: string, handle: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    interactionRef.current = { type: 'resize', maskId: id, handle };
  }, []);

  const onPointerMove = useCallback((e: MouseEvent) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const kf = keyframesRef.current[reviewIndex];
    if (!kf) return;
    const cw = kf.canvas.width, ch = kf.canvas.height;
    const p = pointerToCanvas(e);
    const MIN = Math.max(6, cw * 0.01);

    if (interaction.type === 'draw') {
      draftRectRef.current = {
        x: Math.min(interaction.x0!, p.x),
        y: Math.min(interaction.y0!, p.y),
        w: Math.abs(p.x - interaction.x0!),
        h: Math.abs(p.y - interaction.y0!),
      };
      renderDraft();
      return;
    }

    const m = kf.masks.find(x => x.id === interaction.maskId);
    if (!m) return;

    if (interaction.type === 'move') {
      m.x = Math.max(0, Math.min(cw - m.w, p.x - interaction.dx!));
      m.y = Math.max(0, Math.min(ch - m.h, p.y - interaction.dy!));
    } else if (interaction.type === 'resize') {
      const h = interaction.handle!;
      let x = m.x, y = m.y, w = m.w, ht = m.h;
      const right = x + w, bottom = y + ht;
      if (h.includes('w')) { x = Math.min(p.x, right - MIN); w = right - x; }
      if (h.includes('e')) { w = Math.max(MIN, Math.min(cw, p.x) - x); }
      if (h.includes('n')) { y = Math.min(p.y, bottom - MIN); ht = bottom - y; }
      if (h.includes('s')) { ht = Math.max(MIN, Math.min(ch, p.y) - y); }
      m.x = Math.max(0, x); m.y = Math.max(0, y);
      m.w = Math.min(cw - m.x, w); m.h = Math.min(ch - m.y, ht);
    }

    const box = boxRefs.current.get(m.id);
    if (box) applyBoxGeometry(box, m, cw, ch);
    burnPreview(kf);
  }, [reviewIndex, pointerToCanvas, renderDraft, applyBoxGeometry, burnPreview]);

  const onPointerUp = useCallback(() => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    if (interaction.type === 'draw') {
      const kf = keyframesRef.current[reviewIndex];
      const d = draftRectRef.current;
      const MIN = Math.max(6, kf.canvas.width * 0.01);
      if (d && d.w > MIN && d.h > MIN) {
        kf.masks.push({ id: `user-${Date.now()}`, x: d.x, y: d.y, w: d.w, h: d.h, auto: false });
      }
      draftRectRef.current = null;
      interactionRef.current = null;
      renderDraft();
      bumpReview();
      return;
    }
    interactionRef.current = null;
    bumpReview();
  }, [reviewIndex, renderDraft, bumpReview]);

  useEffect(() => {
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    return () => {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  useEffect(() => {
    const onResize = () => { if (stage === 'review' && reviewReady) bumpReview(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [stage, reviewReady, bumpReview]);

  const deleteMask = useCallback((maskId: string) => {
    const kf = keyframesRef.current[reviewIndex];
    kf.masks = kf.masks.filter(x => x.id !== maskId);
    bumpReview();
  }, [reviewIndex, bumpReview]);

  const setZoom = useCallback((newZoom: number, anchorClientX?: number, anchorClientY?: number) => {
    const kf = keyframesRef.current[reviewIndex];
    if (!reviewReady || !kf || kf.removed) return;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    const stage_ = frameStageRef.current;
    const canvas = previewCanvasRef.current;
    if (!stage_ || !canvas) return;
    const rect = stage_.getBoundingClientRect();
    const ax = (anchorClientX == null ? rect.left + stage_.clientWidth / 2 : anchorClientX) - rect.left;
    const ay = (anchorClientY == null ? rect.top + stage_.clientHeight / 2 : anchorClientY) - rect.top;
    const oldW = canvas.width || 1, oldH = canvas.height || 1;
    const fx = (stage_.scrollLeft + ax) / oldW;
    const fy = (stage_.scrollTop + ay) / oldH;

    setZoomLevel(z);
    // burnPreview/positionOverlay re-run via the effect above once zoomLevel
    // commits; scroll restoration needs the NEW canvas size, so defer one tick.
    requestAnimationFrame(() => {
      stage_.scrollLeft = fx * (canvas.width || oldW) - ax;
      stage_.scrollTop = fy * (canvas.height || oldH) - ay;
    });
  }, [reviewIndex, reviewReady]);

  const goToFrame = useCallback((i: number) => {
    setReviewIndex(i);
    resetZoom();
  }, [resetZoom]);

  const removeFrame = useCallback(() => {
    const kf = keyframesRef.current[reviewIndex];
    if (kf) { kf.removed = true; bumpReview(); }
  }, [reviewIndex, bumpReview]);
  const restoreFrame = useCallback(() => {
    const kf = keyframesRef.current[reviewIndex];
    if (kf) { kf.removed = false; bumpReview(); }
  }, [reviewIndex, bumpReview]);

  // ─── Generation pipeline ────────────────────────────────────────────────
  const [procStates, setProcStates] = useState<Array<'pending' | 'active' | 'done'>>(['pending', 'pending', 'pending', 'pending']);
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState('Starting…');
  const [procEyebrow, setProcEyebrow] = useState('Working');
  const [rawTextFallback, setRawTextFallback] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState('');
  const [sentHeading, setSentHeading] = useState('Ticket-ready work log');
  const [sentEyebrow, setSentEyebrow] = useState('Summary generated');
  const [saveNote, setSaveNote] = useState<{ text: string; isError: boolean } | null>(null);

  const procStep = useCallback((index: number, state?: 'done') => {
    setProcStates(prev => prev.map((_, n) => (n < index ? 'done' : n === index ? (state === 'done' ? 'done' : 'active') : 'pending')));
  }, []);
  const resetProcSteps = useCallback(() => setProcStates(['pending', 'pending', 'pending', 'pending']), []);
  const setProgress = useCallback((pct: number, label?: string) => {
    setProgressPct(Math.max(0, Math.min(100, Math.round(pct))));
    if (label) setProgressLabel(label);
  }, []);

  const finishWithSummary = useCallback((summary: string) => {
    setSummaryText(summary);
    setSentHeading(currentTicket ? `Ticket-ready work log for #${currentTicket}` : 'Ticket-ready work log');
    setSentEyebrow(`Summary generated · ${summaryModelLabel(summaryModel)}`);
    setSaveNote(null);
    setStage('sent');
  }, [summaryModel, setStage]);

  const showGenerationFailure = useCallback((message: string, fallbackText: string) => {
    setProgress(100, `Generation failed: ${message}`);
    setProcEyebrow('Generation failed');
    setRawTextFallback(fallbackText || null);
  }, [setProgress]);

  const generateSummary = useCallback(async () => {
    const live = keyframesRef.current.filter(kf => !kf.removed);
    if (!live.length) {
      alert('Every frame has been removed — there is nothing to send. Keep at least one frame or discard the recording.');
      return;
    }

    setStage('processing');
    resetProcSteps();
    setRawTextFallback(null);
    setProcEyebrow('Working');

    procStep(0, 'done');
    setProgress(15, 'On-screen text already read');

    procStep(1);
    setProgress(30, 'Applying redaction masks to frames');
    const sendFrames = live.map(kf => ({
      timestamp: kf.timestamp,
      dataUrl: maskAndDownscale(kf.canvas, kf.masks),
      ocrText: maskedOcrText(kf),
    }));
    const rawFallbackText = sendFrames.map(f => f.ocrText).filter(Boolean).join('\n\n');
    procStep(1, 'done');

    // Free full-res canvases now -- review is over.
    keyframesRef.current = [];

    procStep(2);
    setProgress(45, `Sending redacted frames to ${summaryModelLabel(summaryModel)}`);

    try {
      const request: GenerateRequest = {
        provider: summaryModel as ProviderId,
        frames: sendFrames,
        activityTimelineText: activityTimelineTextRef.current,
        templateContent: activeTemplateContentForGenerate(),
        ollama: summaryModel === 'ollama' ? { url: ls('ollamaUrl', 'http://localhost:11434'), vlmModel: ls('vlmModel', 'llava'), textModel: ls('textModel', 'llama3') } : undefined,
      };
      const summary = await window.cardonetCapture.generate(request);
      procStep(2, 'done');
      procStep(3, 'done');
      setProgress(100, 'Done');
      finishWithSummary(summary);
    } catch (err) {
      procStep(2);
      setProgress(80, 'Generation failed');
      showGenerationFailure((err as Error).message, rawFallbackText);
    }
  }, [summaryModel, resetProcSteps, procStep, setProgress, finishWithSummary, showGenerationFailure, setStage]);

  const useRawTextInstead = useCallback(() => {
    if (rawTextFallback) finishWithSummary(rawTextFallback);
  }, [rawTextFallback, finishWithSummary]);

  // ─── Reset ──────────────────────────────────────────────────────────────
  const resetToReady = useCallback(() => {
    keyframesRef.current = [];
    activityTimelineTextRef.current = '';
    setReviewReady(false);
    setReviewIndex(0);
    interactionRef.current = null;
    draftRectRef.current = null;
    setFrameCount(0);
    setTimerText('00:00');
    setProcEyebrow('Working');
    setSaveNote(null);
    setStage('ready');
  }, [setStage]);

  const onStop = useCallback(async () => {
    stopCapture();
    stopTimer();
    setRecordingOverlayVisible(false);
    setDurationModalVisible(false);

    let rawEvents: ActivityEvent[] = [];
    try {
      rawEvents = await window.cardonetCapture.eventsStop({
        terminal: ls('captureTerminal', 'true') === 'true',
        browserHistory: ls('captureBrowser', 'true') === 'true',
      });
    } catch { rawEvents = []; }
    activityTimelineTextRef.current = buildActivityTimelineText(scrubEvents(rawEvents));

    if (keyframesRef.current.length === 0) {
      alert('No keyframes were captured — the screen may not have changed enough.');
      setStage('ready');
      return;
    }

    setStage('review');
    setReviewReady(false);
    analyzeFrames();
  }, [stopCapture, stopTimer, analyzeFrames, setStage]);

  const onSave = useCallback(async () => {
    const summary = summaryText.trim();
    if (!summary) return;
    const filename = `ticket-${currentTicket || 'general'}-${Date.now()}.txt`;
    const content = [
      'Cardonet Capture — Work Note',
      '='.repeat(40),
      `Ticket:  #${currentTicket || '(none)'}`,
      '',
      summary,
      '',
    ].join('\n');
    const result = await window.cardonetCapture.saveSummary({ filename, content });
    if (!('ok' in result) || !result.ok) {
      setSaveNote({ text: `Save failed: ${(result as { error?: string }).error}`, isError: true });
      return;
    }
    setSaveNote({ text: `Saved to ${(result as { path?: string }).path}`, isError: false });
  }, [summaryText]);

  const [copiedSummary, setCopiedSummary] = useState(false);
  const onCopySummary = useCallback(async () => {
    await navigator.clipboard.writeText(summaryText);
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 1500);
  }, [summaryText]);

  // ─── Derived UI values ──────────────────────────────────────────────────
  const stepperActive = stage === 'review' ? 1 : stage === 'processing' || stage === 'sent' ? 2 : 0;
  const stepperAllDone = stage === 'sent';
  const screenPickerVisible = captureSource === 'screen' && screenSources.length > 1;

  return (
    <div id="app">
      {/* ── Titlebar ──────────────────────────────────────────────────── */}
      <div className="titlebar">
        <div className="tb-brand">
          <img className="brand-logo" src={logoUrl} alt="Cardonet" />
          <span className="brand-sep" />
          <span className="brand-sub">Capture</span>
        </div>
        <div className="tb-gradient" />
        <button className="tb-halo is-disabled coming-soon" data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>
          <span className="dot" /><span>HaloPSA not connected</span>
        </button>
      </div>

      {/* ── Workspace ─────────────────────────────────────────────────── */}
      <div className="workspace">
        <aside className="sidebar">
          <div className="side-head"><span className="label">Assigned Tickets</span></div>
          <div className="side-tickets">
            <div className="empty-card">
              <div className="title">No tickets yet</div>
              <p>Connect HaloPSA to pull in the tickets assigned to you. You can record and generate summaries without it.</p>
              <button className="btn btn-pink btn-sm coming-soon is-disabled" style={{ width: '100%', boxShadow: 'none' }} data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>Connect HaloPSA</button>
            </div>
          </div>
          <nav className="side-nav">
            <button className={`nav-item${screen === 'work' ? ' active' : ''}`} onClick={() => setScreen('work')}>New Recording</button>
            <button className={`nav-item${screen === 'templates' ? ' active' : ''}`} onClick={() => { openTemplateEditor(null); setScreen('templates'); }}>Summary Templates</button>
            <button className={`nav-item${screen === 'settings' ? ' active' : ''}`} onClick={() => setScreen('settings')}>Settings</button>
          </nav>
          <div className="side-identity">
            <span className="avatar">○</span>
            <div className="who">Not connected to<br />HaloPSA</div>
          </div>
        </aside>

        <div className="content">
          <div className="stepper" id="stepper">
            <div className={`step${stepperActive > 0 || stepperAllDone ? ' done' : ''}${stepperActive === 0 && !stepperAllDone ? ' active' : ''}`} data-step="0"><span className="step-num">1</span><span className="step-label">Record</span></div>
            <span className="step-arrow">→</span>
            <div className={`step${stepperActive > 1 || stepperAllDone ? ' done' : ''}${stepperActive === 1 && !stepperAllDone ? ' active' : ''}`} data-step="1"><span className="step-num">2</span><span className="step-label">Review</span></div>
            <span className="step-arrow">→</span>
            <div className={`step${stepperAllDone ? ' done' : ''}${stepperActive === 2 && !stepperAllDone ? ' active' : ''}`} data-step="2"><span className="step-num">3</span><span className="step-label">Summary</span></div>
          </div>

          <div className="screen-work">
            <div className="work-main">
              {/* ---- READY ---- */}
              <section className="stage stage-ready">
                <div>
                  <div className="eyebrow">New Resolution Recording</div>
                  <h4 className="title">Record a fix, get a ticket-ready summary</h4>
                  <p className="hero-note">Choose what to capture, then start recording!</p>
                </div>
                <div className="spacer" />
                <div className="setup-card">
                  <div>
                    <span className="setup-label">Capture Source</span>
                    <div className="source-grid">
                      <button className={`source-tile${captureSource === 'window' ? ' active' : ''}`} onClick={() => selectSource('window')}>
                        <span className="badge">Recommended</span>
                        <span className="source-ico" />
                        <div className="name">Single window</div>
                        <div className="desc">One app only - sharper detection, no wallpaper or other windows in frame.</div>
                      </button>
                      <button className={`source-tile${captureSource === 'screen' ? ' active' : ''}`} onClick={() => selectSource('screen')}>
                        <span className="source-ico" />
                        <div className="name">Entire screen</div>
                        <div className="desc">The whole desktop, including other windows and notifications.</div>
                      </button>
                    </div>
                    {captureSource === 'window' && (
                      <div className="window-picker" id="window-picker">
                        <span className="ico"><span /></span>
                        <div className="meta">
                          <div className="cap">Window to capture</div>
                          <select id="window-select" value={windowSourceId} onChange={e => setWindowSourceId(e.target.value)}>
                            {windowSourcesError ? <option value="">{windowSourcesError}</option> : windowSources.map(s => <option key={s.id} value={s.id}>{escapeHtml(s.name || s.id)}</option>)}
                          </select>
                        </div>
                      </div>
                    )}
                    {screenPickerVisible && (
                      <div className="window-picker" id="screen-picker">
                        <span className="ico"><span /></span>
                        <div className="meta">
                          <div className="cap">Display to record</div>
                          <select id="screen-select" value={screenSourceId} onChange={e => setScreenSourceId(e.target.value)}>
                            {screenSourcesError ? <option value="">{screenSourcesError}</option> : screenSources.map(s => <option key={s.id} value={s.id}>{escapeHtml(s.name || s.id)}</option>)}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="start-row">
                    <div className="protect-inline">
                      <span className="check">✓</span>
                      Sensitive data is detected and masked automatically, and you confirm redaction before anything is sent.
                    </div>
                    <button className="btn btn-pink btn-lg" onClick={startCountdown}>
                      <span className="btn-rec-dot" />Start Recording
                    </button>
                  </div>
                </div>
              </section>

              {/* ---- RECORDING ---- */}
              <section className="stage stage-recording">
                <div className="eyebrow red">● Recording</div>
                <h4 className="title">{recTitle}</h4>
                <div className="spacer" />
                <div className="rec-center">
                  <span className="rec-pulse" />
                  <div className="rec-timer mono">{timerText}</div>
                  <div className="rec-sub">Capturing keyframes · sensitive data masked on the fly</div>
                  <div className="rec-preview"><video ref={videoRef} muted autoPlay playsInline /></div>
                  <div className="rec-stat-row">
                    <div className="rec-stat"><div className="v mono">{frameCount}</div><div className="k">keyframes</div></div>
                  </div>
                </div>
                <div className="spacer" />
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button className="btn btn-dark btn-lg" onClick={onStop}><span className="btn-stop-sq" />Stop &amp; review</button>
                </div>
              </section>

              {/* ---- REVIEW ---- */}
              <section className="stage stage-review">
                <div className="review-top">
                  <div style={{ flex: 1 }}>
                    <div className="eyebrow">Confirm Redaction</div>
                    <h4 className="title">Review</h4>
                    <p className="subnote" style={{ margin: '8px 0 0', maxWidth: 560 }}>Check every captured frame, drag to mask anything the automatic pass missed, and adjust or remove any frame before they reach the model.</p>
                  </div>
                  <span className="masked-badge"><span>{totalMaskCount()}</span> regions masked</span>
                </div>

                <div className="frame-card">
                  <div className="frame-card-head">
                    <span className="cap">CAPTURED FRAMES · redacted preview</span>
                    <div className="zoom-controls">
                      <button type="button" className="zoom-btn" aria-label="Zoom out" title="Zoom out" disabled={zoomLevel <= MIN_ZOOM + 1e-3} onClick={() => setZoom(zoomLevel / 1.25)}>−</button>
                      <span className="zoom-label" title="Scroll to zoom · drag scrollbars to pan · double-click to reset">{Math.round(zoomLevel * 100)}%</span>
                      <button type="button" className="zoom-btn" aria-label="Zoom in" title="Zoom in" disabled={zoomLevel >= MAX_ZOOM - 1e-3} onClick={() => setZoom(zoomLevel * 1.25)}>+</button>
                      <button type="button" className="zoom-btn zoom-fit" disabled={zoomLevel === 1} onClick={() => setZoom(1)}>Fit</button>
                    </div>
                    <span className="pos">Frame {keyframesRef.current.length ? reviewIndex + 1 : 0} of {keyframesRef.current.length}</span>
                  </div>
                  <div className="draw-hint">
                    <span className="ico" />
                    <span><b>Drag on the frame</b> to mask anything the automatic pass missed. <span className="pink">Pink</span> boxes were detected automatically, <span className="navy">dashed</span> boxes are yours. Drag any box to move it, pull a corner to resize, or ✕ to remove it.</span>
                  </div>

                  <div className="frame-surface">
                    <div className="frame-titlebar">
                      <span className="dot" />
                      <span className="ttl">{reviewReady && currentKf ? `Keyframe ${reviewIndex + 1} · ${new Date(currentKf.timestamp).toLocaleTimeString()}` : 'Frame'}</span>
                      <button className="remove-frame-btn" onClick={removeFrame}><span style={{ fontSize: 12, lineHeight: 1 }}>✕</span>Remove this frame</button>
                    </div>
                    <div className="frame-stage" ref={frameStageRef}
                      onWheel={e => { if (!reviewReady) return; e.preventDefault(); setZoom(zoomLevel * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY); }}
                      onDoubleClick={() => setZoom(1)}
                    >
                      <canvas className={`preview-canvas${!reviewReady || !currentKf ? ' hidden' : ''}`} ref={previewCanvasRef} />
                      {(!reviewReady || !currentKf) && (
                        <div className="frame-empty"><span className="mini-spin" /> {scanningLabel || 'Scanning frames for sensitive data…'}</div>
                      )}
                      {reviewReady && currentKf && !currentKf.removed && (
                        <div className="mask-overlay" ref={maskOverlayRef} onMouseDown={e => { if (e.target === maskOverlayRef.current) beginDraw(e); }}>
                          {currentKf.masks.map(m => (
                            <div key={m.id} className={`mask-box ${m.auto ? 'auto' : 'user'}`}
                              ref={el => { if (el) boxRefs.current.set(m.id, el); else boxRefs.current.delete(m.id); }}
                              style={{ left: `${m.x / currentKf.canvas.width * 100}%`, top: `${m.y / currentKf.canvas.height * 100}%`, width: `${m.w / currentKf.canvas.width * 100}%`, height: `${m.h / currentKf.canvas.height * 100}%` }}
                              onMouseDown={e => beginMove(e, m.id)}
                            >
                              <span className="mask-tag">{m.auto ? 'Auto' : 'Manual'}</span>
                              <button className="mask-del" onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); deleteMask(m.id); }}>✕</button>
                              {(['nw', 'ne', 'sw', 'se'] as const).map(h => (
                                <span key={h} className={`mask-handle mh-${h}`} onMouseDown={e => beginResize(e, m.id, h)} />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {reviewReady && currentKf?.removed && (
                      <div className="frame-removed-overlay">
                        <div className="t">This frame will be dropped from the recording</div>
                        <div className="d">Nothing from this frame is sent to the model. Use this when a frame is entirely sensitive.</div>
                        <button className="btn btn-navy-ghost btn-sm" style={{ background: '#fff' }} onClick={restoreFrame}>Keep this frame</button>
                      </div>
                    )}
                    <div className="frame-caption">Redacted preview · original deleted after summary</div>
                  </div>

                  <div className="filmstrip-row">
                    <button className="fs-nav" onClick={() => { if (reviewIndex > 0) goToFrame(reviewIndex - 1); }}>‹</button>
                    <div className="filmstrip">
                      {keyframesRef.current.map((kf, i) => (
                        <button key={kf.timestamp} className={`fs-thumb${i === reviewIndex ? ' active' : ''}${kf.removed ? ' removed' : ''}`} onClick={() => goToFrame(i)}>
                          <div className="num">{i + 1}</div>
                          {!kf.removed && kf.masks.length > 0 && <span className="marker" />}
                        </button>
                      ))}
                    </div>
                    <button className="fs-nav" onClick={() => { if (reviewIndex < keyframesRef.current.length - 1) goToFrame(reviewIndex + 1); }}>›</button>
                  </div>
                </div>

                <div className="review-disclaimer">Automatic detection is best-effort and bounded by detection accuracy, it is not a guarantee. Review every frame yourself, mask anything the automatic pass missed, and drop any frame that shouldn't be sent at all.</div>

                <div className="review-actions">
                  <button className="btn btn-ghost btn-md" onClick={() => { if (confirm('Discard this recording and return to the start?')) resetToReady(); }}>Discard</button>
                  <div className="modelline">Generating with <b>{summaryModelLabel(summaryModel)}</b></div>
                  <button className="btn btn-pink btn-md" onClick={() => { void generateSummary(); }}>Generate summary »</button>
                </div>
              </section>

              {/* ---- PROCESSING ---- */}
              <section className="stage stage-processing">
                <div className="proc-wrap">
                  <div className="eyebrow">{procEyebrow}</div>
                  <h4 className="title">Turning your recording into a summary</h4>
                  <div className="progressbar"><div className="fill" style={{ width: `${progressPct}%` }} /></div>
                  <div className="progress-meta"><span>{progressLabel}</span><span className="pct">{progressPct}%</span></div>
                  <div className="proc-steps">
                    {[
                      'Reading on-screen text (OCR)',
                      'Applying redaction masks to frames',
                      `Sending redacted frames to ${summaryModelLabel(summaryModel)}`,
                      'Generating summary from the frame sequence',
                    ].map((label, n) => (
                      <div key={n} className={`proc-step${procStates[n] === 'active' ? ' active' : ''}${procStates[n] === 'done' ? ' done' : ''}`} data-pstep={n}>
                        <span className="ico">{procStates[n] === 'done' ? '✓' : procStates[n] === 'active' ? '◜' : n + 1}</span>
                        <span className="lbl">{label}</span>
                      </div>
                    ))}
                  </div>
                  {rawTextFallback && (
                    <button className="btn btn-ghost btn-sm" style={{ marginTop: 18 }} onClick={useRawTextInstead}>Use raw OCR text instead</button>
                  )}
                </div>
              </section>

              {/* ---- SENT ---- */}
              <section className="stage stage-sent">
                <div className="sent-head">
                  <span className="check">✓</span>
                  <div>
                    <div className="eyebrow cyan">{sentEyebrow}</div>
                    <h4 className="title">{sentHeading}</h4>
                  </div>
                </div>
                <div className="summary-card">
                  <div className="head">Resolution summary</div>
                  <textarea className="summary-text" spellCheck value={summaryText} onChange={e => setSummaryText(e.target.value)} />
                </div>
                <div className="sent-privacy">Detected secrets and any regions you masked were burned out of the frames before generation. Original full-resolution screenshots never left this device.</div>
                {saveNote && <div className="save-note" style={{ color: saveNote.isError ? 'var(--cn-red)' : '' }}>{saveNote.text}</div>}
                <div className="sent-actions">
                  <button className="btn btn-soft btn-md coming-soon is-disabled" data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>Push to Ticket</button>
                  <button className="btn btn-navy-ghost btn-md" onClick={onSave}>Save to file</button>
                  <button className="btn btn-navy-ghost btn-md" onClick={onCopySummary}>{copiedSummary ? 'Copied!' : 'Copy'}</button>
                  <button className="btn btn-ghost btn-md" onClick={() => window.cardonetCapture.openFolder()}>Open folder</button>
                  <button className="btn btn-ghost btn-md" style={{ marginLeft: 'auto' }} onClick={resetToReady}>New recording</button>
                </div>
              </section>
            </div>

            {/* ===== Right rail ===== */}
            <aside className="rightrail">
              <div>
                <div className="rr-title">Summary Model</div>
                <div className="model-list">
                  <button className={`model-item${summaryModel === 'claude' ? ' active' : ''}`} data-model="claude" onClick={() => applySummaryModel('claude')}>
                    <span className="radio" /><div className="grow"><div className="name">Claude</div></div><span className="tag default">Default</span>
                  </button>
                  <button className="model-item is-disabled coming-soon" data-model="chatgpt" data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>
                    <span className="radio" /><div className="grow"><div className="name">ChatGPT</div></div><span className="tag cloud">Cloud</span>
                  </button>
                  <button className="model-item is-disabled coming-soon" data-model="gemini" data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>
                    <span className="radio" /><div className="grow"><div className="name">Gemini</div></div><span className="tag cloud">Cloud</span>
                  </button>
                  <button className={`model-item${summaryModel === 'ollama' ? ' active' : ''}`} data-model="ollama" onClick={() => applySummaryModel('ollama')}>
                    <span className="radio" /><div className="grow"><div className="name">Run locally with Ollama</div></div><span className="tag private">Private</span>
                  </button>
                </div>
              </div>
              <div className="rr-divider" />
              <div>
                <div className="rr-title row">Always Protected<span className="auto"><span className="dot" />Automatic</span></div>
                <div className="protect-list">
                  <div className="protect-row"><span className="check">✓</span><span className="t">Passwords &amp; credential fields</span></div>
                  <div className="protect-row"><span className="check">✓</span><span className="t">API keys, tokens &amp; connection strings</span></div>
                  <div className="protect-row"><span className="check">✓</span><span className="t">Usernames, emails &amp; PII</span></div>
                </div>
                <div className="protect-foot">Detection runs on every recording before frames reach the model. It is best-effort and bounded by detection accuracy, not a guarantee. Review the flagged frames before you generate.</div>
              </div>
            </aside>
          </div>

          {/* ========== SETTINGS SCREEN ========== */}
          <div className="screen-settings">
            <div className="settings-inner">
              <div className="eyebrow">Settings</div>
              <h4 className="title" style={{ marginBottom: 6 }}>Integrations &amp; capture</h4>

              <div className="settings-section-label">Summary Model Providers</div>
              <div className="model-list">
                <button className={`model-item${summaryModel === 'claude' ? ' active' : ''}`} data-model="claude" onClick={() => applySummaryModel('claude')}>
                  <span className="radio" /><div className="grow"><div className="name">Claude</div></div><span className="tag default">Default</span>
                </button>
                <button className="model-item is-disabled coming-soon" data-model="chatgpt" data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>
                  <span className="radio" /><div className="grow"><div className="name">ChatGPT</div></div><span className="tag cloud">Cloud</span>
                </button>
                <button className="model-item is-disabled coming-soon" data-model="gemini" data-tip="Coming soon" aria-disabled="true" onClick={e => e.preventDefault()}>
                  <span className="radio" /><div className="grow"><div className="name">Gemini</div></div><span className="tag cloud">Cloud</span>
                </button>
                <button className={`model-item${summaryModel === 'ollama' ? ' active' : ''}`} data-model="ollama" onClick={() => applySummaryModel('ollama')}>
                  <span className="radio" /><div className="grow"><div className="name">Run locally with Ollama</div></div><span className="tag private">Private</span>
                </button>
              </div>

              <div className="settings-section-label">Model Configuration</div>
              <div className="settings-card">
                <div className="form-grid">
                  <div className="form-group">
                    <label htmlFor="s-ollama-url">Ollama URL</label>
                    <input id="s-ollama-url" type="text" placeholder="http://localhost:11434" value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="s-vlm-model">Vision model</label>
                    <input id="s-vlm-model" type="text" placeholder="llava" value={vlmModel} onChange={e => setVlmModel(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="s-text-model">Text model</label>
                    <input id="s-text-model" type="text" placeholder="llama3" value={textModel} onChange={e => setTextModel(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="s-threshold">Change threshold <span className="hint">(0 to 10)</span></label>
                    <input id="s-threshold" type="number" min={0} max={10} placeholder="5" value={threshold} onChange={e => setThreshold(e.target.value)} />
                  </div>
                </div>
              </div>

              <div className="settings-section-label">HaloPSA Connection</div>
              <div className="settings-card">
                <div className="setting-row">
                  <span className="swatch" style={{ background: 'var(--cn-gradient)' }} />
                  <div className="grow">
                    <div className="name">HaloPSA</div>
                    <div className="detail">Not connected - connectivity is coming soon. Recording and summaries work without it.</div>
                  </div>
                  <button className="btn btn-pink btn-sm coming-soon is-disabled" data-tip="Coming soon" aria-disabled="true" style={{ boxShadow: 'none' }} onClick={e => e.preventDefault()}>Connect</button>
                </div>
              </div>

              <div className="settings-section-label">Activity Capture</div>
              <div className="settings-card">
                <p style={{ fontSize: 12.5, color: 'var(--slate)', lineHeight: 1.5, marginBottom: 4 }}>Alongside video: which tool was in focus, for how long, and what was on screen. Runs locally; all sources feed the summary prompt after being scrubbed for client names and tenant IDs.</p>
                <div className="check-row">
                  <input id="s-capture-window" type="checkbox" checked={captureWindowEnabled} onChange={e => setCaptureWindowEnabled(e.target.checked)} />
                  <div className="body">
                    <label htmlFor="s-capture-window">Window / app activity</label>
                    <p>Primary source - tracks focused app + dwell time, coarsely categorized (remote / admin console / PSA / terminal).</p>
                  </div>
                </div>
                <div className="check-row">
                  <input id="s-capture-terminal" type="checkbox" checked={captureTerminalEnabled} onChange={e => setCaptureTerminalEnabled(e.target.checked)} />
                  <div className="body">
                    <label htmlFor="s-capture-terminal">Terminal commands (PowerShell)</label>
                    <p>Captures locally-run PowerShell commands. Commands run inside RDP / remote sessions aren't seen, but the window-activity source still shows a remote session was focused, and for how long. cmd.exe is visible as a focused window, not by command text.</p>
                  </div>
                </div>
                <div className="check-row">
                  <input id="s-transcript-enabled" type="checkbox" checked={transcriptEnabled} onChange={e => setTranscriptEnabled(e.target.checked)} />
                  <div className="body">
                    <label htmlFor="s-transcript-enabled">Also capture command output (PowerShell transcript)</label>
                    <p>Writes a transcript file to your temp folder. Requires a one-time snippet in your PowerShell profile - <button className="btn btn-navy-ghost btn-sm" type="button" style={{ padding: '4px 10px' }} onClick={copyTranscriptSnippet}>{transcriptSnippetCopied ? 'Copied!' : 'Copy setup snippet'}</button></p>
                  </div>
                </div>
                <div className="check-row">
                  <input id="s-capture-browser" type="checkbox" checked={captureBrowserEnabled} onChange={e => setCaptureBrowserEnabled(e.target.checked)} />
                  <div className="body">
                    <label htmlFor="s-capture-browser">Browser activity (Chrome / Edge)</label>
                    <p>Detects which admin portals and sites were used during the recording. The most sensitive source - turn off if not needed.</p>
                  </div>
                </div>
              </div>

              <div className="settings-section-label">Redaction</div>
              <div className="settings-card">
                <div className="form-grid">
                  <div className="form-group full">
                    <label htmlFor="s-client-names">Client names to redact <span className="hint">(comma-separated)</span></label>
                    <input id="s-client-names" type="text" placeholder="Acme Corp, Northwind Finance" value={clientNames} onChange={e => setClientNames(e.target.value)} />
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 20 }}>
                <button className="btn btn-pink btn-md" onClick={() => { saveSettings(); setScreen('work'); }}>Save settings</button>
              </div>
            </div>
          </div>

          {/* ========== TEMPLATES SCREEN ========== */}
          <div className="screen-templates">
            <div className="templates-inner">
              <div className="eyebrow">Summary Templates</div>
              <h4 className="title" style={{ marginBottom: 6 }}>Summary Templates</h4>
              <p className="subnote" style={{ maxWidth: 640 }}>Layer extra instructions for the AI summary to follow.</p>

              <div className="tpl-grid">
                <div>
                  <div className="settings-section-label">Your Templates</div>
                  <div className="tpl-list">
                    <div className={`tpl-item${activeTemplateId === '' ? ' active' : ''}`} onClick={() => selectTemplate('')}>
                      <span className="radio" />
                      <div className="grow"><div className="name">No template</div><div className="sub">Baseline rules only</div></div>
                    </div>
                    {templates.map(t => (
                      <div key={t.id} className={`tpl-item${t.id === activeTemplateId ? ' active' : ''}`} onClick={() => selectTemplate(t.id)}>
                        <span className="radio" />
                        <div className="grow"><div className="name">{t.title || 'Untitled'}</div></div>
                        <div className="tpl-actions">
                          <button type="button" className="tpl-mini" onClick={e => { e.stopPropagation(); openTemplateEditor(t.id); }}>Edit</button>
                          <button type="button" className="tpl-mini danger" onClick={e => { e.stopPropagation(); deleteTemplate(t.id); }}>Delete</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button className="btn btn-navy-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => openTemplateEditor(null)}>+ New template</button>
                </div>

                <div>
                  <div className="settings-section-label">{editingId ? `Editing: ${templates.find(t => t.id === editingId)?.title || 'Untitled'}` : 'New template'}</div>
                  <div className="settings-card">
                    <div className="form-group">
                      <label htmlFor="tpl-title">Title</label>
                      <input id="tpl-title" type="text" placeholder="e.g. Printer troubleshooting note" autoComplete="off" spellCheck={false}
                        className={tplTitleError ? 'error' : ''}
                        value={tplTitle} onChange={e => { setTplTitle(e.target.value); setTplTitleError(false); }} />
                    </div>
                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label htmlFor="tpl-content">Content <span className="hint">markdown or plain text - appended to the baseline rules</span></label>
                      <textarea id="tpl-content" rows={10} placeholder="e.g. Organise the actions under headings: Diagnosis, Steps taken, Resolution. Keep it under 8 bullets." value={tplContent} onChange={e => setTplContent(e.target.value)} />
                    </div>
                    <input type="file" ref={tplFileInputRef} accept=".md,.markdown,text/markdown,text/plain" className="hidden" onChange={e => { void loadTemplateFile(e.target.files?.[0]); e.target.value = ''; }} />
                    <div className="tpl-editor-actions">
                      <button className="btn btn-navy-ghost btn-sm" type="button" onClick={() => tplFileInputRef.current?.click()}>Upload .md</button>
                      <span className="tpl-file-note">{tplFileNote}</span>
                      {editingId && <button className="tpl-mini-delete btn btn-ghost btn-sm" type="button" style={{ marginLeft: 'auto' }} onClick={() => deleteTemplate(editingId)}>Delete</button>}
                      <button className="btn btn-pink btn-sm" type="button" style={!editingId ? { marginLeft: 'auto' } : undefined} onClick={saveTemplate}>Save template</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Overlays ──────────────────────────────────────────────────── */}
      <div className={`rec-outline${recordingOverlayVisible ? '' : ' hidden'}`} />
      <div className={`rec-badge${recordingOverlayVisible ? '' : ' hidden'}`}><span className="dot" />REC <span className="mono">{timerText}</span></div>

      <div className={`overlay${stage === 'countdown' ? '' : ' hidden'}`}>
        <div className="countdown-ring">{countdownN}</div>
        <div className="countdown-sub">Recording {captureSource === 'window' ? 'the selected window' : 'the entire screen'} in…</div>
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 16, background: 'rgba(255,255,255,.16)', color: '#fff' }} onClick={cancelCountdown}>Cancel</button>
      </div>

      <div className={`modal-scrim${durationModalVisible ? '' : ' hidden'}`}>
        <div className="modal-card">
          <div className="badge">⏱</div>
          <h3>This is a long recording</h3>
          <p>You've been recording for over 30 minutes. Long recordings capture more keyframes, which take longer to review and to summarise. Recording is still running, this is just a heads-up.</p>
          <div className="modal-actions">
            <button className="btn btn-pink btn-sm" onClick={() => setDurationModalVisible(false)}>Got it, keep recording</button>
          </div>
        </div>
      </div>
    </div>
  );
}
