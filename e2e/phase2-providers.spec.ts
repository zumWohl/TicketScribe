// Phase 2 gate: the `generate` IPC channel reaches the echo test provider
// end-to-end -- only when CARDONETCAPTURE_TEST_PROVIDER=echo is set.
//
// The API-key round-trip test that used to live here was removed once Claude
// summaries were rerouted through the org's Azure deployment: credentials
// are now operator-configured via AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_DEPLOYMENT/
// AZURE_OPENAI_KEY environment variables (see src/main/providers/index.ts),
// never entered in Settings or stored via safeStorage, so there is no longer
// an IPC-exposed key to round-trip.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

function tempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
}

test('generate() reaches the echo provider end to end, gated by the env var', async () => {
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`],
    env: { ...process.env, CARDONETCAPTURE_TEST_PROVIDER: 'echo' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const result = await page.evaluate(() => window.cardonetCapture.generate({
    provider: 'echo',
    frames: [{ timestamp: Date.now(), dataUrl: 'data:image/jpeg;base64,AAAA', ocrText: '' }],
    activityTimelineText: 'abc',
    templateContent: '',
  }));
  expect(result).toBe('- echo: 1 frame(s), 3 activity-timeline char(s)');

  await app.close();
});

test('echo provider is unreachable without the env var', async () => {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`] });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const error = await page.evaluate(() =>
    window.cardonetCapture
      .generate({ provider: 'echo', frames: [], activityTimelineText: '', templateContent: '' })
      .then(() => null)
      .catch((e: Error) => e.message),
  );
  expect(error).toMatch(/not enabled/);

  await app.close();
});
