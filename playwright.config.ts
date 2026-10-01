import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // legacy-baseline.spec.ts did its one-time job at Gate 0 (creating
  // e2e/baseline/*.png) and must never run again: it unconditionally
  // regenerates those frozen reference images as a side effect. Running it
  // in the same invocation as any later visual-diff spec (phase6a-visual-diff,
  // etc.) corrupts the baseline those specs compare against *before* a
  // post-hoc `git checkout -- e2e/baseline` ever gets a chance to restore
  // it -- confirmed as the actual cause of an intermittent-looking "6.40%
  // pixels differ" failure that was really "comparing against a baseline
  // regenerated moments earlier in this same run, at a different display
  // scale." Run it explicitly by path if it's ever genuinely needed again.
  testIgnore: ['**/legacy-baseline.spec.ts'],
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
