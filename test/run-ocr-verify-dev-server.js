// Headless Electron harness for the Phase 5 "under electron-vite dev" leg.
// electron-vite's `dev` command is a thin wrapper that starts a Vite dev
// server for src/renderer and points an Electron window at it -- rather than
// orchestrating the full CLI, this starts the same kind of Vite dev server
// directly (vite.createServer, same root/base as electron.vite.config.ts's
// renderer block) and loads http://localhost:PORT/ocr-verify.html from it.
// This is the real risk Phase 5 flags for this leg: document.baseURI is an
// http://localhost origin here, not file://, so the vendored-asset relative
// URL derivation (new URL('vendor/tesseract/...', document.baseURI)) must
// resolve correctly against BOTH origins.
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let done = false;
let server = null;
async function finish(code, payload) {
  if (done) return;
  done = true;
  if (payload) console.log(JSON.stringify(payload, null, 2));
  console.log(code === 0 ? '\nOCR VERIFY (vendored, dev server): PASS' : '\nOCR VERIFY (vendored, dev server): FAIL');
  if (server) await server.close().catch(() => {});
  app.exit(code);
}

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    root: path.join(__dirname, '..', 'src', 'renderer'),
    base: './',
    server: { port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const port = server.httpServer.address().port;

  const win = new BrowserWindow({
    show: false,
    width: 400, height: 300,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: false },
  });

  const cspViolations = [];
  const consoleErrors = [];
  win.webContents.on('console-message', e => {
    console.log(`[renderer console, level ${e.level}] ${e.message}`);
    if (e.level < 2) return;
    if (/content security policy/i.test(e.message)) cspViolations.push(e.message);
    else if (e.level === 3) consoleErrors.push(e.message);
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log(`did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`);
  });

  const url = `http://localhost:${port}/ocr-verify.html`;
  console.log(`loading ${url}`);
  win.loadURL(url);

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
