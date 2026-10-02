// Frame-dedup threshold logic: hamming()'s distance calculation and the
// shouldKeepAsKeyframe()/clampThreshold() decision App.tsx's capture loop
// makes every ~1.5s. aHash() itself also gets a real-pixel smoke test via a
// minimal OffscreenCanvas polyfill backed by node-canvas (jsdom doesn't
// implement OffscreenCanvas at all, so this runs under the default node
// environment, not jsdom).
import { describe, it, expect, beforeAll } from 'vitest';
import { Canvas } from 'canvas';
import { aHash, hamming, clampThreshold, shouldKeepAsKeyframe, type AHash } from './hash';

beforeAll(() => {
  // aHash() only calls `new OffscreenCanvas(w, h)` and `.getContext('2d')`
  // -- node-canvas's Canvas matches that shape closely enough to stand in.
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = Canvas;
});

function solidCanvas(r: number, g: number, b: number): HTMLCanvasElement {
  const c = new Canvas(8, 8);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, 8, 8);
  return c as unknown as HTMLCanvasElement;
}

// Vertical black/white split, flippable so two calls produce genuinely
// different (complementary) hashes rather than two renders of the same image.
function splitCanvas(blackOnLeft: boolean): HTMLCanvasElement {
  const c = new Canvas(8, 8);
  const ctx = c.getContext('2d');
  ctx.fillStyle = blackOnLeft ? '#000000' : '#ffffff';
  ctx.fillRect(0, 0, 4, 8);
  ctx.fillStyle = blackOnLeft ? '#ffffff' : '#000000';
  ctx.fillRect(4, 0, 4, 8);
  return c as unknown as HTMLCanvasElement;
}

describe('hamming', () => {
  it('is 0 for identical hashes', () => {
    const h: AHash = [1, 0, 1, 1, 0, 0, 1, 0];
    expect(hamming(h, [...h])).toBe(0);
  });

  it('counts exactly the differing bits', () => {
    expect(hamming([1, 1, 1, 1], [1, 1, 0, 0])).toBe(2);
    expect(hamming([0, 0, 0, 0], [1, 1, 1, 1])).toBe(4);
  });
});

describe('clampThreshold', () => {
  it('clamps below 0 up to 0', () => {
    expect(clampThreshold(-5)).toBe(0);
  });
  it('clamps above 10 down to 10', () => {
    expect(clampThreshold(15)).toBe(10);
  });
  it('passes values already in range through unchanged', () => {
    expect(clampThreshold(0)).toBe(0);
    expect(clampThreshold(5)).toBe(5);
    expect(clampThreshold(10)).toBe(10);
  });
});

describe('shouldKeepAsKeyframe', () => {
  const hash: AHash = new Array(64).fill(0);

  it('keeps the very first frame regardless of threshold (no prior hash)', () => {
    expect(shouldKeepAsKeyframe(hash, null, 10)).toBe(true);
  });

  it('drops a frame exactly at the threshold distance', () => {
    const lastHash: AHash = new Array(64).fill(0);
    const h2 = [...lastHash];
    for (let i = 0; i < 5; i++) h2[i] = 1; // distance 5
    expect(hamming(h2, lastHash)).toBe(5);
    expect(shouldKeepAsKeyframe(h2, lastHash, 5)).toBe(false); // > threshold, not >=
  });

  it('keeps a frame one bit past the threshold distance', () => {
    const lastHash: AHash = new Array(64).fill(0);
    const h2 = [...lastHash];
    for (let i = 0; i < 6; i++) h2[i] = 1; // distance 6
    expect(shouldKeepAsKeyframe(h2, lastHash, 5)).toBe(true);
  });

  it('drops a frame identical to the last kept one', () => {
    const lastHash: AHash = new Array(64).fill(1);
    expect(shouldKeepAsKeyframe([...lastHash], lastHash, 0)).toBe(false);
  });
});

describe('aHash (real pixel smoke test)', () => {
  it('produces identical hashes for identical solid-color frames', () => {
    expect(aHash(solidCanvas(10, 10, 10))).toEqual(aHash(solidCanvas(10, 10, 10)));
  });

  it('hashes any uniform frame to all 1s (every pixel equals its own mean)', () => {
    // Documents a real property of average-hash, not a bug: with zero
    // variance, `g >= mean` is true for every pixel regardless of the
    // color, so a solid black and a solid white frame hash identically.
    // This is exactly why dedup needs on-screen *change*, not just "a
    // frame exists" -- a static screen of any color collapses to one hash.
    expect(aHash(solidCanvas(0, 0, 0))).toEqual(new Array(64).fill(1));
    expect(aHash(solidCanvas(255, 255, 255))).toEqual(new Array(64).fill(1));
  });

  it('produces a meaningful, complementary hash for genuinely different frames', () => {
    const leftBlack = aHash(splitCanvas(true));
    const rightBlack = aHash(splitCanvas(false));
    expect(hamming(leftBlack, rightBlack)).toBeGreaterThan(0);
    expect(leftBlack).not.toEqual(rightBlack);
  });
});
