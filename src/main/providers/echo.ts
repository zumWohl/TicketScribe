// Decision 10: when the main process starts with
// CARDONETCAPTURE_TEST_PROVIDER=echo, the `generate` handler returns a fixed,
// deterministic summary built from its inputs (image count, timeline
// length) instead of calling a network provider. Exists only for automated
// (Playwright) tests -- src/main/providers/index.ts only reaches this when
// both the request asks for it AND the env var is set, so it is never
// reachable in a normal run.
import type { GenerateFrame, GenerateRequest } from '../../shared/generate';
import type { SummaryProvider } from './types';

export async function generate(frames: GenerateFrame[], activityTimelineText: string): Promise<string> {
  return `- echo: ${frames.length} frame(s), ${activityTimelineText.length} activity-timeline char(s)`;
}

export const echoProvider: SummaryProvider = {
  generate(request: GenerateRequest): Promise<string> {
    // Only reachable with the env var set (decision 10) -- never a normal
    // runtime path, and the renderer never has a way to pick 'echo' itself.
    if (process.env.CARDONETCAPTURE_TEST_PROVIDER !== 'echo') {
      throw new Error('echo provider is not enabled.');
    }
    return generate(request.frames, request.activityTimelineText);
  },
};
