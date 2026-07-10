const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const eventsCapture = require('./main/events-capture');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    minWidth: 960,
    minHeight: 660,
    title: 'Cardonet Capture',
    backgroundColor: '#EDECF0',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Return capture sources so the renderer can pick one for getUserMedia.
// `types` selects screens (default) or individual windows -- the UI offers
// an "Entire screen" vs "Single window" capture source choice.
ipcMain.handle('get-sources', async (_e, opts) => {
  const types = (opts && Array.isArray(opts.types) && opts.types.length) ? opts.types : ['screen'];
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// Write the confirmed summary text to Documents/TicketScribe/
ipcMain.handle('save-summary', async (_e, { filename, content }) => {
  try {
    const dir = path.join(app.getPath('documents'), 'TicketScribe');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, content, 'utf8');
    return { ok: true, path: filepath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Open the TicketScribe documents folder in Explorer
ipcMain.handle('open-folder', async () => {
  const dir = path.join(app.getPath('documents'), 'TicketScribe');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// Event-stream capture (window/app activity, terminal history, browser
// history) -- see main/events-capture.js for the source-by-source detail.
ipcMain.handle('events:start', (_e, opts) => {
  eventsCapture.start(opts);
});
ipcMain.handle('events:stop', (_e, opts) => {
  return eventsCapture.stop(opts);
});
ipcMain.handle('events:get-transcript-snippet', () => {
  return eventsCapture.getTranscriptProfileSnippet();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
