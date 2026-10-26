import { createHash } from 'node:crypto';
import { emitRuntimeEvent } from './runtime-observer.js';
import type { EmbeddingChunkOrigin, EmbeddingInputIdentity, RuntimeObserver } from './runtime-observer.js';
import type { EmbeddingCacheOutcome } from './types.js';

let batchSequence = 0;

export function embeddingInputIdentity(origin: EmbeddingChunkOrigin | undefined, key?: string): EmbeddingInputIdentity {
  return Object.freeze({ ...(origin === undefined ? {} : { origin }),
    ...(key === undefined ? {} : { keyDigest: createHash('sha256').update(key).digest('hex') }),
  });
}

export function emitCacheLookup(observer: RuntimeObserver, origin: EmbeddingChunkOrigin | undefined,
  outcome: EmbeddingCacheOutcome, key?: string): void {
  emitRuntimeEvent(observer, { kind: 'cache_lookup', outcome, input: embeddingInputIdentity(origin, key) });
}

export async function observeEmbeddingBatch<T>(observer: RuntimeObserver | undefined,
  entries: () => readonly EmbeddingInputIdentity[], work: () => Promise<T>): Promise<T> {
  if (observer === undefined) return work();
  const batchId = `embedding-batch-${++batchSequence}`;
  emitRuntimeEvent(observer, { kind: 'embedding_batch_submitted', batchId, entries: Object.freeze([...entries()]) });
  try {
    const result = await work();
    emitRuntimeEvent(observer, { kind: 'embedding_batch_finished', batchId, outcome: 'fulfilled' });
    return result;
  } catch (error) {
    emitRuntimeEvent(observer, { kind: 'embedding_batch_finished', batchId, outcome: 'rejected' });
    throw error;
  }
}
