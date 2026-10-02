// Visual-parity baseline for the legacy (pre-migration) app. Launches the
// legacy Electron app exactly as `npm start` would, walks every screen/stage
// reachable without real providers or real sensitive on-screen content, and
// saves screenshots to e2e/baseline/. These images are the reference for the
// Phase 6a/6b gates and must never be regenerated after Gate 0.
import { test, _electron as electron, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const repoRoot = path.resolve(__dirname, '..');
const baselineDir = path.join(__dirname, 'baseline');
const reachability: Record<string, unknown> = {};

test('legacy app baseline walkthrough', async () => {
  fs.mkdirSync(baselineDir, { recursive: true });

  const app = await electron.launch({ args: ['.'], cwd: repoRoot });
  const page: Page = await app.firstWindow();
  page.on('dialog', d => { d.dismiss().catch(() => {}); });
  await page.waitForLoadState('domcontentloaded');

  async function shot(name: string) {
    await page.screenshot({ path: path.join(baselineDir, `${name}.png`) });
    reachability[name] = true;
  }

  // ---- Ready stage, default source = single window ----
  await page.waitForSelector('body[data-stage="ready"]');
  await shot('01-ready-window-source');

  // ---- Source picker: entire screen ----
  await page.click('#src-screen');
  await page.waitForTimeout(300);
  await shot('02-ready-screen-source');
  reachability['screen-picker-shown-multi-display'] = await page.isVisible('#screen-picker');

  await page.click('#src-window');
  await page.waitForTimeout(200);

  // ---- Summary Templates screen ----
  await page.click('#nav-templates');
  await page.waitForTimeout(200);
  await shot('03-templates');

  // ---- Settings screen ----
  await page.click('#nav-settings');
  await page.waitForTimeout(200);
  await shot('04-settings');

  // ---- Back to work/ready ----
  await page.click('#nav-work');
  await page.waitForTimeout(200);
  await shot('05-ready-again');

  // ---- Recording pipeline, as far as it goes without a real provider ----
  try {
    await page.click('#btn-start');
    await page.waitForSelector('body[data-stage="countdown"]', { timeout: 3000 });
    await shot('06-countdown');

    await page.waitForSelector('body[data-stage="recording"]', { timeout: 8000 });
    await shot('07-recording');

    // Let the 1500ms keyframe interval capture a couple of frames.
    await page.waitForTimeout(3500);

    await page.click('#btn-stop');
    await page.waitForSelector(
      'body[data-stage="review"], body[data-stage="ready"]',
      { timeout: 10000 },
    );
    const stage = await page.getAttribute('body', 'data-stage');
    reachability['stage-after-stop'] = stage;
    if (stage === 'review') {
      await page.waitForTimeout(2000); // let analyzeFrames()'s OCR pass settle
      await shot('08-review');
    }
  } catch (err) {
    reachability['recording-pipeline-error'] = err instanceof Error ? err.message : String(err);
  }

  fs.writeFileSync(
    path.join(baselineDir, 'reachability.json'),
    JSON.stringify(reachability, null, 2),
  );

  await app.close();
});
