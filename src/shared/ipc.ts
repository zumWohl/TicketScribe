// Single source of truth for every IPC channel between src/main/index.ts
// (ipcMain.handle) and src/preload/index.ts (the contextBridge api) --
// channel names and their request/response shapes live here once instead of
// as duplicated string literals on both sides of the bridge.
import type { EventsStartOptions, EventsStopOptions, ActivityEvent } from './events';
import type { GenerateRequest, GenerateResponse } from './generate';

export const IPC_CHANNELS = {
  getSources: 'get-sources',
  saveSummary: 'save-summary',
  openFolder: 'open-folder',
  eventsStart: 'events:start',
  eventsStop: 'events:stop',
  eventsGetTranscriptSnippet: 'events:get-transcript-snippet',
  generate: 'generate',
  // One-way main -> renderer push, not an invoke/handle channel, so it has
  // no entry in IpcContract below.
  eventsDegraded: 'events:degraded',
} as const;

export interface GetSourcesOptions {
  types?: string[];
}

// Mirrors main/index.ts's get-sources handler return shape.
export interface CaptureSourceInfo {
  id: string;
  name: string;
  type: 'window' | 'screen';
  thumbnail: string;
}

export interface SaveSummaryPayload {
  filename: string;
  content: string;
}

// Mirrors main/index.ts's save-summary handler return shape.
export interface SaveSummaryResult {
  ok: boolean;
  path?: string;
  error?: string;
}

// Request/response shape for every invoke-style channel. Both
// ipcMain.handle (main/index.ts) and the contextBridge api (preload/index.ts)
// are typed against this, so the two sides of the bridge can't drift apart.
export interface IpcContract {
  [IPC_CHANNELS.getSources]: { request: GetSourcesOptions | undefined; response: CaptureSourceInfo[] };
  [IPC_CHANNELS.saveSummary]: { request: SaveSummaryPayload; response: SaveSummaryResult };
  [IPC_CHANNELS.openFolder]: { request: void; response: void };
  [IPC_CHANNELS.eventsStart]: { request: EventsStartOptions; response: void };
  [IPC_CHANNELS.eventsStop]: { request: EventsStopOptions; response: ActivityEvent[] };
  [IPC_CHANNELS.eventsGetTranscriptSnippet]: { request: void; response: string };
  [IPC_CHANNELS.generate]: { request: GenerateRequest; response: GenerateResponse };
}

export type IpcRequest<K extends keyof IpcContract> = IpcContract[K]['request'];
export type IpcResponse<K extends keyof IpcContract> = IpcContract[K]['response'];
