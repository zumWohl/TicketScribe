// Phase 7 gate: the same full record -> review -> mask (destructive
// redaction, i.e. mask-verify's concern) -> generate -> save pipeline as
// Phase 6a's gate, but against the actual packaged --dir exe (not
// out/main/index.js directly) -- proving the packaged app, with its real
// (trimmed) node_modules and out/** layout, still works end to end,
// including OCR against the packaged build's shipped vendored tesseract
// assets, with zero CSP violations.
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runFullFlow } from './full-flow-helper';

const repoRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'dist', 'win-unpacked', 'CardonetCapture.exe');

test('packaged exe: full record -> review -> mask -> generate -> save pipeline', async () => {
  test.setTimeout(120000);
  expect(fs.existsSync(exePath), `expected ${exePath} to exist -- run npm run dist or electron-builder --dir first`).toBe(true);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
  const app = await electron.launch({
    executablePath: exePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, CARDONETCAPTURE_TEST_PROVIDER: 'echo' },
  });

  const { consoleErrors, cspViolations } = await runFullFlow(app);

  expect(cspViolations, `CSP violations:\n${cspViolations.join('\n')}`).toHaveLength(0);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);

  await app.close();
});
