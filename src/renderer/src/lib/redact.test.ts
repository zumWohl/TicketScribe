// @vitest-environment jsdom
//
// Differential test: the legacy renderer/redact.js and ported redact.ts must
// compute identical downscale DIMENSIONS across below-cap, at-cap and
// above-cap inputs. jsdom implements the full HTMLCanvasElement DOM
// interface (width/height, element structure) but not real 2D rendering
// (getContext('2d') returns null, no node-canvas installed) -- intentionally
// not adding a native canvas dependency just for this. Instead,
// getContext/toDataURL are stubbed so toDataURL reports back the canvas's
// own width/height, which is exactly what this test needs to verify: the
// scaling MATH, not pixel content (that's mask-verify's job, Phase 4).
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import * as ported from './redact';

const require = createRequire(import.meta.url);
const legacy = require('../../../../renderer/redact.js');

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => {},
    fillRect: () => {},
    fillStyle: '',
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = function toDataURL(this: HTMLCanvasElement) {
    return `dim:${this.width}x${this.height}`;
  };
});

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

describe('downscale dimensions differential', () => {
  const cases: Array<[string, number, number, number]> = [
    ['below-cap', 800, 600, 1280],
    ['at-cap exactly', 1280, 720, 1280],
    ['above-cap, landscape', 2400, 1350, 1280],
    ['above-cap, portrait', 1000, 3000, 1280],
    ['custom cap below-cap', 400, 300, 500],
    ['custom cap above-cap', 1000, 500, 500],
  ];

  it.each(cases)('%s (%ix%i, cap %i)', (_label, w, h, cap) => {
    const portedResult = ported.downscale(makeCanvas(w, h), cap);
    const legacyResult = legacy.downscale(makeCanvas(w, h), cap);
    expect(portedResult).toBe(legacyResult);
  });

  it('defaults to MODEL_IMAGE_MAX_DIMENSION when no cap given', () => {
    const portedResult = ported.downscale(makeCanvas(2000, 1000));
    const legacyResult = legacy.downscale(makeCanvas(2000, 1000));
    expect(portedResult).toBe(legacyResult);
    expect(portedResult).toBe(`dim:${ported.MODEL_IMAGE_MAX_DIMENSION}x${Math.round(1000 * (ported.MODEL_IMAGE_MAX_DIMENSION / 2000))}`);
  });
});

describe('maskAndDownscale dimensions differential', () => {
  it('produces the same final dimensions as the legacy module (masks applied full-res first)', () => {
    const masks = [{ id: 'm1', x: 10, y: 10, w: 50, h: 20, auto: true }];
    const portedResult = ported.maskAndDownscale(makeCanvas(2400, 1350), masks);
    const legacyResult = legacy.maskAndDownscale(makeCanvas(2400, 1350), masks);
    expect(portedResult).toBe(legacyResult);
  });
});
