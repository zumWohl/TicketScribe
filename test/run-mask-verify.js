// Headless Electron harness for the destructive-masking pixel test. Loads
// test/mask-verify.html in a hidden renderer, waits for its result, prints it,
// and exits non-zero on failure so it works as `npm test`.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let done = false;
function finish(code, payload) {
  if (done) return;
  done = true;
  if (payload) console.log(JSON.stringify(payload, null, 2));
  console.log(code === 0 ? '\nMASK VERIFY: PASS' : '\nMASK VERIFY: FAIL');
  app.exit(code);
}

ipcMain.on('mask-verify-result', (_e, payload) => {
  finish(payload && payload.pass ? 0 : 1, payload);
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 400, height: 300,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: false },
  });
  win.loadFile(path.join(__dirname, 'mask-verify.html'));
  setTimeout(() => finish(2, { pass: false, error: 'timed out waiting for result' }), 30000);
});

app.on('window-all-closed', () => {}); // keep alive until finish()
