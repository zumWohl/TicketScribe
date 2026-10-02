// Headless Electron harness for the OCR verification test. Loads
// test/ocr-verify.html in a hidden renderer, waits for its result, prints
// it, and exits non-zero on failure so it works as `npm run test:ocr`. Mirrors
// run-mask-verify.js's structure.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let done = false;
function finish(code, payload) {
  if (done) return;
  done = true;
  if (payload) console.log(JSON.stringify(payload, null, 2));
  console.log(code === 0 ? '\nOCR VERIFY: PASS' : '\nOCR VERIFY: FAIL');
  app.exit(code);
}

ipcMain.on('ocr-verify-result', (_e, payload) => {
  finish(payload && payload.pass ? 0 : 1, payload);
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 400, height: 300,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: false },
  });
  win.loadFile(path.join(__dirname, 'ocr-verify.html'));
  // OCR (worker init + traineddata fetch + recognize) is slower than
  // mask-verify's pure-canvas math -- allow more time before giving up.
  setTimeout(() => finish(2, { pass: false, error: 'timed out waiting for result' }), 60000);
});

app.on('window-all-closed', () => {}); // keep alive until finish()
