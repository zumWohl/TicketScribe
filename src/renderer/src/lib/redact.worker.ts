// Worker entry for off-main-thread masking. Imports the exact same
// maskAndDownscale() redact.test.ts exercises directly -- this file is only
// transport (ImageBitmap in, dataUrl out), never a second implementation of
// the masking logic itself. See redact-worker-client.ts for the main-thread
// dispatch side.
import { maskAndDownscale, type Mask } from './redact';

interface MaskWorkerRequest {
  id: number;
  bitmap: ImageBitmap;
  masks: Mask[];
  fill?: string;
  maxDim?: number;
}

interface MaskWorkerResponse {
  id: number;
  dataUrl?: string;
  error?: string;
}

self.onmessage = async (e: MessageEvent<MaskWorkerRequest>): Promise<void> => {
  const { id, bitmap, masks, fill, maxDim } = e.data;
  try {
    const dataUrl = await maskAndDownscale(bitmap, masks, { fill, maxDim });
    bitmap.close();
    self.postMessage({ id, dataUrl } satisfies MaskWorkerResponse);
  } catch (err) {
    bitmap.close();
    self.postMessage({ id, error: (err as Error).message } satisfies MaskWorkerResponse);
  }
};
