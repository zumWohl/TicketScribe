// Originally a Phase 0 gate ("does packaging still work after the new
// toolchain lands"); as of Phase 7, electron-builder.yml ships out/** (the
// React app) as the packaged entry instead of the legacy main.js/renderer --
// this now smoke-tests the real, shipped packaged app.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'dist', 'win-unpacked', 'TicketScribe.exe');

test('packaged --dir exe opens the app', async () => {
  const app = await electron.launch({ executablePath: exePath });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 15000 });
  const screen = await page.getAttribute('body', 'data-screen');
  expect(screen).toBe('work');
  await app.close();
});
