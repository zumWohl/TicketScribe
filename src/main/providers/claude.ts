// Ported from renderer/providers.js's providers.claude.generate. Runs in the
// main process now (decision 6): the API key is read from the safeStorage-backed
// key store (src/main/keys.ts) instead of localStorage, and the fetch itself
// moves here so the key and the request never touch the renderer/CSP.
import type { GenerateFrame } from '../../shared/generate';
import { summaryInstructions } from './rules';

const MAX_IMAGES = 20;

interface MessageTextBlock { type: 'text'; text: string }
interface MessageImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
}
type MessageBlock = MessageTextBlock | MessageImageBlock;

export async function generate(
  apiKey: string,
  frames: GenerateFrame[],
  activityTimelineText: string,
  templateContent: string,
): Promise<string> {
  if (!apiKey) throw new Error('No Anthropic API key set. Add one in Settings to use Claude.');

  const step = frames.length > MAX_IMAGES ? Math.ceil(frames.length / MAX_IMAGES) : 1;
  const sampledIndexes = frames.map((_, i) => i).filter(i => i % step === 0);

  const content: MessageBlock[] = [];
  sampledIndexes.forEach((idx, n) => {
    const frame = frames[idx];
    content.push({
      type: 'text',
      text: `Frame ${n + 1} at ${new Date(frame.timestamp).toLocaleTimeString()}${frame.ocrText ? ` — OCR: "${frame.ocrText.slice(0, 300)}"` : ''}`,
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: frame.dataUrl.split(',')[1] },
    });
  });
  content.push({
    type: 'text',
    text: `You are writing the resolution work note for an IT support ticket, based on the redacted screenshots above${activityTimelineText ? ' and the activity timeline below' : ''}.
${summaryInstructions(templateContent)}${activityTimelineText ? `\n\nActivity timeline:\n${activityTimelineText}` : ''}

Work note:`,
  });

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    throw new Error('Could not reach the Anthropic API — check your internet connection and try again.');
  }
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to generate this summary.');
  const textBlock = (data.content || []).find((b: { type: string }) => b.type === 'text');
  return (textBlock?.text || '').trim();
}
