// Main-thread dispatch side of redact.worker.ts. Snapshots a live keyframe
// canvas into a transferable ImageBitmap and runs the real maskAndDownscale()
// (redact.ts, the same security-critical implementation redact.test.ts
// exercises) in a Worker, off the main thread -- called once per kept frame
// at generate-summary time (see App.tsx's generateSummary()).
import type { Mask } from './redact';

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

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (dataUrl: string) => void; reject: (err: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./redact.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<MaskWorkerResponse>): void => {
      const entry = pending.get(e.data.id);
      if (!entry) return;
      pending.delete(e.data.id);
      if (e.data.error) entry.reject(new Error(e.data.error));
      else entry.resolve(e.data.dataUrl!);
    };
  }
  return worker;
}

export async function maskAndDownscaleInWorker(
  canvas: HTMLCanvasElement,
  masks: Mask[],
  opts?: { fill?: string; maxDim?: number },
): Promise<string> {
  const bitmap = await createImageBitmap(canvas);
  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, bitmap, masks, fill: opts?.fill, maxDim: opts?.maxDim } satisfies MaskWorkerRequest, [
      bitmap,
    ]);
  });
}
