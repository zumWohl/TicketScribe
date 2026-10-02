// Vitest port of test/mask-verify.html: pixel-level proof that redaction is
// DESTRUCTIVE on the sent image -- the exact maskAndDownscale() the app
// ships, imported directly (no esbuild CJS step needed here, unlike the
// Electron harness). Draws a known "secret" (solid red block) on a green
// field, masks it, runs the real send-path, then reads the pixels where the
// secret was in the FINAL dataUrl and asserts the red is gone (replaced by
// the mask fill), not merely covered by an overlay.
//
// redact.ts's internal "work" canvas is a real OffscreenCanvas in the app
// (and inside redact.worker.ts) -- the test environment has no OffscreenCanvas
// at all, so it's polyfilled with node-canvas's Canvas here, the same trick
// hash.test.ts uses for aHash(). The source canvas is built the same way
// (nodeCreateCanvas, not document.createElement) so it's a genuine node-canvas
// object drawImage() can composite directly, Cairo-backed throughout, not a
// stub. maskAndDownscale() is therefore async now (OffscreenCanvas's real
// encode path, convertToBlob, is async) -- awaited below like any other
// async call, not a behavior change.
import { describe, it, expect, beforeAll } from 'vitest';
import { Canvas, loadImage, createCanvas as nodeCreateCanvas } from 'canvas';
import { maskAndDownscale, MODEL_IMAGE_MAX_DIMENSION, type Mask } from './redact';

beforeAll(() => {
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = Canvas;
});

interface SecretRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function makeSecretCanvas(w: number, h: number, secret: SecretRect): HTMLCanvasElement {
  const c = nodeCreateCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#00c000'; // green field
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ff0000'; // the "secret"
  ctx.fillRect(secret.x, secret.y, secret.w, secret.h);
  return c as unknown as HTMLCanvasElement;
}

interface FrameCheckResult {
  downscaled: boolean;
  naturalWidth: number;
  naturalHeight: number;
  secretPixel: [number, number, number];
  greenPixel: [number, number, number];
}

async function checkFrame(w: number, h: number): Promise<FrameCheckResult> {
  const secret: SecretRect = {
    x: Math.round(w * 0.25),
    y: Math.round(h * 0.25),
    w: Math.round(w * 0.3),
    h: Math.round(h * 0.2),
  };
  const src = makeSecretCanvas(w, h, secret);
  const masks: Mask[] = [{ id: 'm1', x: secret.x - 4, y: secret.y - 4, w: secret.w + 8, h: secret.h + 8 }]; // full-res coords
  const dataUrl = await maskAndDownscale(src, masks);

  const img = await loadImage(dataUrl);
  const out = nodeCreateCanvas(img.width, img.height);
  const octx = out.getContext('2d');
  octx.drawImage(img, 0, 0);

  const scale = img.width / w; // uniform aspect
  const sx = Math.min(out.width - 1, Math.round((secret.x + secret.w / 2) * scale));
  const sy = Math.min(out.height - 1, Math.round((secret.y + secret.h / 2) * scale));
  const secretPx = octx.getImageData(sx, sy, 1, 1).data;

  // green sample far from any mask, to prove the rest of the image survived
  const gx = Math.min(out.width - 1, Math.round(w * 0.9 * scale));
  const gy = Math.min(out.height - 1, Math.round(h * 0.9 * scale));
  const greenPx = octx.getImageData(gx, gy, 1, 1).data;

  return {
    downscaled: img.width < w,
    naturalWidth: img.width,
    naturalHeight: img.height,
    secretPixel: [secretPx[0], secretPx[1], secretPx[2]],
    greenPixel: [greenPx[0], greenPx[1], greenPx[2]],
  };
}

describe('maskAndDownscale: destructive redaction (pixel-level)', () => {
  it('replaces the masked region with fill pixels and leaves the rest intact, below the downscale cap', async () => {
    const result = await checkFrame(400, 300); // below MODEL_IMAGE_MAX_DIMENSION -- not downscaled
    expect(result.downscaled).toBe(false);

    const [r, g, b] = result.secretPixel;
    const isRed = r > 150 && g < 110 && b < 110;
    const isMaskFill = r < 60 && g < 60 && b < 60;
    expect(isRed, `expected the original red secret to be gone, got rgb(${r},${g},${b})`).toBe(false);
    expect(isMaskFill, `expected black mask fill, got rgb(${r},${g},${b})`).toBe(true);

    const [gr, gg] = result.greenPixel;
    expect(gg > 110 && gr < 130, `expected the untouched region to still be green, got rgb(${gr},${gg})`).toBe(true);
  });

  it('replaces the masked region with fill pixels and leaves the rest intact, above the downscale cap', async () => {
    const result = await checkFrame(2400, 1350); // above MODEL_IMAGE_MAX_DIMENSION -- downscaled
    expect(result.downscaled).toBe(true);
    expect(Math.max(result.naturalWidth, result.naturalHeight)).toBeLessThanOrEqual(MODEL_IMAGE_MAX_DIMENSION);

    const [r, g, b] = result.secretPixel;
    const isRed = r > 150 && g < 110 && b < 110;
    const isMaskFill = r < 60 && g < 60 && b < 60;
    expect(isRed, `expected the original red secret to be gone, got rgb(${r},${g},${b})`).toBe(false);
    expect(isMaskFill, `expected black mask fill, got rgb(${r},${g},${b})`).toBe(true);

    const [gr, gg] = result.greenPixel;
    expect(gg > 110 && gr < 130, `expected the untouched region to still be green, got rgb(${gr},${gg})`).toBe(true);
  });
});
