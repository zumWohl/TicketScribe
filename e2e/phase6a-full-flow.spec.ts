// Phase 6a gate: full pipeline against the React renderer -- pick a window
// source, record ~5s, assert at least one keyframe captured, draw one mask
// on the review canvas, generate a summary, assert it appears, save, assert
// a file exists under Documents\TicketScribe with the expected content, then
// delete it.
//
// Capture/review/masking all go through the real UI. Generation uses the
// echo test provider invoked directly via window.ticketScribe (same pattern
// as Phase 2's provider spec) rather than clicking "Generate summary": the
// UI has no selector for echo by design (decision 10 -- "the renderer never
// has a way to pick 'echo' itself"), and summaryModel's own state typing
// correctly only ever normalizes to 'claude' | 'ollama', so there is no
// supported way to drive it from the UI. Exercising the real button here
// would just test the Ollama-unreachable failure path, which is a different,
// valid thing to test but not what this gate is after.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

test('full record -> review -> mask -> generate -> save pipeline', async () => {
  test.setTimeout(120000); // real OCR over real screen-capture frames, plus a possible retry
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticketscribe-e2e-userdata-'));
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, TICKETSCRIBE_TEST_PROVIDER: 'echo' },
  });
  const page = await app.firstWindow();
  page.on('dialog', d => { d.dismiss().catch(() => {}); });

  // runOCR() deliberately logs (console.error) and degrades gracefully, never
  // crashing, when OCR genuinely can't complete -- see ocr.ts's comment on
  // the fresh-profile worker-init timeout. That's an intentional, handled
  // outcome (matches the product's own "best-effort, not a guarantee"
  // language for auto-detection), not a bug this gate should fail on.
  const EXPECTED_ERROR_RE = /runOCR failed after \d+ attempt\(s\)/;
  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !EXPECTED_ERROR_RE.test(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => {
    if (!EXPECTED_ERROR_RE.test(String(err))) consoleErrors.push(String(err));
  });

  await page.waitForSelector('body[data-stage="ready"]');

  // Record (single-window source, the default).
  await page.click('button:has-text("Start Recording")');
  await page.waitForSelector('body[data-stage="countdown"]');
  await page.waitForSelector('body[data-stage="recording"]', { timeout: 8000 });
  await page.waitForTimeout(5000); // let a few keyframes get captured

  const frameCountText = await page.locator('.rec-stat .v').first().textContent();
  const frameCount = Number(frameCountText || '0');

  await page.click('button:has-text("Stop & review")');
  await page.waitForSelector('body[data-stage="review"]', { timeout: 10000 });
  // Wait for analyzeFrames() to finish (frame-empty scanning spinner gone).
  // Real OCR over a real (not synthetic) screen-capture frame, with a
  // worker-init timeout + one retry baked into runOCR() -- see
  // src/renderer/src/lib/ocr.ts for why that's needed.
  await page.waitForSelector('.preview-canvas:not(.hidden)', { timeout: 60000 });

  expect(frameCount, 'expected at least one keyframe captured').toBeGreaterThan(0);

  // Draw one mask on the review canvas.
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

  // Generate via the echo provider (direct IPC, see file header) and save.
  const result = await page.evaluate(async () => {
    const summary = await window.ticketScribe.generate({
      provider: 'echo',
      frames: [{ timestamp: Date.now(), dataUrl: 'data:image/jpeg;base64,AAAA', ocrText: '' }],
      activityTimelineText: '',
      templateContent: '',
    });
    const filename = `ticket-e2e-phase6a-${Date.now()}.txt`;
    const content = `Cardonet Capture — Work Note\n${'='.repeat(40)}\n\n${summary}\n`;
    const saveResult = await window.ticketScribe.saveSummary({ filename, content });
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

  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);

  await app.close();
});
