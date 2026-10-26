import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteMetadataStore } from '../../../../src/storage/metadata-store.js';
import { createEmbeddingCacheIdentity } from '../../../../src/indexer/embedding-cache-identity.js';
import type { EmbeddingCacheEntry } from '../../../../src/types/index.js';
import { expectedCacheKeys, seedCompatibleCache } from '../../../benchmarks/performance/cache-seed.js';
import { createSyntheticProvider } from '../../../benchmarks/performance/synthetic-provider.js';
import { createSeedFixture } from './cache-seed-fixture.js';

const fixtures: Awaited<ReturnType<typeof createSeedFixture>>[] = [];
async function fixture(count = 1_025) {
  const value = await createSeedFixture(count);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()));
});

describe('bounded compatible cache seeding', () => {
  it('requests, writes and reads back exactly 512/512/1 items while releasing prior vector batches', async () => {
    const current = await fixture();
    const sourceGet = current.source.metadataStore.getEmbeddings.bind(current.source.metadataStore);
    const targetGet = current.target.metadataStore.getEmbeddings.bind(current.target.metadataStore);
    const targetSet = current.target.metadataStore.setEmbeddings.bind(current.target.metadataStore);
    const sourceSizes: number[] = [];
    const sourceKeys: string[][] = [];
    const targetSizes: number[] = [];
    const writeSizes: number[] = [];
    const sourceMaps: Map<string, number[]>[] = [];
    const targetMaps: Map<string, number[]>[] = [];
    const writes: EmbeddingCacheEntry[][] = [];
    const releasedAtEntry: boolean[] = [];
    vi.spyOn(current.source.metadataStore, 'getEmbeddings').mockImplementation(async (keys) => {
      sourceSizes.push(keys.length);
      sourceKeys.push([...keys]);
      releasedAtEntry.push([...sourceMaps, ...targetMaps].every((map) => map.size === 0) && writes.every((entries) => entries.length === 0));
      const result = await sourceGet(keys);
      sourceMaps.push(result);
      return result;
    });
    vi.spyOn(current.target.metadataStore, 'setEmbeddings').mockImplementation(async (entries) => {
      writeSizes.push(entries.length);
      writes.push(entries);
      await targetSet(entries);
    });
    vi.spyOn(current.target.metadataStore, 'getEmbeddings').mockImplementation(async (keys) => {
      targetSizes.push(keys.length);
      const result = await targetGet(keys);
      targetMaps.push(result);
      return result;
    });
    const result = await seedCompatibleCache(current.source, current.target, current.manifest, new AbortController().signal);
    expect(result).toMatchObject({ status: 'valid', expectedKeyCount: 1_025, verifiedKeyCount: 1_025,
      batchLimit: 512, maxRequestedBatchSize: 512 });
    expect(sourceSizes).toEqual([512, 512, 1]);
    expect(sourceKeys.flat()).toEqual([...current.keys].sort());
    expect(writeSizes).toEqual([512, 512, 1]);
    expect(targetSizes).toEqual([512, 512, 1]);
    expect(releasedAtEntry).toEqual([true, true, true]);
    expect([...sourceMaps, ...targetMaps].every((map) => map.size === 0)).toBe(true);
    expect(writes.every((entries) => entries.length === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(current.source.databasePath);
    expect(JSON.stringify(result)).not.toContain('"vector"');
  });

  it.each(['batch-two', 'abort-batch-two', 'missing-source', 'corrupt-source', 'nonfinite-source', 'foreign-source',
    'extra-target', 'missing-target', 'readback-mismatch', 'identity', 'timeout', 'abort'] as const)(
    'fails closed and removes only the owned partial target for %s', async (mode) => {
      const current = await fixture(mode === 'batch-two' || mode === 'abort-batch-two' ? 1_025 : 12);
      const sourceGet = current.source.metadataStore.getEmbeddings.bind(current.source.metadataStore);
      const targetGet = current.target.metadataStore.getEmbeddings.bind(current.target.metadataStore);
      const targetSet = current.target.metadataStore.setEmbeddings.bind(current.target.metadataStore);
      const controller = new AbortController();
      let writes = 0;
      if (mode === 'batch-two' || mode === 'abort-batch-two') vi.spyOn(current.target.metadataStore, 'setEmbeddings').mockImplementation(async (entries) => {
        writes += 1;
        if (writes === 2 && mode === 'batch-two') throw new Error('injected_second_batch_failure');
        await targetSet(entries);
        if (writes === 2 && mode === 'abort-batch-two') controller.abort();
      });
      if (mode === 'missing-source' || mode === 'corrupt-source' || mode === 'nonfinite-source' || mode === 'foreign-source') {
        vi.spyOn(current.source.metadataStore, 'getEmbeddings').mockImplementationOnce(async (keys) => {
          const values = await sourceGet(keys);
          const first = keys[0];
          if (first === undefined) throw new Error('key required');
          switch (mode) {
            case 'missing-source': values.delete(first); break;
            case 'corrupt-source': values.set(first, [0]); break;
            case 'nonfinite-source': values.set(first, Array.from({ length: 128 }, () => NaN)); break;
            case 'foreign-source': values.set('foreign-key', Array.from({ length: 128 }, () => 0)); break;
          }
          return values;
        });
      }
      if (mode === 'extra-target') vi.spyOn(current.target.metadataStore, 'setEmbeddings').mockImplementationOnce(async (entries) => {
        await targetSet(entries);
        const vectors = await createSyntheticProvider().embed(['extra']);
        const vector = vectors[0];
        if (vector === undefined) throw new Error('vector required');
        await targetSet([{ hash: 'foreign-extra-key', vector }]);
      });
      if (mode === 'missing-target' || mode === 'readback-mismatch') {
        vi.spyOn(current.target.metadataStore, 'getEmbeddings').mockImplementationOnce(async (keys) => {
          const values = await targetGet(keys);
          const first = keys[0];
          if (first === undefined) throw new Error('key required');
          if (mode === 'missing-target') await current.target.metadataStore.deleteEmbeddings([first]);
          else values.set(first, Array.from({ length: 128 }, () => 1));
          return values;
        });
      }
      if (mode === 'timeout') controller.abort(new DOMException('deadline', 'TimeoutError'));
      if (mode === 'abort') controller.abort();
      const target = mode === 'identity' ? { ...current.target,
        embeddingConfig: { ...current.target.embeddingConfig, model: 'incompatible-model' } } : current.target;
      const result = await seedCompatibleCache(current.source, target, current.manifest, controller.signal);
      expect(result).toMatchObject({ status: 'invalid', phase: 'setup' });
      await expect(access(current.target.databasePath)).rejects.toThrow();
      await expect(access(current.source.databasePath)).resolves.toBeUndefined();
      expect(() => current.source.metadataStore.getPragmaValue('user_version')).toThrow();
      expect(() => current.target.metadataStore.getPragmaValue('user_version')).toThrow();
      expect(JSON.stringify(result)).not.toContain('incompatible-model');
    },
  );

  it('forms one distinct key union from both physical chunk views', async () => {
    const current = await fixture(2);
    const file = current.manifest.files[0];
    const first = file?.legacyRows[0];
    const second = file?.legacyRows[1];
    if (file === undefined || first === undefined || second === undefined) throw new Error('rows required');
    const manifest = { ...current.manifest, files: [{ ...file, legacyRows: [first, first], structuredRows: [first, second] }] };
    const identity = createEmbeddingCacheIdentity(current.source.embeddingConfig);
    expect(expectedCacheKeys(manifest, current.source.embeddingConfig))
      .toEqual([identity.keyFor(first.contentHash), identity.keyFor(second.contentHash)].sort());
  });

  it('rejects an unowned target without closing or deleting caller-owned resources', async () => {
    const current = await fixture(2);
    const path = join(current.source.projectRoot, 'unowned.db');
    const store = new SqliteMetadataStore({ databasePath: path });
    try {
      await store.initialize();
      const target = { metadataStore: store, embeddingConfig: current.source.embeddingConfig, databasePath: path };
      expect(await seedCompatibleCache(current.source, target, current.manifest, new AbortController().signal))
        .toMatchObject({ status: 'invalid', code: 'target_not_owned' });
      expect(store.getPragmaValue('user_version')).toBeTypeOf('number');
      expect(current.source.metadataStore.getPragmaValue('user_version')).toBeTypeOf('number');
    } finally { await store.close(); }
  });
});
