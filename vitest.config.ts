import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live under src/; e2e/ holds Playwright specs with their own
    // test() identity (@playwright/test), which must never be collected here.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // No unit tests exist yet at Phase 0 — real suites land in Phases 1-3.
    // Without this, `vitest run` (and thus CI) fails on an empty test dir.
    passWithNoTests: true,
  },
});
