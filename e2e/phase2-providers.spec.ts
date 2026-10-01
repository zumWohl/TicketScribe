// Phase 2 gate: API keys round-trip through the main-process safeStorage-backed
// store and never land back in the renderer (localStorage or window), and the
// `generate` IPC channel reaches the echo test provider end-to-end -- only
// when TICKETSCRIBE_TEST_PROVIDER=echo is set.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');
const TEST_KEY = 'sk-ant-test-phase2-DO-NOT-LEAK-1234567890';

// Every launch gets its own --user-data-dir: this spec writes a real API key
// to disk (via safeStorage), and must never touch the real app's userData
// (generic Electron fallback or a packaged TicketScribe profile).
function tempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ticketscribe-e2e-userdata-'));
}

test('API key round-trips via safeStorage and never reaches the renderer', async () => {
  const userDataDir = tempUserDataDir();
  let app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  let page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  await page.evaluate(key => window.ticketScribe.setApiKey('claude', key), TEST_KEY);
  await app.close();

  // Restart (same profile dir): the key must survive in the on-disk store
  // (userData), not in any renderer-visible storage.
  app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const hasKey = await page.evaluate(() => window.ticketScribe.hasApiKey('claude'));
  expect(hasKey).toBe(true);

  const haystack = await page.evaluate(() => {
    const parts: string[] = [];
    try { parts.push(JSON.stringify(localStorage)); } catch { /* ignore */ }
    for (const k of Object.keys(window as unknown as Record<string, unknown>)) {
      try {
        const v = (window as unknown as Record<string, unknown>)[k];
        if (typeof v === 'function') continue;
        parts.push(JSON.stringify(v));
      } catch { /* circular/unserializable, skip */ }
    }
    parts.push(document.documentElement.outerHTML);
    return parts.join('\n');
  });
  expect(haystack.includes(TEST_KEY)).toBe(false);

  await app.close();
});

test('generate() reaches the echo provider end to end, gated by the env var', async () => {
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${tempUserDataDir()}`],
    env: { ...process.env, TICKETSCRIBE_TEST_PROVIDER: 'echo' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  const result = await page.evaluate(() => window.ticketScribe.generate({
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
    window.ticketScribe
      .generate({ provider: 'echo', frames: [], activityTimelineText: '', templateContent: '' })
      .then(() => null)
      .catch((e: Error) => e.message),
  );
  expect(error).toMatch(/not enabled/);

  await app.close();
});
