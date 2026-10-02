// Phase 10 gate: the `generate` IPC channel reaches the real azure.ts module
// (not mocked) for both of its own validation errors, and -- only when real
// credentials are present in the environment -- produces one real summary
// against a live Azure OpenAI deployment.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

const TEST_FRAME_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function tempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
}

test('azure provider: missing endpoint/deployment surfaces its own validation error', async () => {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`] });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const error = await page.evaluate((dataUrl) =>
    window.cardonetCapture
      .generate({
        provider: 'azure',
        frames: [{ timestamp: Date.now(), dataUrl, ocrText: '' }],
        activityTimelineText: '',
        templateContent: '',
      })
      .then(() => null)
      .catch((e: Error) => e.message), TEST_FRAME_DATA_URL);
  expect(error).toMatch(/endpoint\/deployment not set/);

  await app.close();
});

test('azure provider: endpoint/deployment set but no key surfaces its own validation error', async () => {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`] });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const error = await page.evaluate((dataUrl) =>
    window.cardonetCapture
      .generate({
        provider: 'azure',
        frames: [{ timestamp: Date.now(), dataUrl, ocrText: '' }],
        activityTimelineText: '',
        templateContent: '',
        azure: { endpoint: 'unused-resource.openai.azure.com', deployment: 'unused-deployment' },
      })
      .then(() => null)
      .catch((e: Error) => e.message), TEST_FRAME_DATA_URL);
  expect(error).toMatch(/No Azure OpenAI API key/);

  await app.close();
});

const { AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_KEY } = process.env;
const hasRealCredentials = Boolean(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_DEPLOYMENT && AZURE_OPENAI_KEY);

(hasRealCredentials ? test : test.skip)(
  'azure provider: real deployment produces a real summary (requires AZURE_OPENAI_ENDPOINT/DEPLOYMENT/KEY)',
  async () => {
    const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`] });
    const page = await app.firstWindow();
    await page.waitForSelector('body[data-stage="ready"]');

    await page.evaluate(key => window.cardonetCapture.setApiKey('azure', key), AZURE_OPENAI_KEY!);
    const summary = await page.evaluate(
      ({ dataUrl, endpoint, deployment }) =>
        window.cardonetCapture.generate({
          provider: 'azure',
          frames: [{ timestamp: Date.now(), dataUrl, ocrText: '' }],
          activityTimelineText: '',
          templateContent: '',
          azure: { endpoint, deployment },
        }),
      { dataUrl: TEST_FRAME_DATA_URL, endpoint: AZURE_OPENAI_ENDPOINT!, deployment: AZURE_OPENAI_DEPLOYMENT! },
    );
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    console.log('Azure real-credential summary:', summary);

    await app.close();
  },
);
