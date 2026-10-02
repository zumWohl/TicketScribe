// Golden-file tests for the shared prompt-building module: locks in the
// exact text sent to every provider (Ollama/Claude-via-Azure) so a future
// edit to SUMMARY_RULES/summaryInstructions/buildTimelinePrompt can't
// silently change prompt wording without a snapshot diff forcing a reviewer
// to notice. Run `vitest run -u` to intentionally update a snapshot after a
// deliberate prompt change; never do that to make a failing test "pass"
// without reading the diff first.
import { describe, it, expect } from 'vitest';
import { SUMMARY_RULES, summaryInstructions, buildTimelinePrompt, type FrameDescription } from './rules';

describe('summaryInstructions', () => {
  it('matches the golden baseline rules text when no template is set', () => {
    expect(summaryInstructions('')).toMatchSnapshot();
  });

  it('returns exactly SUMMARY_RULES with no template (no trailing content)', () => {
    expect(summaryInstructions('')).toBe(SUMMARY_RULES);
    expect(summaryInstructions('   ')).toBe(SUMMARY_RULES); // whitespace-only counts as "no template"
  });

  it('matches the golden baseline-plus-template text when a template is set', () => {
    expect(
      summaryInstructions('Organise the actions under headings: Diagnosis, Steps taken, Resolution.'),
    ).toMatchSnapshot();
  });

  it('appends the template after the baseline rules, with the rules taking precedence on conflict', () => {
    const result = summaryInstructions('Keep it under 8 bullets.');
    expect(result.startsWith(SUMMARY_RULES)).toBe(true);
    expect(result).toContain('Keep it under 8 bullets.');
    expect(result).toContain('the rules above win');
  });
});

describe('buildTimelinePrompt', () => {
  const descriptions: FrameDescription[] = [
    { timestamp: 1700000000000, text: 'Opened the HaloPSA ticket list.' },
    { timestamp: 1700000010000, text: 'Searched for the affected user account.' },
  ];

  it('matches the golden baseline prompt with no activity timeline and no template', () => {
    expect(buildTimelinePrompt(descriptions, '', '')).toMatchSnapshot();
  });

  it('matches the golden prompt with an activity timeline and a template', () => {
    expect(
      buildTimelinePrompt(descriptions, '1. Focused HaloPSA for 4m12s\n2. Visited portal.azure.com', 'Keep it terse.'),
    ).toMatchSnapshot();
  });

  it('numbers observed actions in order starting from 1', () => {
    const result = buildTimelinePrompt(descriptions, '', '');
    expect(result).toContain('1. Opened the HaloPSA ticket list.');
    expect(result).toContain('2. Searched for the affected user account.');
  });

  it('omits the activity-timeline section entirely when there is none', () => {
    const result = buildTimelinePrompt(descriptions, '', '');
    expect(result).not.toContain('Activity timeline:');
    expect(result).not.toContain('plus an activity timeline');
  });

  it('includes the activity-timeline section when text is provided', () => {
    const result = buildTimelinePrompt(descriptions, 'Focused HaloPSA for 4m', '');
    expect(result).toContain('plus an activity timeline of the tools used');
    expect(result).toContain('Activity timeline:\nFocused HaloPSA for 4m');
  });

  it('ends with the literal "Work note:" cue for every variant', () => {
    expect(buildTimelinePrompt(descriptions, '', '').endsWith('Work note:')).toBe(true);
    expect(buildTimelinePrompt(descriptions, 'timeline', 'template').endsWith('Work note:')).toBe(true);
  });
});
