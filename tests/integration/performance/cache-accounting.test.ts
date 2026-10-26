import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeCacheEvents } from '../../benchmarks/performance/cache-accounting.js';
import { createCacheRuntime } from './cache-runtime.js';
import { createEmbeddingCacheIdentity } from '../../../src/indexer/embedding-cache-identity.js';
import { computeStringHash } from '../../../src/indexer/hash.js';
import { syntheticEmbeddingConfig } from '../../benchmarks/performance/synthetic-provider.js';

const directories: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-cache-accounting-'));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const source = "import './dependency.js';\nexport function repeated() { return 1; }\n";
const events = ['a.ts', 'b.ts'].map((filePath) => ({
  type: 'added' as const, filePath, contentHash: 'fixed-file-hash', detectedAt: '2026-10-24T00:00:00.000Z',
}));

describe('real cache occurrence and provider accounting', () => {
  it('counts one terminal outcome per origin occurrence and one mixed provider call without deduplication', async () => {
    const runtime = await createCacheRuntime(await temporaryRoot(), 'identity-a');
    try {
      await runtime.pipeline.processEvents(events, () => Promise.resolve(source));
      expect(summarizeCacheEvents(runtime.events)).toMatchObject({
        outcomes: { l1_hit: 0, l2_hit: 0, miss: 6 }, providerCalls: 1, submittedInputs: 6,
        distinctProviderKeys: 2, crossOriginSharedKeys: 1,
        providerInputsByOrigin: { legacy: 4, structured: 2 },
      });
      expect(runtime.provider.calls).toBe(1);
      expect(runtime.provider.batchSizes).toEqual([6]);
      const functionDigest = createHash('sha256').update('export function repeated() { return 1; }').digest('hex');
      const importDigest = createHash('sha256').update("import './dependency.js';").digest('hex');
      expect(runtime.provider.inputDigests).toEqual([[functionDigest, importDigest, functionDigest,
        functionDigest, importDigest, functionDigest]]);
      const metrics = await runtime.metrics.registry.metrics();
      expect(metrics).toMatch(/nexus_embedding_cache_lookups_total\{[^\n]*outcome="miss"[^\n]*\} 6/);
    } finally { await runtime.close(); }
  });

  it('uses unchanged A identity from L1 without provider work on replay', async () => {
    const runtime = await createCacheRuntime(await temporaryRoot(), 'identity-a');
    try {
      await runtime.pipeline.processEvents(events, () => Promise.resolve(source));
      runtime.events.length = 0;
      await runtime.pipeline.processEvents(events, () => Promise.resolve(source));
      expect(summarizeCacheEvents(runtime.events)).toMatchObject({ outcomes: { l1_hit: 6, l2_hit: 0, miss: 0 }, providerCalls: 0 });
      expect(runtime.provider.calls).toBe(1);
    } finally { await runtime.close(); }
  });

  it('counts reopened A hits only as L2 terminal outcomes', async () => {
    const root = await temporaryRoot();
    const first = await createCacheRuntime(root, 'identity-a');
    try { await first.pipeline.processEvents(events, () => Promise.resolve(source)); }
    finally { await first.close(); }
    const reopened = await createCacheRuntime(root, 'identity-a');
    try {
      await reopened.pipeline.processEvents(events, () => Promise.resolve(source));
      expect(summarizeCacheEvents(reopened.events)).toMatchObject({ outcomes: { l1_hit: 0, l2_hit: 6, miss: 0 }, providerCalls: 0 });
      expect(reopened.provider.calls).toBe(0);
    } finally { await reopened.close(); }
  });

  it('misses the same-dimension B namespace against real A-seeded persistent cache', async () => {
    const root = await temporaryRoot();
    const first = await createCacheRuntime(root, 'identity-a');
    try { await first.pipeline.processEvents(events, () => Promise.resolve(source)); }
    finally { await first.close(); }
    const other = await createCacheRuntime(root, 'identity-b');
    try {
      await other.pipeline.processEvents(events, () => Promise.resolve(source));
      expect(summarizeCacheEvents(other.events)).toMatchObject({ outcomes: { l1_hit: 0, l2_hit: 0, miss: 6 }, providerCalls: 1 });
      expect(other.provider.calls).toBe(1);
      const chunkHash = await computeStringHash('export function repeated() { return 1; }');
      const keyA = createEmbeddingCacheIdentity({ ...syntheticEmbeddingConfig, model: 'identity-a' }).keyFor(chunkHash);
      const keyB = createEmbeddingCacheIdentity({ ...syntheticEmbeddingConfig, model: 'identity-b' }).keyFor(chunkHash);
      const retained = await other.metadataStore.getEmbeddings([keyA, keyB]);
      expect(retained.has(keyA)).toBe(true);
      expect(retained.has(keyB)).toBe(true);
    } finally { await other.close(); }
  });
});
