import { describe, expect, it } from 'vitest';
import { createEmbeddingCacheIdentity } from '../../../../src/indexer/embedding-cache-identity.js';
import { computeStringHash } from '../../../../src/indexer/hash.js';
import { syntheticEmbeddingConfig } from '../../../benchmarks/performance/synthetic-provider.js';
import { summarizeCacheEvents } from '../../../benchmarks/performance/cache-accounting.js';

describe('qualified cache accounting identity', () => {
  it('preserves A-seeded L1/L2 key-map reuse and same-dimension B separation', async () => {
    const chunkHash = await computeStringHash('export function fixture() { return 1; }');
    const a = createEmbeddingCacheIdentity({ ...syntheticEmbeddingConfig, model: 'identity-a' });
    const anotherA = createEmbeddingCacheIdentity({ ...syntheticEmbeddingConfig, model: 'identity-a' });
    const b = createEmbeddingCacheIdentity({ ...syntheticEmbeddingConfig, model: 'identity-b' });
    const l1 = new Map([[a.keyFor(chunkHash), 'seed-a']]);
    const l2 = new Map(l1);
    expect(l1.get(anotherA.keyFor(chunkHash))).toBe('seed-a');
    expect(l2.get(anotherA.keyFor(chunkHash))).toBe('seed-a');
    expect(l1.get(b.keyFor(chunkHash))).toBeUndefined();
    expect(l2.get(b.keyFor(chunkHash))).toBeUndefined();
  });

  it('counts the union of shared input keys without losing submitted occurrences', () => {
    const identity = { time: 1, workId: 'batch', context: { requestId: 'request', phaseId: 'request' } };
    const keyA = 'a'.repeat(64);
    const keyB = 'b'.repeat(64);
    const summary = summarizeCacheEvents([
      { ...identity, kind: 'embedding_batch_submitted', batchId: 'one', entries: [
        { origin: 'legacy', keyDigest: keyA }, { origin: 'legacy', keyDigest: keyA },
        { origin: 'structured', keyDigest: keyA }, { origin: 'structured', keyDigest: keyB },
      ] },
    ]);
    expect(summary).toMatchObject({ providerCalls: 1, submittedInputs: 4, distinctProviderKeys: 2,
      crossOriginSharedKeys: 1, providerInputsByOrigin: { legacy: 2, structured: 2 } });
  });
});
