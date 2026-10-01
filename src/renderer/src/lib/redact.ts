// Pure, DOM-canvas redaction primitives shared by the app (app.tsx, once
// Phase 6a ports it) and the pixel-level verification test (test/mask-verify.html,
// repointed at this module in Phase 4). Kept in one module so the
// security-critical masking path that ships is the exact same code the test
// exercises.
//
// SECURITY CONTRACT: masks are always expressed in FULL-RESOLUTION source
// canvas pixel coordinates. maskAndDownscale() copies the full-res canvas,
// destructively overwrites (fillRect) the masked pixels on that full-res copy,
// and only THEN downscales. Masking never happens after downscaling, and the
// returned dataUrl is derived from genuinely overwritten pixels -- not a DOM
// overlay drawn on top of readable ones.
//
// 1:1 port of renderer/redact.js -- types only, no logic change.
import { MODEL_IMAGE_MAX_DIMENSION } from '../../../shared/image';

export { MODEL_IMAGE_MAX_DIMENSION };

export interface Mask {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  auto?: boolean;
}

// Clamp a rect (canvas-space px) to the canvas bounds and destructively fill it.
export function fillMasks(canvas: HTMLCanvasElement, masks: Mask[] | null | undefined, fill?: string): void {
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

// Downscale a canvas to the long-edge cap and return a JPEG dataUrl. A canvas
// already at or below the cap is emitted as-is (no upscaling).
export function downscale(sourceCanvas: HTMLCanvasElement, maxDim?: number): string {
  const cap = maxDim || MODEL_IMAGE_MAX_DIMENSION;
  const { width, height } = sourceCanvas;
  const longEdge = Math.max(width, height);
  if (longEdge <= cap) {
    return sourceCanvas.toDataURL('image/jpeg', 0.75);
  }
  const scale = cap / longEdge;
  const out = document.createElement('canvas');
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  out.getContext('2d')?.drawImage(sourceCanvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.75);
}

export interface MaskAndDownscaleOptions {
  fill?: string;
  maxDim?: number;
}

// The one true send-path: mask destructively on a full-res copy, THEN
// downscale. Returns a dataUrl whose masked regions contain only fill pixels.
export function maskAndDownscale(sourceCanvas: HTMLCanvasElement, masks: Mask[], opts?: MaskAndDownscaleOptions): string {
  const o = opts || {};
  const work = document.createElement('canvas');
  work.width = sourceCanvas.width;
  work.height = sourceCanvas.height;
  const ctx = work.getContext('2d');
  ctx?.drawImage(sourceCanvas, 0, 0);
  fillMasks(work, masks, o.fill || '#000000'); // full-res, before downscale
  return downscale(work, o.maxDim || MODEL_IMAGE_MAX_DIMENSION);
}
