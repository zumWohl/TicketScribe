import { contextBridge, ipcRenderer } from 'electron';
import type { EventsStartOptions, EventsStopOptions, ActivityEvent } from '../shared/events';
import type { GenerateRequest } from '../shared/generate';

const api = {
  getSources: (opts: { types?: string[] }) => ipcRenderer.invoke('get-sources', opts),
  saveSummary: (payload: { filename: string; content: string }) => ipcRenderer.invoke('save-summary', payload),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  eventsStart: (opts: EventsStartOptions) => ipcRenderer.invoke('events:start', opts),
  eventsStop: (opts: EventsStopOptions): Promise<ActivityEvent[]> => ipcRenderer.invoke('events:stop', opts),
  getTranscriptSnippet: (): Promise<string> => ipcRenderer.invoke('events:get-transcript-snippet'),
  generate: (payload: GenerateRequest): Promise<string> => ipcRenderer.invoke('generate', payload),
};

export type CardonetCaptureApi = typeof api;

// `nodeIntegration` stays on and `contextIsolation` stays off until the end
// of Phase 6a, so `process.contextIsolated` is false today and this falls
// through to the plain-window-property branch. Both branches are kept (and
// exercised once isolation flips) so this file doesn't need to change then.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('cardonetCapture', api);
} else {
  // Preload's tsconfig has no DOM lib (main-process types only), and `window`
  // and `globalThis` are the same object in a preload script's realm either
  // way, so go through globalThis to avoid needing one just for this line.
  (globalThis as typeof globalThis & { cardonetCapture: CardonetCaptureApi }).cardonetCapture = api;
}
