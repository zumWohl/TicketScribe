// Pure, DOM-canvas redaction primitives shared by the app (app.js) and the
// pixel-level verification test (test/mask-verify.html). Kept in one module so
// the security-critical masking path that ships is the exact same code the
// test exercises.
//
// SECURITY CONTRACT: masks are always expressed in FULL-RESOLUTION source
// canvas pixel coordinates. maskAndDownscale() copies the full-res canvas,
// destructively overwrites (fillRect) the masked pixels on that full-res copy,
// and only THEN downscales. Masking never happens after downscaling, and the
// returned dataUrl is derived from genuinely overwritten pixels -- not a DOM
// overlay drawn on top of readable ones.

const MODEL_IMAGE_MAX_DIMENSION = 1280; // long-edge cap for images sent to the VLM/Claude

// Clamp a rect (canvas-space px) to the canvas bounds and destructively fill it.
function fillMasks(canvas, masks, fill) {
  if (!masks || masks.length === 0) return;
  const ctx = canvas.getContext('2d');
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
function downscale(sourceCanvas, maxDim) {
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
  out.getContext('2d').drawImage(sourceCanvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.75);
}

// The one true send-path: mask destructively on a full-res copy, THEN
// downscale. Returns a dataUrl whose masked regions contain only fill pixels.
function maskAndDownscale(sourceCanvas, masks, opts) {
  const o = opts || {};
  const work = document.createElement('canvas');
  work.width = sourceCanvas.width;
  work.height = sourceCanvas.height;
  const ctx = work.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);
  fillMasks(work, masks, o.fill || '#000000'); // full-res, before downscale
  return downscale(work, o.maxDim || MODEL_IMAGE_MAX_DIMENSION);
}

module.exports = { MODEL_IMAGE_MAX_DIMENSION, fillMasks, downscale, maskAndDownscale };
