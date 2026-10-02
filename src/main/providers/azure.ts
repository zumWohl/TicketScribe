// Azure OpenAI is the backend for every cloud summary -- the "Claude" option
// in the UI is routed here by providers/index.ts, which reads the endpoint/
// deployment/key from AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_DEPLOYMENT/
// AZURE_OPENAI_KEY (operator-configured environment variables, not Settings).
// Uses the unified `/openai/v1/chat/completions` route (the deployment name
// goes in the `model` field), NOT the deprecated
// `services.ai.azure.com/models` route. Same throw-on-failure contract as
// ollama.ts: src/main/providers/index.ts never falls back to a raw OCR dump
// on error.
import type { AzureSettings, GenerateFrame } from '../../shared/generate';
import { summaryInstructions } from './rules';

const MAX_IMAGES = 20;

interface MessageTextPart { type: 'text'; text: string }
interface MessageImagePart { type: 'image_url'; image_url: { url: string } }
type MessagePart = MessageTextPart | MessageImagePart;

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function generate(
  apiKey: string,
  settings: AzureSettings | undefined,
  frames: GenerateFrame[],
  activityTimelineText: string,
  templateContent: string,
): Promise<string> {
  if (!settings || !settings.endpoint.trim() || !settings.deployment.trim()) {
    throw new Error('Azure OpenAI endpoint/deployment not set. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT.');
  }
  if (!apiKey) throw new Error('No Azure OpenAI API key set. Set the AZURE_OPENAI_KEY environment variable.');

  const step = frames.length > MAX_IMAGES ? Math.ceil(frames.length / MAX_IMAGES) : 1;
  const sampledIndexes = frames.map((_, i) => i).filter(i => i % step === 0);

  const content: MessagePart[] = [];
  sampledIndexes.forEach((idx, n) => {
    const frame = frames[idx];
    content.push({
      type: 'text',
      text: `Frame ${n + 1} at ${new Date(frame.timestamp).toLocaleTimeString()}${frame.ocrText ? `, OCR: "${frame.ocrText.slice(0, 300)}"` : ''}`,
    });
    content.push({ type: 'image_url', image_url: { url: frame.dataUrl } });
  });
  content.push({
    type: 'text',
    text: `You are writing the resolution work note for an IT support ticket, based on the redacted screenshots above${activityTimelineText ? ' and the activity timeline below' : ''}.
${summaryInstructions(templateContent)}${activityTimelineText ? `\n\nActivity timeline:\n${activityTimelineText}` : ''}

Work note:`,
  });

  const url = `${normalizeEndpoint(settings.endpoint)}/openai/v1/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        model: settings.deployment,
        max_tokens: 1024,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    throw new Error('Could not reach Azure OpenAI. Check your internet connection and the AZURE_OPENAI_ENDPOINT value.');
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new Error('Azure OpenAI rejected the API key. Check the AZURE_OPENAI_KEY value.');
    if (res.status === 403) throw new Error('Azure OpenAI access denied for this key/resource. Check the resource permissions.');
    if (res.status === 404) throw new Error('Azure OpenAI deployment not found. Check the AZURE_OPENAI_DEPLOYMENT value.');
    if (res.status === 429) throw new Error('Azure OpenAI rate limit exceeded. Wait and try again.');
    let filtered = false;
    try {
      filtered = JSON.parse(body)?.error?.code === 'content_filter';
    } catch {
      /* not JSON */
    }
    if (filtered) throw new Error('Azure OpenAI declined to generate this summary (content filter).');
    throw new Error(`Azure OpenAI ${res.status}: ${body}`);
  }

  const data = await res.json();
  const choice = (data.choices || [])[0];
  if (choice?.finish_reason === 'content_filter') {
    throw new Error('Azure OpenAI declined to generate this summary (content filter).');
  }
  return (choice?.message?.content || '').trim();
}
