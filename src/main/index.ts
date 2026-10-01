import { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import * as eventsCapture from './events-capture';
import type { EventsStartOptions, EventsStopOptions } from '../shared/events';
import type { GenerateRequest } from '../shared/generate';
import * as providers from './providers';
import * as keys from './keys';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    minWidth: 960,
    minHeight: 660,
    title: 'Cardonet Capture',
    backgroundColor: '#EDECF0',
    webPreferences: {
      // Phase 6a: the renderer sandbox goes on now that the React port is
      // complete and uses only window.ticketScribe (contextBridge), never a
      // direct Node/Electron require().
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  // Phase 6a: the React renderer takes over from the legacy HTML/JS. Dev
  // mode loads electron-vite's dev server (hot reload); a built app loads
  // the compiled out/renderer/index.html directly (out/main/ -> out/renderer/
  // is one level up, then down into renderer/).
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

// Return capture sources so the renderer can pick one for getUserMedia.
// `types` selects screens (default) or individual windows -- the UI offers
// an "Entire screen" vs "Single window" capture source choice, and (when more
// than one display is attached) which display to record.
//
// Mapping ported from CardonetCapture's listCaptureSources: each source is
// normalised to { id, name, type, thumbnail }. For screens we additionally
// match the DesktopCapturerSource to its Display via `display_id` and fold the
// resolution + a "Primary" tag into the name, so multiple monitors read as
// e.g. "Screen 1 · 2560×1440 · Primary" / "Screen 2 · 1920×1080" instead of
// indistinguishable "Entire screen" entries.
ipcMain.handle('get-sources', async (_e, opts: { types?: string[] } | undefined) => {
  const types = opts && Array.isArray(opts.types) && opts.types.length ? opts.types : ['screen'];
  const sources = await desktopCapturer.getSources({
    types: types as Array<'screen' | 'window'>,
    thumbnailSize: { width: 320, height: 180 },
  });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return sources.map(s => {
    const isScreen = s.id.startsWith('screen');
    let name = s.name || (isScreen ? 'Entire screen' : 'Window');
    if (isScreen && s.display_id) {
      const d = displays.find(dd => String(dd.id) === String(s.display_id));
      if (d) {
        const w = Math.round(d.size.width * d.scaleFactor);
        const h = Math.round(d.size.height * d.scaleFactor);
        name = `${name} · ${w}×${h}${d.id === primaryId ? ' · Primary' : ''}`;
      }
    }
    return {
      id: s.id,
      name,
      type: isScreen ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    };
  });
});

// Write the confirmed summary text to Documents/TicketScribe/
ipcMain.handle('save-summary', async (_e, { filename, content }: { filename: string; content: string }) => {
  try {
    const dir = path.join(app.getPath('documents'), 'TicketScribe');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, content, 'utf8');
    return { ok: true, path: filepath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// Open the TicketScribe documents folder in Explorer
ipcMain.handle('open-folder', async () => {
  const dir = path.join(app.getPath('documents'), 'TicketScribe');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// Event-stream capture (window/app activity, terminal history, browser
// history) -- see main/events-capture.ts for the source-by-source detail.
ipcMain.handle('events:start', (_e, opts: EventsStartOptions) => {
  eventsCapture.start(opts);
});
ipcMain.handle('events:stop', (_e, opts: EventsStopOptions) => {
  return eventsCapture.stop(opts);
});
ipcMain.handle('events:get-transcript-snippet', () => {
  return eventsCapture.getTranscriptProfileSnippet();
});

// Summary generation (Ollama/Claude/echo) -- moved to the main process so API
// keys and the fetch itself never touch the renderer/CSP. See
// src/main/providers/index.ts for the dispatcher.
ipcMain.handle('generate', (_e, request: GenerateRequest) => {
  return providers.generate(request);
});
ipcMain.handle('keys:set', (_e, provider: string, key: string) => {
  keys.setApiKey(provider, key);
});
ipcMain.handle('keys:has', (_e, provider: string) => {
  return keys.hasApiKey(provider);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
