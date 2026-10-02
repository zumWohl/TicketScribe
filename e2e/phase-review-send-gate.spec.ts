// Gate for the review-stage send confirmation: clicking "Generate summary"
// must not send anything by itself -- it opens a confirmation modal showing
// the auto-masked region count and any not-yet-reviewed frame count, and
// only an explicit "Send to <model>" click in that modal actually starts
// generation ("Go back to review" must leave the review stage untouched).
// Drives the real buttons (not window.cardonetCapture.generate directly,
// unlike full-flow-helper.ts) because this test is specifically about the
// UI gate, not the generate() IPC call itself.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

test('Generate summary opens a confirmation gate; only confirming it sends', async () => {
  test.setTimeout(60000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  const page = await app.firstWindow();
  page.on('dialog', d => {
    d.dismiss().catch(() => {});
  });

  await page.waitForSelector('body[data-stage="ready"]');
  await page.click('button:has-text("Start Recording")');
  await page.waitForSelector('body[data-stage="countdown"]');
  await page.waitForSelector('body[data-stage="recording"]', { timeout: 8000 });
  await page.waitForTimeout(3000);

  await page.click('button:has-text("Stop & review")');
  await page.waitForSelector('body[data-stage="review"]', { timeout: 10000 });
  await page.waitForSelector('.preview-canvas:not(.hidden)', { timeout: 60000 });

  // Draw a mask so the confirmation text has a non-zero count to show.
  const canvasBox = await page.locator('.preview-canvas').boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox) {
    const x0 = canvasBox.x + canvasBox.width * 0.2;
    const y0 = canvasBox.y + canvasBox.height * 0.2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 40, y0 + 30, { steps: 5 });
    await page.mouse.up();
  }
  const maskedTotal = Number((await page.locator('.masked-badge span').first().textContent()) || '0');
  expect(maskedTotal).toBeGreaterThan(0);

  // The gate is not visible before clicking Generate summary.
  await expect(page.locator('.modal-scrim:has-text("Confirm redaction before sending")')).toHaveClass(/hidden/);

  await page.click('button:has-text("Generate summary")');
  const gate = page.locator('.modal-scrim:has-text("Confirm redaction before sending")');
  await expect(gate).not.toHaveClass(/hidden/);
  await expect(gate).toContainText(`${maskedTotal} region`);

  // "Go back to review" must close the gate without starting generation.
  await page.click('button:has-text("Go back to review")');
  await expect(gate).toHaveClass(/hidden/);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.body.dataset.stage)).toBe('review');

  // Confirming must actually start generation (stage moves to processing).
  await page.click('button:has-text("Generate summary")');
  await expect(gate).not.toHaveClass(/hidden/);
  await page.click('button:has-text("Send to")');
  await page.waitForSelector('body[data-stage="processing"]', { timeout: 10000 });

  await app.close();
});
