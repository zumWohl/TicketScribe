// Phase 1 gate: the ported TypeScript main process (out/main/index.js),
// still loading the legacy renderer, (a) still returns real capture sources
// over the get-sources IPC channel, and (b) still renders pixel-identical to
// the Gate 0 baseline screenshots (renderer didn't change in this phase).
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { comparePng, VISUAL_DIFF_THRESHOLD, VISUAL_DIFF_THRESHOLD_RESAMPLED } from './visual-diff';

const repoRoot = path.resolve(__dirname, '..');
const baselineDir = path.join(__dirname, 'baseline');
const actualDir = path.join(__dirname, 'phase1-actual');

test('ported TS main process: get-sources works and renderer is visually unchanged', async () => {
  fs.mkdirSync(actualDir, { recursive: true });

  const app = await electron.launch({ args: [path.join(repoRoot, 'out/main/index.js')] });
  const page: Page = await app.firstWindow();
  page.on('dialog', d => { d.dismiss().catch(() => {}); });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('body[data-stage="ready"]');

  // (a) get-sources over IPC, called directly via the legacy renderer's
  // nodeIntegration:true require('electron') -- same path the UI itself uses.
  const sources = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ipcRenderer } = require('electron');
    return ipcRenderer.invoke('get-sources', { types: ['window'] });
  });
  expect(Array.isArray(sources)).toBe(true);
  expect(sources.length).toBeGreaterThan(0);

  // (b) visual parity against the Gate 0 baseline for every reachable stage.
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

  await page.click('#src-screen');
  await page.waitForTimeout(300);
  await shotAndCompare('02-ready-screen-source');

  await page.click('#src-window');
  await page.waitForTimeout(200);

  await page.click('#nav-templates');
  await page.waitForTimeout(200);
  await shotAndCompare('03-templates');

  await page.click('#nav-settings');
  await page.waitForTimeout(200);
  await shotAndCompare('04-settings');

  await page.click('#nav-work');
  await page.waitForTimeout(200);
  await shotAndCompare('05-ready-again');

  await app.close();
});
