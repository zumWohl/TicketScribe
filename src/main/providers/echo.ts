// Decision 10: when the main process starts with
// TICKETSCRIBE_TEST_PROVIDER=echo, the `generate` handler returns a fixed,
// deterministic summary built from its inputs (image count, timeline
// length) instead of calling a network provider. Exists only for automated
// (Playwright) tests -- src/main/providers/index.ts only reaches this when
// both the request asks for it AND the env var is set, so it is never
// reachable in a normal run.
import type { GenerateFrame } from '../../shared/generate';

export async function generate(frames: GenerateFrame[], activityTimelineText: string): Promise<string> {
  return `- echo: ${frames.length} frame(s), ${activityTimelineText.length} activity-timeline char(s)`;
}
