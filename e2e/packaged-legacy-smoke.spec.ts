// Phase 0 gate: electron-builder --dir still packages the (currently legacy)
// app correctly after the new Vite/TS/React/Tailwind toolchain was added as
// devDependencies plus react/react-dom as runtime deps. Drives the packaged
// --dir exe directly (not `npm start`) to catch any packaging regression the
// new node_modules tree might cause.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'dist', 'win-unpacked', 'TicketScribe.exe');

test('packaged --dir exe opens the legacy UI', async () => {
  const app = await electron.launch({ executablePath: exePath });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 15000 });
  const screen = await page.getAttribute('body', 'data-screen');
  expect(screen).toBe('work');
  await app.close();
});
