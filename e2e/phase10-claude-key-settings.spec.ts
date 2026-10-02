// Phase 10 regression test for a real bug found while adding the Azure
// provider's Settings fields: the Anthropic API key field persisted its
// value to localStorage (`anthropicApiKey`) via `saveSettings()`, but
// `claude.ts`'s `generate()` only ever reads the key from the safeStorage-
// backed store (`getApiKey('claude')`) -- so a key typed into Settings
// never reached safeStorage, and Claude was unreachable through the real
// UI (only via a direct `window.cardonetCapture.setApiKey` IPC call, as in
// phase2-providers.spec.ts). Fixed so `saveSettings()` now forwards a
// non-blank key field to `setApiKey('claude', ...)`, same pattern as the
// new Azure key field. This drives the real Settings UI end-to-end rather
// than bypassing it via `page.evaluate`, to actually exercise the fix.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

function tempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
}

test('Claude API key typed into Settings reaches safeStorage via the real UI', async () => {
  const userDataDir = tempUserDataDir();
  let app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  let page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  await page.click('.nav-item:has-text("Settings")');
  await page.waitForSelector('body[data-screen="settings"]');
  await expect(page.locator('label[for="s-anthropic-key"]')).not.toContainText('saved');

  await page.fill('#s-anthropic-key', 'sk-ant-e2e-test-key-DO-NOT-LEAK');
  await page.click('button:has-text("Save settings")');
  await page.waitForSelector('body[data-screen="work"]');
  await app.close();

  // Restart on the same profile: the key must have actually reached
  // safeStorage (survives a relaunch), not just sat in localStorage.
  app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');
  const hasKey = await page.evaluate(() => window.cardonetCapture.hasApiKey('claude'));
  expect(hasKey).toBe(true);

  await page.click('.nav-item:has-text("Settings")');
  await page.waitForSelector('body[data-screen="settings"]');
  await expect(page.locator('label[for="s-anthropic-key"]')).toContainText('saved');
  // The field never gets repopulated with the real key -- safeStorage
  // never exposes a decrypted key back to the renderer.
  expect(await page.locator('#s-anthropic-key').inputValue()).toBe('');

  await app.close();
});
