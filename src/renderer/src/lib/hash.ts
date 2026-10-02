// Perceptual average-hash frame deduplication. 1:1 port of app.js's
// aHash/hamming (pure JS, OffscreenCanvas) -- no logic change. `source`'s
// type never names HTMLCanvasElement so this file type-checks both under the
// renderer's DOM lib (tsconfig.web.json) and the worker's WebWorker-only lib
// (tsconfig.worker.json, hash.worker.ts) -- see hash-worker-client.ts for the
// off-main-thread dispatch side App.tsx's capture loop actually calls.
export type AHash = number[];

export function aHash(source: CanvasImageSource): AHash {
  const SIZE = 8;
  const off = new OffscreenCanvas(SIZE, SIZE);
  const ctx = off.getContext('2d')!;
  ctx.drawImage(source, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const grays: number[] = [];
  for (let i = 0; i < px.length; i += 4) {
    grays.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
  }
  const mean = grays.reduce((a, b) => a + b, 0) / grays.length;
  return grays.map(g => (g >= mean ? 1 : 0));
}

export function hamming(h1: AHash, h2: AHash): number {
  let d = 0;
  for (let i = 0; i < h1.length; i++) if (h1[i] !== h2[i]) d++;
  return d;
}

// Settings' "Change threshold" field is free-typed, 0-10 inclusive.
export function clampThreshold(raw: number): number {
  return Math.max(0, Math.min(10, raw));
}

// A frame is kept as a new keyframe when there's no prior hash to compare
// against (the very first frame), or when it's changed enough from the last
// kept frame -- strictly more than `threshold` bits different out of 64.
export function shouldKeepAsKeyframe(hash: AHash, lastHash: AHash | null, threshold: number): boolean {
  return !lastHash || hamming(hash, lastHash) > threshold;
}
