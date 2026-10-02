// Gate: the `generate` IPC channel's 'claude' provider is routed through the
// real azure.ts module (not mocked) -- endpoint/deployment/key now come from
// AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_DEPLOYMENT/AZURE_OPENAI_KEY environment
// variables rather than Settings/safeStorage, so these tests launch the app
// with a controlled env instead of driving Settings fields or calling
// setApiKey. The last test only runs when real credentials are present, and
// produces one real summary against a live Azure OpenAI deployment.
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

// Strip the three Azure env vars from the launched app's environment so each
// "missing config" test gets a clean slate regardless of the host shell.
function envWithout(...keys: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  keys.forEach(k => delete env[k]);
  return env;
}

test('claude provider (routed through Azure): missing endpoint/deployment surfaces its own validation error', async () => {
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`],
    env: envWithout('AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_KEY'),
  });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const error = await page.evaluate((dataUrl) =>
    window.cardonetCapture
      .generate({
        provider: 'claude',
        frames: [{ timestamp: Date.now(), dataUrl, ocrText: '' }],
        activityTimelineText: '',
        templateContent: '',
      })
      .then(() => null)
      .catch((e: Error) => e.message), TEST_FRAME_DATA_URL);
  expect(error).toMatch(/endpoint\/deployment not set/);

  await app.close();
});

test('claude provider (routed through Azure): endpoint/deployment set but no key surfaces its own validation error', async () => {
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`],
    env: {
      ...envWithout('AZURE_OPENAI_KEY'),
      AZURE_OPENAI_ENDPOINT: 'unused-resource.openai.azure.com',
      AZURE_OPENAI_DEPLOYMENT: 'unused-deployment',
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const error = await page.evaluate((dataUrl) =>
    window.cardonetCapture
      .generate({
        provider: 'claude',
        frames: [{ timestamp: Date.now(), dataUrl, ocrText: '' }],
        activityTimelineText: '',
        templateContent: '',
      })
      .then(() => null)
      .catch((e: Error) => e.message), TEST_FRAME_DATA_URL);
  expect(error).toMatch(/No Azure OpenAI API key/);

  await app.close();
});

const { AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_KEY } = process.env;
const hasRealCredentials = Boolean(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_DEPLOYMENT && AZURE_OPENAI_KEY);

(hasRealCredentials ? test : test.skip)(
  'claude provider (routed through Azure): real deployment produces a real summary (requires AZURE_OPENAI_ENDPOINT/DEPLOYMENT/KEY)',
  async () => {
    const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`] });
    const page = await app.firstWindow();
    await page.waitForSelector('body[data-stage="ready"]');

    const summary = await page.evaluate(
      ({ dataUrl }) =>
        window.cardonetCapture.generate({
          provider: 'claude',
          frames: [{ timestamp: Date.now(), dataUrl, ocrText: '' }],
          activityTimelineText: '',
          templateContent: '',
        }),
      { dataUrl: TEST_FRAME_DATA_URL },
    );
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    console.log('Azure real-credential summary:', summary);

    await app.close();
  },
);
