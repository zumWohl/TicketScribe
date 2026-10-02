// Shape of the `generate` IPC channel's request/response. The renderer sends
// only non-secret data: masked+downscaled image data URLs, OCR text that has
// already passed scrubText()/maskedOcrText(), Ollama URL/model settings (not
// keys), and template *content* (not a key) from localStorage. All cloud
// summaries ("claude") are routed through the org's Azure deployment --
// endpoint/deployment/key are operator-configured via environment variables
// and read directly in the main process (src/main/providers/index.ts),
// never sent by the renderer.
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

export interface AzureSettings {
  endpoint: string;
  deployment: string;
}

export interface GenerateRequest {
  provider: ProviderId;
  frames: GenerateFrame[];
  activityTimelineText: string;
  templateContent: string;
  ollama?: OllamaSettings;
}

export type GenerateResponse = string; // the finished work-note text
