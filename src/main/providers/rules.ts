// Ported from renderer/providers.js. SUMMARY_RULES and buildTimelinePrompt
// are identical in substance; the only change is that `templateContent` (the
// user's selected Summary Template, read from localStorage) now arrives as a
// plain string over the `generate` IPC payload instead of being read
// directly from localStorage here -- localStorage isn't reachable from the
// main process.

export const SUMMARY_RULES = `Write the work note as a bullet-point list of the actions performed.
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

export function summaryInstructions(templateContent: string): string {
  const tpl = (templateContent || '').trim();
  if (!tpl) return SUMMARY_RULES;
  return `${SUMMARY_RULES}

Additional instructions for this summary (apply these on top of the rules above -- if anything here conflicts with the rules above, the rules above win):
${tpl}`;
}

export interface FrameDescription {
  timestamp: number;
  text: string;
}

export function buildTimelinePrompt(
  descriptions: FrameDescription[],
  activityTimelineText: string,
  templateContent: string,
): string {
  const timeline = descriptions.map((d, i) => `${i + 1}. ${d.text}`).join('\n');
  return `You are writing the resolution work note for an IT support ticket, based on a timeline of observed on-screen actions${activityTimelineText ? ', plus an activity timeline of the tools used' : ''}.
${summaryInstructions(templateContent)}

Observed actions:
${timeline}
${activityTimelineText ? `\nActivity timeline:\n${activityTimelineText}\n` : ''}
Work note:`;
}
