// Pure, OffscreenCanvas-based redaction primitives shared by the app
// (App.tsx, via redact-worker-client.ts/redact.worker.ts) and the
// pixel-level verification test (redact.test.ts, imports this module
// directly). Kept in one module so the security-critical masking path that
// ships is the exact same code the test exercises.
//
// SECURITY CONTRACT: masks are always expressed in FULL-RESOLUTION source
// canvas pixel coordinates. maskAndDownscale() copies the full-res canvas,
// destructively overwrites (fillRect) the masked pixels on that full-res copy,
// and only THEN downscales. Masking never happens after downscaling, and the
// returned dataUrl is derived from genuinely overwritten pixels -- not a DOM
// overlay drawn on top of readable ones.
//
// This module never names HTMLCanvasElement -- it type-checks both under the
// renderer's DOM lib (tsconfig.web.json, where App.tsx and redact.test.ts
// live) and the worker's WebWorker-only lib (tsconfig.worker.json,
// redact.worker.ts), which has no HTMLCanvasElement at all. The actual
// masking runs off the main thread, in a Worker, via redact.worker.ts --
// see redact-worker-client.ts for the dispatch side.
import { MODEL_IMAGE_MAX_DIMENSION } from '../../../shared/image';

export { MODEL_IMAGE_MAX_DIMENSION };

const JPEG_QUALITY = 0.75;

export interface Mask {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  auto?: boolean;
}

// Always OffscreenCanvas -- real in every environment this app actually runs
// in (Electron's main thread and inside redact.worker.ts are both Chromium
// contexts, where OffscreenCanvas is native), and polyfilled with
// node-canvas's Canvas in the Vitest/jsdom unit test (redact.test.ts), the
// same trick hash.test.ts already uses for aHash()'s OffscreenCanvas.
function createWorkCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height);
}

function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  const sized = source as unknown as { width: number; height: number };
  return { width: sized.width, height: sized.height };
}

// Clamp a rect (canvas-space px) to the canvas bounds and destructively fill it.
export function fillMasks(canvas: OffscreenCanvas, masks: Mask[] | null | undefined, fill?: string): void {
  if (!masks || masks.length === 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = fill || '#000000';
  for (const m of masks) {
    const x = Math.max(0, Math.min(canvas.width, Math.round(m.x)));
    const y = Math.max(0, Math.min(canvas.height, Math.round(m.y)));
    const w = Math.max(0, Math.min(canvas.width - x, Math.round(m.w)));
    const h = Math.max(0, Math.min(canvas.height - y, Math.round(m.h)));
    if (w > 0 && h > 0) ctx.fillRect(x, y, w, h);
  }
}

// Test-only shape: the node-canvas Canvas polyfilled in as `OffscreenCanvas`
// for redact.test.ts (see that file) has a real, Cairo-backed toDataURL, but
// not the real OffscreenCanvas's convertToBlob.
interface NodeCanvasEncodable {
  toDataURL(type: string, quality: number): string;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// A real OffscreenCanvas has no toDataURL -- only the async convertToBlob.
// Detect which is available at runtime rather than assuming the environment,
// so this one function serves both the real app and the test polyfill.
async function encodeToDataUrl(canvas: OffscreenCanvas): Promise<string> {
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const buf = await blob.arrayBuffer();
    return `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
  }
  return (canvas as unknown as NodeCanvasEncodable).toDataURL('image/jpeg', JPEG_QUALITY);
}

// Downscale a canvas to the long-edge cap and return a JPEG dataUrl. A canvas
// already at or below the cap is emitted as-is (no upscaling).
export async function downscale(sourceCanvas: OffscreenCanvas, maxDim?: number): Promise<string> {
  const cap = maxDim || MODEL_IMAGE_MAX_DIMENSION;
  const { width, height } = sourceCanvas;
  const longEdge = Math.max(width, height);
  if (longEdge <= cap) {
    return encodeToDataUrl(sourceCanvas);
  }
  const scale = cap / longEdge;
  const out = createWorkCanvas(Math.round(width * scale), Math.round(height * scale));
  out.getContext('2d')?.drawImage(sourceCanvas, 0, 0, out.width, out.height);
  return encodeToDataUrl(out);
}

export interface MaskAndDownscaleOptions {
  fill?: string;
  maxDim?: number;
}

// The one true send-path: mask destructively on a full-res copy, THEN
// downscale. Returns a dataUrl whose masked regions contain only fill pixels.
// `sourceCanvas` is whatever the caller already has pixels in -- an
// HTMLCanvasElement (redact.test.ts, drawing directly) or an ImageBitmap
// (redact.worker.ts, given a transferred snapshot of the live keyframe
// canvas -- see redact-worker-client.ts).
export async function maskAndDownscale(
  sourceCanvas: CanvasImageSource,
  masks: Mask[],
  opts?: MaskAndDownscaleOptions,
): Promise<string> {
  const o = opts || {};
  const { width, height } = sourceSize(sourceCanvas);
  const work = createWorkCanvas(width, height);
  work.getContext('2d')?.drawImage(sourceCanvas, 0, 0);
  fillMasks(work, masks, o.fill || '#000000'); // full-res, before downscale
  return downscale(work, o.maxDim || MODEL_IMAGE_MAX_DIMENSION);
}
