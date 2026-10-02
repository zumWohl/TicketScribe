import { nativeImage } from 'electron';
import type { GenerateRequest, ProviderId } from '../../shared/generate';
import { MODEL_IMAGE_MAX_DIMENSION } from '../../shared/image';
import type { SummaryProvider } from './types';
import { ollamaProvider } from './ollama';
import { azureProvider } from './azure';
import { echoProvider } from './echo';

// Defense-in-depth: proves the renderer's downscale ran before sending (it
// does NOT prove masking ran -- that's a pixel-level guarantee enforced by
// renderer/redact.ts, verified separately by npm test / mask-verify).
function assertFramesWithinSizeCap(frames: GenerateRequest['frames']): void {
  for (const frame of frames) {
    const { width, height } = nativeImage.createFromDataURL(frame.dataUrl).getSize();
    const longEdge = Math.max(width, height);
    if (longEdge > MODEL_IMAGE_MAX_DIMENSION) {
      throw new Error(
        `Image long edge ${longEdge}px exceeds the ${MODEL_IMAGE_MAX_DIMENSION}px model cap — the renderer must downscale before sending.`,
      );
    }
  }
}

// 'claude' is the UI-facing label for the sole cloud option, which is
// always routed through the org's Azure OpenAI deployment -- see
// providers/azure.ts and CLAUDE.md's "Azure OpenAI" section.
const PROVIDERS: Record<ProviderId, SummaryProvider> = {
  ollama: ollamaProvider,
  claude: azureProvider,
  echo: echoProvider,
};

export async function generate(request: GenerateRequest): Promise<string> {
  assertFramesWithinSizeCap(request.frames);
  return PROVIDERS[request.provider].generate(request);
}
