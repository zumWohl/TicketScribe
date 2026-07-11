// Provider abstraction for generating the ticket work note.
//
// Ollama is the default, on-device provider. Claude is an optional cloud
// alternative the user opts into in Settings. Both MUST throw on failure —
// callers must never silently fall back to raw OCR text and present it as a
// finished summary. That silent-fallback behavior is exactly what made the
// old pipeline's output read like a fake template when Ollama was
// unreachable.

const ls = (k, d) => localStorage.getItem(k) || d;

// The summary is a bullet-point list of actions, written in impersonal
// passive past tense. It must NOT name any actor (no "the engineer", "the
// technician", "the IT support engineer", "I", or "the user") and must NOT
// include any date or time -- see the product spec. Example target style:
//   - Searched the Xerox website for printer drivers and downloaded driver version 2.0.
//   - Opened Command Prompt and ran the following commands:
//   - Confirmed installation was completed successfully.
const SUMMARY_RULES = `Write the work note as a bullet-point list of the actions performed.
Rules:
- One action per bullet, in the order it occurred. Every line must start with "- ".
- Use impersonal, passive past tense. Never name a person or role -- do not write "the engineer", "the technician", "the IT support engineer", "I", or "the user". Begin each bullet directly with the action verb (e.g. "Searched...", "Opened...", "Ran...", "Confirmed...").
- Do not include any date or time.
- Describe only what is directly evidenced -- do not infer problems, causes, or intentions that aren't shown.
- Omit incidental details (browser/OS notifications, prompts unrelated to the work, the screen-recording tool itself) unless clearly part of the work performed.
- Never repeat passwords, API keys, tokens, or other credentials verbatim; refer to them generically (e.g. "entered a password").
- Never describe masked or redacted fields as "obscured," "hidden," "blurred," or otherwise implying the value was partially visible -- describe only that the field was present and filled in (e.g. "entered values into the Password and Username fields"), since the underlying value was never seen.
- Before writing bullets, group all observations that describe the same underlying action, window, or UI state into a single bullet. Only start a new bullet when the user has moved to a genuinely different action, window, or step -- do not produce multiple bullets that redescribe one moment from slightly different angles.
Return only the bullet list -- no heading, no preamble, no closing sentence.`;

// A user-selected Summary Template (managed on the Templates screen) layers
// EXTRA instructions on top of SUMMARY_RULES -- it never replaces the baseline.
// Read from the same localStorage the rest of the app's settings use:
// `activeTemplateId` ('' = none) picks one entry out of `summaryTemplates`.
function activeTemplateContent() {
  try {
    const id = localStorage.getItem('activeTemplateId') || '';
    if (!id) return '';
    const list = JSON.parse(localStorage.getItem('summaryTemplates') || '[]');
    const t = Array.isArray(list) ? list.find(x => x && x.id === id) : null;
    return t && t.content ? String(t.content).trim() : '';
  } catch { return ''; }
}

// The single point where the baseline rules and the optional template are
// combined. Baseline first (and explicitly given precedence), template appended
// after as additional instructions. With no template selected this returns the
// baseline SUMMARY_RULES verbatim, so generation is unchanged from the default.
function summaryInstructions() {
  const tpl = activeTemplateContent();
  if (!tpl) return SUMMARY_RULES;
  return `${SUMMARY_RULES}

Additional instructions for this summary (apply these on top of the rules above -- if anything here conflicts with the rules above, the rules above win):
${tpl}`;
}

function buildTimelinePrompt(descriptions, activityTimelineText) {
  const timeline = descriptions
    .map((d, i) => `${i + 1}. ${d.text}`)
    .join('\n');
  return `You are writing the resolution work note for an IT support ticket, based on a timeline of observed on-screen actions${activityTimelineText ? ', plus an activity timeline of the tools used' : ''}.
${summaryInstructions()}

Observed actions:
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
        text: `You are writing the resolution work note for an IT support ticket, based on the redacted screenshots above${activityTimelineText ? ' and the activity timeline below' : ''}.
${summaryInstructions()}${activityTimelineText ? `\n\nActivity timeline:\n${activityTimelineText}` : ''}

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
