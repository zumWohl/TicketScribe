const { app, BrowserWindow, ipcMain, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const eventsCapture = require('./main/events-capture');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 780,
    resizable: true,
    minWidth: 420,
    minHeight: 600,
    title: 'TicketScribe',
    backgroundColor: '#0d1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Return screen sources so the renderer can pick one for getUserMedia
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
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
