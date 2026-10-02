// Phase 6a gate: full pipeline against the React renderer (out/main/index.js
// directly) -- pick a window source, record ~5s, assert at least one
// keyframe captured, draw one mask on the review canvas, generate a
// summary, assert it appears, save, assert a file exists under
// Documents\CardonetCapture with the expected content, then delete it.
// See full-flow-helper.ts for the walkthrough itself and why generation
// goes through window.cardonetCapture.generate directly (echo provider)
// rather than clicking "Generate summary".
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runFullFlow } from './full-flow-helper';

const repoRoot = path.resolve(__dirname, '..');
const mainEntry = path.join(repoRoot, 'out/main/index.js');

test('full record -> review -> mask -> generate -> save pipeline', async () => {
  test.setTimeout(120000); // real OCR over real screen-capture frames, plus a possible retry
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardonetcapture-e2e-userdata-'));
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CARDONETCAPTURE_TEST_PROVIDER: 'echo' },
  });

  const { consoleErrors, cspViolations } = await runFullFlow(app);

  expect(cspViolations, `CSP violations:\n${cspViolations.join('\n')}`).toHaveLength(0);
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);

  await app.close();
});
