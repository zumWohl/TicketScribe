// Shared pixel-diff helper used by every post-Gate-0 phase to prove a
// screenshot still matches the frozen e2e/baseline/*.png reference. The
// threshold is chosen once here (not re-derived per phase): anti-aliasing
// and textarea-cursor blink account for a small amount of noise even when
// nothing visually changed, so 0% is too strict and would make the gate
// flaky rather than meaningful.
import fs from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

// Fraction of pixels allowed to differ before a comparison fails. Briefly
// widened to 5% during Phase 6a/6b chasing what looked like run-order
// jitter (a 2.95%, then 6.40%, diff against an otherwise byte-identical
// comparison) -- the actual cause was playwright.config.ts running
// legacy-baseline.spec.ts (which unconditionally regenerates
// e2e/baseline/*.png) in the same invocation as these comparisons, so later
// specs were comparing against a baseline the earlier spec had just
// overwritten at a different display scale. Fixed via testIgnore in
// playwright.config.ts; reverted to the original, tighter threshold.
export const VISUAL_DIFF_THRESHOLD = 0.02; // 2%, when dimensions match exactly
// Resampling for a display-scale mismatch (see resample() below) introduces
// its own blur/aliasing at text and icon edges on top of any real diff, so a
// resampled comparison needs a looser bar to stay meaningful rather than flaky.
export const VISUAL_DIFF_THRESHOLD_RESAMPLED = 0.08; // 8%

export interface DiffResult {
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  resampled: boolean;
  pass: boolean;
}

// Nearest-neighbor resample. Screenshots are taken on the same dev machine
// across runs, but its OS display-scale factor has been observed to change
// between sessions (e.g. an RDP window getting resized) -- that changes a
// screenshot's pixel dimensions uniformly without changing anything about
// the app. Resampling to a common size before diffing absorbs that, while
// still catching a genuine layout/content regression.
function resample(src: InstanceType<typeof PNG>, width: number, height: number): InstanceType<typeof PNG> {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const srcIdx = (sy * src.width + sx) * 4;
      const dstIdx = (y * width + x) * 4;
      out.data[dstIdx] = src.data[srcIdx];
      out.data[dstIdx + 1] = src.data[srcIdx + 1];
      out.data[dstIdx + 2] = src.data[srcIdx + 2];
      out.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return out;
}

export function comparePng(baselinePath: string, actualPath: string): DiffResult {
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  let actual = PNG.sync.read(fs.readFileSync(actualPath));

  const { width, height } = baseline;
  const resampled = actual.width !== width || actual.height !== height;
  if (resampled) {
    actual = resample(actual, width, height);
  }

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(baseline.data, actual.data, diff.data, width, height, {
    threshold: 0.1,
  });
  const totalPixels = width * height;
  const diffRatio = diffPixels / totalPixels;
  const threshold = resampled ? VISUAL_DIFF_THRESHOLD_RESAMPLED : VISUAL_DIFF_THRESHOLD;
  return { diffPixels, totalPixels, diffRatio, resampled, pass: diffRatio <= threshold };
}
