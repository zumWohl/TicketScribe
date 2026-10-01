// Shape of the `generate` IPC channel's request/response. The renderer sends
// only non-secret data: masked+downscaled image data URLs, OCR text that has
// already passed scrubText()/maskedOcrText(), model/URL settings (not keys),
// and template *content* (not a key) from localStorage. API keys never leave
// the main process -- see src/main/keys.ts.
export type ProviderId = 'ollama' | 'claude' | 'echo';

export interface GenerateFrame {
  timestamp: number;
  dataUrl: string;
  ocrText: string;
}

export interface OllamaSettings {
  url: string;
  vlmModel: string;
  textModel: string;
}

export interface GenerateRequest {
  provider: ProviderId;
  frames: GenerateFrame[];
  activityTimelineText: string;
  templateContent: string;
  ollama?: OllamaSettings;
}

export type GenerateResponse = string; // the finished work-note text
