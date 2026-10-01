// Phase 5 gate: proves the VENDORED tesseract asset path works -- worker,
// core and traineddata all resolved via URLs relative to document.baseURI
// (never root-absolute), loaded from src/renderer/public/vendor/tesseract/
// (copied there by scripts/vendor-tesseract.js). No CDN fetch should ever
// happen from this page. Reports its result on `window.__ocrVerifyDone` /
// `window.__ocrVerifyPayload` so a Playwright test can poll for it, same
// idea as test/ocr-verify.html's ipcRenderer.send but without needing
// nodeIntegration (this page never touches Node APIs, matching where the
// real renderer ends up after Phase 6a's isolation flip).
import { createWorker } from 'tesseract.js';

declare global {
  interface Window {
    __ocrVerifyDone?: boolean;
    __ocrVerifyPayload?: unknown;
  }
}

const EXPECTED_TEXT = 'TICKETSCRIBE VENDORED OCR WORKS';

function makeTextCanvas(text: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  // Wide enough that a ~32-character string at 48px Arial never clips its
  // last word against the canvas edge (that clipping was observed directly:
  // a 900px canvas garbled trailing words like "WORKS" into "WOF").
  c.width = 1400;
  c.height = 160;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000000';
  ctx.font = '48px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 30, c.height / 2);
  return c;
}

function vendoredUrl(name: string): string {
  return new URL(`vendor/tesseract/${name}`, document.baseURI).href;
}

async function main() {
  const canvas = makeTextCanvas(EXPECTED_TEXT);
  const worker = await createWorker('eng', 1, {
    workerPath: vendoredUrl('worker.min.js'),
    // A directory (not an exact file), matching the legacy loading
    // behavior: getCore.js only treats a path as an exact file when it ends
    // in "js"; otherwise it feature-detects SIMD support and picks the
    // right tesseract-core*.wasm.js variant itself -- why all four variants
    // are vendored, not just one.
    corePath: vendoredUrl(''),
    langPath: vendoredUrl(''),
    logger: () => {},
  });
  const { data } = await worker.recognize(canvas);
  await worker.terminate();

  const text = (data.text || '').replace(/\s+/g, ' ').trim();
  const words = (data.blocks || [])
    .flatMap(b => b.paragraphs || [])
    .flatMap(p => p.lines || [])
    .flatMap(l => l.words || [])
    .filter(w => w.text && w.text.trim());

  const normalizedExpected = EXPECTED_TEXT.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const normalizedActual = text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const foundExpectedText = normalizedActual.includes(normalizedExpected);

  const pass = words.length > 0 && foundExpectedText;
  return { pass, text, wordCount: words.length, foundExpectedText, expected: EXPECTED_TEXT };
}

function report(payload: unknown) {
  if (window.__ocrVerifyDone) return; // first result wins
  window.__ocrVerifyPayload = payload;
  window.__ocrVerifyDone = true;
  document.getElementById('out')!.textContent = JSON.stringify(payload, null, 2);
}

// Diagnostic aid: createWorker()/recognize() hanging forever (rather than
// rejecting) on an internal worker-side failure has been observed under
// some origins. These surface whatever global error info exists instead of
// the caller just timing out with no information.
window.addEventListener('error', e => {
  report({ pass: false, error: `window.onerror: ${e.message}`, source: e.filename, lineno: e.lineno });
});
window.addEventListener('unhandledrejection', e => {
  report({ pass: false, error: `unhandledrejection: ${String(e.reason && e.reason.stack || e.reason)}` });
});
setTimeout(() => report({ pass: false, error: 'main() did not settle within 20s (likely hung inside the worker)' }), 20000);

main()
  .then(payload => report(payload))
  .catch(err => report({ pass: false, error: String((err && err.stack) || err) }));
