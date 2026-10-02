// Shared record -> review -> mask -> generate -> save walkthrough, used by
// both Phase 6a's gate (against out/main/index.js directly) and Phase 7's
// gate (against the actual packaged --dir exe). See phase6a-full-flow.spec.ts
// for why generation goes through window.cardonetCapture.generate directly
// (echo provider) rather than clicking "Generate summary".
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';

export interface FullFlowResult {
  consoleErrors: string[];
  cspViolations: string[];
}

const EXPECTED_ERROR_RE = /runOCR failed after \d+ attempt\(s\)/;

export async function runFullFlow(app: ElectronApplication): Promise<FullFlowResult> {
  const page: Page = await app.firstWindow();
  page.on('dialog', d => { d.dismiss().catch(() => {}); });

  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/content security policy/i.test(text)) { cspViolations.push(text); return; }
    if (EXPECTED_ERROR_RE.test(text)) return; // handled, documented OCR degradation
    consoleErrors.push(text);
  });
  page.on('pageerror', err => {
    const text = String(err);
    if (!EXPECTED_ERROR_RE.test(text)) consoleErrors.push(text);
  });

  await page.waitForSelector('body[data-stage="ready"]');

  await page.click('button:has-text("Start Recording")');
  await page.waitForSelector('body[data-stage="countdown"]');
  await page.waitForSelector('body[data-stage="recording"]', { timeout: 8000 });
  await page.waitForTimeout(5000); // let a few keyframes get captured

  const frameCountText = await page.locator('.rec-stat .v').first().textContent();
  const frameCount = Number(frameCountText || '0');

  await page.click('button:has-text("Stop & review")');
  await page.waitForSelector('body[data-stage="review"]', { timeout: 10000 });
  await page.waitForSelector('.preview-canvas:not(.hidden)', { timeout: 60000 });

  expect(frameCount, 'expected at least one keyframe captured').toBeGreaterThan(0);

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
  const maskedTotalText = await page.locator('.masked-badge span').first().textContent();
  expect(Number(maskedTotalText || '0')).toBeGreaterThan(0);

  const result = await page.evaluate(async () => {
    const summary = await window.cardonetCapture.generate({
      provider: 'echo',
      frames: [{ timestamp: Date.now(), dataUrl: 'data:image/jpeg;base64,AAAA', ocrText: '' }],
      activityTimelineText: '',
      templateContent: '',
    });
    const filename = `ticket-e2e-fullflow-${Date.now()}.txt`;
    const content = `Cardonet Capture — Work Note\n${'='.repeat(40)}\n\n${summary}\n`;
    const saveResult = await window.cardonetCapture.saveSummary({ filename, content });
    return { summary, saveResult };
  });

  expect(result.summary).toContain('echo:');
  expect(result.saveResult.ok).toBe(true);
  const savedPath = (result.saveResult as { path: string }).path;
  expect(fs.existsSync(savedPath)).toBe(true);
  const savedContent = fs.readFileSync(savedPath, 'utf8');
  expect(savedContent).toContain('Cardonet Capture');
  expect(savedContent).toContain('echo:');
  fs.unlinkSync(savedPath);

  return { consoleErrors, cspViolations };
}
