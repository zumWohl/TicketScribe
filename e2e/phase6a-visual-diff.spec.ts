// Phase 6a gate: the React renderer (styled with the unchanged legacy
// styles.css) renders pixel-equivalent to the Gate 0 baseline screenshots
// for every deterministic stage/screen (ready x2 source choices, templates,
// settings, ready-again). Countdown/recording/review aren't compared here
// for the same reason Phase 1 excluded them: a live timer and video frames
// are non-deterministic frame-to-frame even with zero visual regression.
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { comparePng, VISUAL_DIFF_THRESHOLD, VISUAL_DIFF_THRESHOLD_RESAMPLED } from './visual-diff';

const repoRoot = path.resolve(__dirname, '..');
const baselineDir = path.join(__dirname, 'baseline');
const actualDir = path.join(__dirname, 'phase6a-actual');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

test('React renderer is visually equivalent to the Gate 0 baseline', async () => {
  fs.mkdirSync(actualDir, { recursive: true });

  const app = await electron.launch({ args: [mainEntry] });
  const page: Page = await app.firstWindow();
  page.on('dialog', d => { d.dismiss().catch(() => {}); });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('body[data-stage="ready"]');

  async function shotAndCompare(name: string) {
    const actualPath = path.join(actualDir, `${name}.png`);
    await page.screenshot({ path: actualPath });
    const result = comparePng(path.join(baselineDir, `${name}.png`), actualPath);
    const threshold = result.resampled ? VISUAL_DIFF_THRESHOLD_RESAMPLED : VISUAL_DIFF_THRESHOLD;
    expect(
      result.pass,
      `${name}: ${(result.diffRatio * 100).toFixed(2)}% pixels differ (threshold ${threshold * 100}%` +
        `${result.resampled ? ', resampled: baseline/actual display-scale differs' : ''})`,
    ).toBe(true);
  }

  await shotAndCompare('01-ready-window-source');

  await page.click('.source-tile:has-text("Entire screen")');
  await page.waitForTimeout(300);
  await shotAndCompare('02-ready-screen-source');

  await page.click('.source-tile:has-text("Single window")');
  await page.waitForTimeout(200);

  await page.click('.nav-item:has-text("Summary Templates")');
  await page.waitForTimeout(200);
  await shotAndCompare('03-templates');

  await page.click('.nav-item:has-text("Settings")');
  await page.waitForTimeout(200);
  await shotAndCompare('04-settings');

  await page.click('.nav-item:has-text("New Recording")');
  await page.waitForTimeout(200);
  await shotAndCompare('05-ready-again');

  await app.close();
});
