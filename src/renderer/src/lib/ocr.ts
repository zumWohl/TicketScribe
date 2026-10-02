// Lazy, reused-across-keyframes OCR worker. 1:1 port of app.js's
// TESSERACT_WORKER_PATH/TESSERACT_CORE_PATH constants + ensureOCRWorker()/
// runOCR() -- except the asset paths now come from Phase 5's vendored,
// relative-to-document resolution instead of the legacy require.resolve()
// hack (which only worked because nodeIntegration was on).
import { createWorker } from 'tesseract.js';

function vendoredUrl(name: string): string {
  return new URL(`vendor/tesseract/${name}`, document.baseURI).href;
}

export interface OcrWordBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface OcrWord {
  text: string;
  bbox: OcrWordBox;
}
export interface OcrResult {
  text: string;
  words: OcrWord[];
}

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

// Discovered during Phase 6a testing: creating the tesseract worker (its
// internal "loading language traineddata" fetch of the vendored, local
// file:// eng.traineddata) can hang indefinitely -- not just slowly, genuinely
// forever, confirmed past 6 minutes -- the FIRST time it runs against a
// brand-new/empty userData profile (no prior disk cache). The exact same
// code resolves in a few hundred ms against an already-used profile. Root
// cause not pinned down (looks like a Chromium/Electron first-write
// initialization race for a fresh profile's network/cache backing store,
// specific to a Worker-context fetch), but it reproduces 100% of the time
// against a fresh profile and 0% of the time against a reused one. Mitigated
// with a timeout + fresh-worker retry in runOCR() below: discard the stuck
// attempt and try once more against the same (by-then-less-fresh) profile.
const WORKER_INIT_TIMEOUT_MS = 20000;

let ocrWorker: TesseractWorker | null = null;
let ocrWorkerPromise: Promise<TesseractWorker> | null = null;

function createWorkerWithTimeout(): Promise<TesseractWorker> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`OCR worker initialization timed out after ${WORKER_INIT_TIMEOUT_MS}ms`));
    }, WORKER_INIT_TIMEOUT_MS);

    createWorker('eng', 1, {
      workerPath: vendoredUrl('worker.min.js'),
      // A directory, not an exact file -- matches the legacy loading
      // behavior (see Phase 5): getCore.js feature-detects SIMD support
      // and picks the right tesseract-core*.wasm.js variant itself.
      corePath: vendoredUrl(''),
      langPath: vendoredUrl(''),
      logger: () => {},
      // Without this, tesseract.js's internal onMessage handler does an
      // unconditional `throw Error(data)` on ANY job rejection (not just
      // this one), on top of properly rejecting the specific promise --
      // surfacing as an uncaught global error regardless of try/catch
      // around the call that triggered it. This turns that into a normal,
      // swallowable rejection instead.
      errorHandler: () => {},
    })
      .then(w => {
        if (settled) {
          // Timed out already; this worker arrived late. Don't leak it, but
          // don't use it either -- the caller already moved on.
          w.terminate().catch(() => {});
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(w);
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

export function ensureOCRWorker(): Promise<TesseractWorker> {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorkerWithTimeout().then(w => {
      ocrWorker = w;
      return w;
    });
    // A failed/timed-out attempt must not be cached forever -- the next
    // call (whether a retry from runOCR or a later keyframe) needs to start
    // a genuinely fresh attempt, not keep returning the same dead promise.
    ocrWorkerPromise.catch(() => {
      ocrWorkerPromise = null;
    });
  }
  return ocrWorkerPromise;
}

export async function runOCR(canvas: HTMLCanvasElement): Promise<OcrResult> {
  const MAX_ATTEMPTS = 2; // the timeout/fresh-profile issue above has only ever needed one retry in testing
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const worker = await ensureOCRWorker();
      const { data } = await worker.recognize(canvas);
      const text = (data.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      const words: OcrWord[] = (data.blocks || [])
        .flatMap(b => b.paragraphs || [])
        .flatMap(p => p.lines || [])
        .flatMap(l => l.words || [])
        .filter(w => w.text && w.text.trim())
        .map(w => ({ text: w.text, bbox: w.bbox }));
      return { text, words };
    } catch (err) {
      lastErr = err;
    }
  }
  // Don't swallow silently -- a dead OCR worker disables all auto-masking,
  // and that failure must be visible in the console rather than looking
  // like "no sensitive data found".
  console.error(`runOCR failed after ${MAX_ATTEMPTS} attempt(s):`, lastErr);
  return { text: '', words: [] };
}
