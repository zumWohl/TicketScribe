// Ported from renderer/providers.js's ollamaGenerate + providers.ollama.
// Runs in the main process now (decision 6) using Node's built-in fetch;
// behavior/prompts/error messages are unchanged.
import type { GenerateFrame, GenerateRequest } from '../../shared/generate';
import { buildTimelinePrompt, type FrameDescription } from './rules';
import type { SummaryProvider } from './types';

interface OllamaGeneratePayload {
  model: string;
  prompt: string;
  images?: string[];
  think?: boolean;
  stream?: boolean;
}

interface OllamaGenerateResponse {
  response?: string;
}

async function ollamaGenerate(url: string, payload: OllamaGeneratePayload): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, stream: false }),
    });
  } catch {
    throw new Error(
      `Could not reach Ollama at ${url} — start Ollama and make sure it's listening there, then try again.`,
    );
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `Ollama model "${payload.model}" was not found — run "ollama pull ${payload.model}", then try again.`,
      );
    }
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Ollama ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as OllamaGenerateResponse;
  return (data.response || '').trim();
}

export async function describeFrame(url: string, vlmModel: string, dataUrl: string, ocrText: string): Promise<string> {
  return ollamaGenerate(url, {
    model: vlmModel,
    images: [dataUrl.split(',')[1]],
    // Reasoning-capable vision models (e.g. qwen3-vl) can otherwise spend
    // most of the call generating a hidden chain-of-thought before this
    // short, factual description -- there's little for reasoning to do
    // on a "describe this screenshot" task, so skip it for latency.
    think: false,
    prompt: `You are reviewing a screenshot from a work session.
In 1-2 concise sentences, describe the specific action being performed.
Include: which application is visible and what action is being taken. Do not name or refer to any person or role.
Base this only on what is directly visible -- do not guess at problems, causes, or intentions that aren't clearly shown.
Do not mention the screen-recording tool itself, and skip incidental UI chrome (notifications, popups, ads) unless it is the actual focus of the action.
Never repeat or quote passwords, API keys, tokens, or other credentials verbatim, even if visible -- refer to them generically (e.g. "entered a password") if relevant.
OCR context: "${ocrText.slice(0, 300)}"`,
  });
}

export async function generateTextSummary(
  url: string,
  textModel: string,
  descriptions: FrameDescription[],
  activityTimelineText: string,
  templateContent: string,
): Promise<string> {
  return ollamaGenerate(url, {
    model: textModel,
    prompt: buildTimelinePrompt(descriptions, activityTimelineText, templateContent),
  });
}

export async function runOllamaPipeline(
  settings: { url: string; vlmModel: string; textModel: string },
  frames: GenerateFrame[],
  activityTimelineText: string,
  templateContent: string,
): Promise<string> {
  const descriptions: FrameDescription[] = [];
  let lastError: Error | null = null;
  for (const frame of frames) {
    try {
      const text = await describeFrame(settings.url, settings.vlmModel, frame.dataUrl, frame.ocrText);
      descriptions.push({ timestamp: frame.timestamp, text });
    } catch (err) {
      lastError = err as Error;
    }
  }
  if (descriptions.length === 0) {
    throw lastError || new Error('No descriptions generated — is Ollama running?');
  }
  return generateTextSummary(settings.url, settings.textModel, descriptions, activityTimelineText, templateContent);
}

export const ollamaProvider: SummaryProvider = {
  generate(request: GenerateRequest): Promise<string> {
    const settings = request.ollama || { url: 'http://localhost:11434', vlmModel: 'llava', textModel: 'llama3' };
    return runOllamaPipeline(settings, request.frames, request.activityTimelineText, request.templateContent);
  },
};
