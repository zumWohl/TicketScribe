// Provider abstraction for generating the ticket work note.
//
// Ollama is the default, on-device provider. Claude is an optional cloud
// alternative the user opts into in Settings. Both MUST throw on failure —
// callers must never silently fall back to raw OCR text and present it as a
// finished summary. That silent-fallback behavior is exactly what made the
// old pipeline's output read like a fake template when Ollama was
// unreachable.

const ls = (k, d) => localStorage.getItem(k) || d;

function buildTimelinePrompt(descriptions, activityTimelineText) {
  const timeline = descriptions
    .map((d, i) => `${i + 1}. [${new Date(d.timestamp).toLocaleTimeString()}] ${d.text}`)
    .join('\n');
  return `You are writing a professional work note for an IT support ticket.
Below is a timestamped timeline of observed actions${activityTimelineText ? ', plus an activity timeline of the tools used' : ''}.
Write a clear, past-tense, professional summary in 3-5 sentences suitable as a ticket note.
Describe what was done and any outcomes. No bullet points.

Timeline:
${timeline}
${activityTimelineText ? `\nActivity timeline:\n${activityTimelineText}\n` : ''}
Work note:`;
}

async function ollamaGenerate(payload) {
  const url = ls('ollamaUrl', 'http://localhost:11434');
  let res;
  try {
    res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, stream: false }),
    });
  } catch {
    throw new Error(`Could not reach Ollama at ${url} — start Ollama and make sure it's listening there, then try again.`);
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Ollama model "${payload.model}" was not found — run "ollama pull ${payload.model}", then try again.`);
    }
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`Ollama ${res.status}: ${detail}`);
  }
  return (await res.json()).response.trim();
}

const providers = {
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    async describeFrame(dataUrl, ocrText) {
      return ollamaGenerate({
        model: ls('vlmModel', 'llava'),
        images: [dataUrl.split(',')[1]],
        prompt: `You are reviewing a screenshot from an IT support engineer's screen.
In 1-2 concise sentences, describe the specific action being performed.
Include: which application is visible, what the engineer is doing, and any important text (commands, errors, account names).
OCR context: "${ocrText.slice(0, 300)}"`,
      });
    },
    async generateSummary(descriptions, activityTimelineText) {
      return ollamaGenerate({
        model: ls('textModel', 'llama3'),
        prompt: buildTimelinePrompt(descriptions, activityTimelineText),
      });
    },
  },

  claude: {
    id: 'claude',
    label: 'Claude',
    // One call: every keyframe image (capped) plus its OCR caption, followed
    // by the activity timeline if provided, then the work-note instruction.
    async generate(keyframes, ocrTexts, activityTimelineText) {
      const apiKey = ls('anthropicApiKey', '');
      if (!apiKey) throw new Error('No Anthropic API key set. Add one in Settings to use Claude.');

      const MAX_IMAGES = 20;
      const step = keyframes.length > MAX_IMAGES ? Math.ceil(keyframes.length / MAX_IMAGES) : 1;
      const sampledIndexes = keyframes.map((_, i) => i).filter(i => i % step === 0);

      const content = [];
      sampledIndexes.forEach((idx, n) => {
        const kf = keyframes[idx];
        const ocr = ocrTexts[idx];
        content.push({
          type: 'text',
          text: `Frame ${n + 1} at ${new Date(kf.timestamp).toLocaleTimeString()}${ocr ? ` — OCR: "${ocr.slice(0, 300)}"` : ''}`,
        });
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: kf.dataUrl.split(',')[1] },
        });
      });
      content.push({
        type: 'text',
        text: `You are writing a professional work note for an IT support ticket, based on the screenshots above${activityTimelineText ? ' and the activity timeline below' : ''}.
Write a clear, past-tense, professional summary in 3-5 sentences suitable as a ticket note.
Describe what was done and any outcomes. No bullet points.${activityTimelineText ? `\n\nActivity timeline:\n${activityTimelineText}` : ''}

Work note:`,
      });

      let res;
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
      const textBlock = data.content.find(b => b.type === 'text');
      return (textBlock?.text || '').trim();
    },
  },
};

module.exports = { providers, buildTimelinePrompt };
