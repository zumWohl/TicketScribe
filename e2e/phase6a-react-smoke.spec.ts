// Phase 6a smoke test: does the React-ported renderer actually load, with
// zero console errors/CSP violations, and does the basic ready-stage UI
// respond? Full walkthrough/visual-diff/generate gates live in
// phase6a-full-flow.spec.ts and phase6a-visual-diff.spec.ts; this is the
// fast sanity check.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

test('React renderer loads cleanly on the ready stage', async () => {
  const app = await electron.launch({ args: [mainEntry] });
  const page = await app.firstWindow();

  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(String(err)));

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 10000 });
  await page.waitForSelector('#app .titlebar .brand-sub');
  await page.waitForTimeout(500);

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);

  // Basic interaction: switch to screen source, templates, settings, and back.
  await page.click('.source-tile:has-text("Entire screen")');
  await page.waitForTimeout(100);
  await page.click('.nav-item:has-text("Summary Templates")');
  await page.waitForSelector('body[data-screen="templates"]');
  await page.click('.nav-item:has-text("Settings")');
  await page.waitForSelector('body[data-screen="settings"]');
  await page.click('.nav-item:has-text("New Recording")');
  await page.waitForSelector('body[data-screen="work"]');

  expect(consoleErrors, `console errors after interaction:\n${consoleErrors.join('\n')}`).toHaveLength(0);

  await app.close();
});
