// Main-thread dispatch side of hash.worker.ts. Snapshots a just-captured
// frame canvas into a transferable ImageBitmap and computes its
// average-hash (hash.ts's aHash, the same pure function hash.test.ts
// exercises) in a Worker, off the main thread -- called once per ~1.5s
// capture tick (see App.tsx's captureFrame).
import type { AHash } from './hash';

interface HashWorkerRequest {
  id: number;
  bitmap: ImageBitmap;
}

interface HashWorkerResponse {
  id: number;
  hash: AHash;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (hash: AHash) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<HashWorkerResponse>): void => {
      const resolve = pending.get(e.data.id);
      if (!resolve) return;
      pending.delete(e.data.id);
      resolve(e.data.hash);
    };
  }
  return worker;
}

export async function hashInWorker(canvas: HTMLCanvasElement): Promise<AHash> {
  const bitmap = await createImageBitmap(canvas);
  const id = nextId++;
  return new Promise<AHash>(resolve => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, bitmap } satisfies HashWorkerRequest, [bitmap]);
  });
}
