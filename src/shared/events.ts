// Shared shape for the merged, timestamp-sorted activity-timeline events
// produced by main/events-capture. One of three sources: window-focus
// activity (primary), terminal (PSReadLine diff / opt-in transcript), or
// browser history (Chrome/Edge).

export type ActivityEventType = 'window' | 'terminal' | 'browser';

export type WindowCategory = 'remote' | 'admin-console' | 'psa' | 'terminal' | 'other';
export type BrowserCategory = 'admin-portal' | 'psa' | 'kb-docs' | 'other';

export interface WindowEventDetail {
  processName: string;
  windowTitle: string;
  category: WindowCategory;
  durationMs: number;
}

export interface TerminalCommandDetail {
  shell: 'powershell';
  command: string;
}

export interface TerminalTranscriptDetail {
  shell: 'powershell-transcript';
  file: string;
  content: string;
}

export interface BrowserEventDetail {
  browser: string;
  url: string;
  title: string;
  category: BrowserCategory;
}

export type ActivityEventDetail =
  | WindowEventDetail
  | TerminalCommandDetail
  | TerminalTranscriptDetail
  | BrowserEventDetail;

export interface ActivityEvent {
  type: ActivityEventType;
  timestamp: number;
  detail: ActivityEventDetail;
}

export interface EventsStartOptions {
  window?: boolean;
  transcript?: boolean;
}

export interface EventsStopOptions {
  terminal?: boolean;
  browserHistory?: boolean;
}
