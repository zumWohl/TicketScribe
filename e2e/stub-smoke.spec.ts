// Phase 0 gate: the compiled electron-vite stub launches cleanly, with zero
// console errors and zero CSP violations. Exercised against the raw
// `out/main/index.js` build output (electron-builder packaging is checked
// separately).
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');

test('built stub opens with no console errors or CSP violations', async () => {
  const app = await electron.launch({ args: [path.join(repoRoot, 'out/main/index.js')] });
  const page = await app.firstWindow();

  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Content Security Policy/i.test(text)) cspViolations.push(text);
    else consoleErrors.push(text);
  });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#root h1');
  await page.waitForTimeout(500); // let any async console errors land

  expect(cspViolations, `CSP violations:\n${cspViolations.join('\n')}`).toHaveLength(0);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);

  await app.close();
});
