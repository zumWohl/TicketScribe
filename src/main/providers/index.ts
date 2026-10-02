import { nativeImage } from 'electron';
import type { GenerateRequest } from '../../shared/generate';
import { MODEL_IMAGE_MAX_DIMENSION } from '../../shared/image';
import { runOllamaPipeline } from './ollama';
import * as azure from './azure';
import * as echo from './echo';

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

export async function generate(request: GenerateRequest): Promise<string> {
  assertFramesWithinSizeCap(request.frames);

  // Only reachable with the env var set (decision 10) -- never a normal
  // runtime path, and the renderer never has a way to pick 'echo' itself.
  if (request.provider === 'echo') {
    if (process.env.CARDONETCAPTURE_TEST_PROVIDER !== 'echo') {
      throw new Error('echo provider is not enabled.');
    }
    return echo.generate(request.frames, request.activityTimelineText);
  }

  if (request.provider === 'claude') {
    // All cloud summaries are routed through the org's Azure deployment --
    // endpoint/deployment/key are operator-configured via environment
    // variables (set by IT, not the technician), never entered in Settings.
    const settings = {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT || '',
    };
    return azure.generate(process.env.AZURE_OPENAI_KEY || '', settings, request.frames, request.activityTimelineText, request.templateContent);
  }

  // ollama
  const settings = request.ollama || { url: 'http://localhost:11434', vlmModel: 'llava', textModel: 'llama3' };
  return runOllamaPipeline(settings, request.frames, request.activityTimelineText, request.templateContent);
}
