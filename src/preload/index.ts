import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type IpcRequest, type IpcResponse } from '../shared/ipc';

const api = {
  getSources: (
    opts: IpcRequest<typeof IPC_CHANNELS.getSources>,
  ): Promise<IpcResponse<typeof IPC_CHANNELS.getSources>> => ipcRenderer.invoke(IPC_CHANNELS.getSources, opts),
  saveSummary: (
    payload: IpcRequest<typeof IPC_CHANNELS.saveSummary>,
  ): Promise<IpcResponse<typeof IPC_CHANNELS.saveSummary>> => ipcRenderer.invoke(IPC_CHANNELS.saveSummary, payload),
  openFolder: (): Promise<IpcResponse<typeof IPC_CHANNELS.openFolder>> => ipcRenderer.invoke(IPC_CHANNELS.openFolder),
  eventsStart: (
    opts: IpcRequest<typeof IPC_CHANNELS.eventsStart>,
  ): Promise<IpcResponse<typeof IPC_CHANNELS.eventsStart>> => ipcRenderer.invoke(IPC_CHANNELS.eventsStart, opts),
  eventsStop: (
    opts: IpcRequest<typeof IPC_CHANNELS.eventsStop>,
  ): Promise<IpcResponse<typeof IPC_CHANNELS.eventsStop>> => ipcRenderer.invoke(IPC_CHANNELS.eventsStop, opts),
  getTranscriptSnippet: (): Promise<IpcResponse<typeof IPC_CHANNELS.eventsGetTranscriptSnippet>> =>
    ipcRenderer.invoke(IPC_CHANNELS.eventsGetTranscriptSnippet),
  generate: (payload: IpcRequest<typeof IPC_CHANNELS.generate>): Promise<IpcResponse<typeof IPC_CHANNELS.generate>> =>
    ipcRenderer.invoke(IPC_CHANNELS.generate, payload),
  // One-way push from events-capture.ts when the window-activity poll
  // process crashes and exhausts its restart attempts mid-recording. Returns
  // an unsubscribe function so callers can clean up on unmount.
  onEventsDegraded: (callback: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => callback(message);
    ipcRenderer.on(IPC_CHANNELS.eventsDegraded, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.eventsDegraded, listener);
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
