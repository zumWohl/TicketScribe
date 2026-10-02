// Worker entry for off-main-thread perceptual hashing. Imports the exact
// same aHash() hash.test.ts exercises directly -- this file is only
// transport (ImageBitmap in, hash out), never a second implementation of the
// hash itself. See hash-worker-client.ts for the main-thread dispatch side.
import { aHash, type AHash } from './hash';

interface HashWorkerRequest {
  id: number;
  bitmap: ImageBitmap;
}

interface HashWorkerResponse {
  id: number;
  hash: AHash;
}

self.onmessage = (e: MessageEvent<HashWorkerRequest>): void => {
  const { id, bitmap } = e.data;
  const hash = aHash(bitmap);
  bitmap.close();
  self.postMessage({ id, hash } satisfies HashWorkerResponse);
};
