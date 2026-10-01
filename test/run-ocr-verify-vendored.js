// Headless Electron harness for the Phase 5 vendored-tesseract-asset test.
// Loads the BUILT out/renderer/ocr-verify.html directly via file:// (same
// loading style the plan sanctions for pre-Phase-7 testing: launch compiled
// output directly rather than through electron-builder, which doesn't yet
// package out/** -- see MIGRATION.md's "Never point package.json main at
// build output before Phase 8" note). Run with --proxy-server=127.0.0.1:9
// (see package.json's test:ocr:offline script) to prove zero CDN dependency:
// that address refuses connections, so any network fetch fails fast instead
// of hanging.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let done = false;
function finish(code, payload) {
  if (done) return;
  done = true;
  if (payload) console.log(JSON.stringify(payload, null, 2));
  console.log(code === 0 ? '\nOCR VERIFY (vendored, offline): PASS' : '\nOCR VERIFY (vendored, offline): FAIL');
  app.exit(code);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 400, height: 300,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: false },
  });

  const cspViolations = [];
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level < 2) return; // 2 = warning, 3 = error in Electron's console-message levels
    if (/content security policy/i.test(message)) cspViolations.push(message);
    else if (level === 3) consoleErrors.push(message);
  });

  win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'ocr-verify.html'));

  const poll = setInterval(async () => {
    const result = await win.webContents.executeJavaScript(
      'window.__ocrVerifyDone ? JSON.stringify(window.__ocrVerifyPayload) : null',
    ).catch(() => null);
    if (result) {
      clearInterval(poll);
      const payload = JSON.parse(result);
      const pass = Boolean(payload && payload.pass) && cspViolations.length === 0;
      finish(pass ? 0 : 1, { ...payload, cspViolations, consoleErrors });
    }
  }, 500);

  setTimeout(() => finish(2, { pass: false, error: 'timed out waiting for result' }), 60000);
});

app.on('window-all-closed', () => {});
