import { contextBridge, ipcRenderer } from 'electron';
import type { EventsStartOptions, EventsStopOptions, ActivityEvent } from '../shared/events';
import type { GenerateRequest } from '../shared/generate';

// Mirrors main/index.ts's get-sources handler return shape. Without this,
// getSources() resolves to Promise<any> and every call site's destructuring
// silently loses type safety (ipcRenderer.invoke's own return type is `any`).
export interface CaptureSourceInfo {
  id: string;
  name: string;
  type: 'window' | 'screen';
  thumbnail: string;
}

// Mirrors main/index.ts's save-summary handler return shape.
export interface SaveSummaryResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const api = {
  getSources: (opts: { types?: string[] }): Promise<CaptureSourceInfo[]> => ipcRenderer.invoke('get-sources', opts),
  saveSummary: (payload: { filename: string; content: string }): Promise<SaveSummaryResult> =>
    ipcRenderer.invoke('save-summary', payload),
  openFolder: (): Promise<void> => ipcRenderer.invoke('open-folder'),
  eventsStart: (opts: EventsStartOptions): Promise<void> => ipcRenderer.invoke('events:start', opts),
  eventsStop: (opts: EventsStopOptions): Promise<ActivityEvent[]> => ipcRenderer.invoke('events:stop', opts),
  getTranscriptSnippet: (): Promise<string> => ipcRenderer.invoke('events:get-transcript-snippet'),
  generate: (payload: GenerateRequest): Promise<string> => ipcRenderer.invoke('generate', payload),
  // One-way push from events-capture.ts when the window-activity poll
  // process crashes and exhausts its restart attempts mid-recording. Returns
  // an unsubscribe function so callers can clean up on unmount.
  onEventsDegraded: (callback: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => callback(message);
    ipcRenderer.on('events:degraded', listener);
    return () => ipcRenderer.removeListener('events:degraded', listener);
  },
};

export type CardonetCaptureApi = typeof api;

// contextIsolation is on and nodeIntegration is off (see src/main/index.ts),
// so process.contextIsolated is true and contextBridge is always the real
// path here. The plain-window-property branch is unreachable dead code kept
// only as a defensive fallback.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('cardonetCapture', api);
} else {
  // Preload's tsconfig has no DOM lib (main-process types only), and `window`
  // and `globalThis` are the same object in a preload script's realm either
  // way, so go through globalThis to avoid needing one just for this line.
  (globalThis as typeof globalThis & { cardonetCapture: CardonetCaptureApi }).cardonetCapture = api;
}
