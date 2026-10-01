// Phase 10 gate: drives the real Settings UI (not a direct IPC call) to
// prove the Azure endpoint/deployment/key fields exist, "Test connection"
// reaches the real main-process azure.ts module and surfaces its error,
// and the key survives a relaunch via safeStorage while the field itself
// never gets repopulated with the real key.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

function tempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
}

test('Azure Settings fields: test connection surfaces a real error, key persists via safeStorage', async () => {
  const userDataDir = tempUserDataDir();
  let app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  let page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');

  await page.click('.nav-item:has-text("Settings")');
  await page.waitForSelector('body[data-screen="settings"]');
  await expect(page.locator('text=Azure OpenAI Configuration')).toBeVisible();

  await page.fill('#s-azure-endpoint', 'definitely-not-a-real-host.invalid');
  await page.fill('#s-azure-deployment', 'fake-deployment');
  await page.click('button:has-text("Test connection")');
  // No key saved yet -- azure.ts's own validation error, proving the click
  // reaches the real IPC/main-process path rather than a stub.
  await expect(page.locator('text=No Azure OpenAI API key')).toBeVisible({ timeout: 15000 });

  await page.fill('#s-azure-key', 'fake-azure-key-e2e-test');
  await page.click('button:has-text("Save settings")');
  await page.waitForSelector('body[data-screen="work"]');
  await app.close();

  app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] });
  page = await app.firstWindow();
  await page.waitForSelector('body[data-stage="ready"]');
  const hasKey = await page.evaluate(() => window.cardonetCapture.hasApiKey('azure'));
  expect(hasKey).toBe(true);

  await page.click('.nav-item:has-text("Settings")');
  await page.waitForSelector('body[data-screen="settings"]');
  await expect(page.locator('label[for="s-azure-key"]')).toContainText('saved');
  expect(await page.locator('#s-azure-key').inputValue()).toBe('');
  expect(await page.locator('#s-azure-endpoint').inputValue()).toBe('definitely-not-a-real-host.invalid');

  await app.close();
});
