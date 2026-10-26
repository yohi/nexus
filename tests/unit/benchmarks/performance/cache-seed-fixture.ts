import { computeStringHash } from '../../../../src/indexer/hash.js';
import { generateFixture } from '../../../benchmarks/performance/fixtures.js';
import { createSyntheticProvider } from '../../../benchmarks/performance/synthetic-provider.js';
import { createCacheSeedTarget, expectedCacheKeys } from '../../../benchmarks/performance/cache-seed.js';

export async function createSeedFixture(count: number) {
  const source = await createCacheSeedTarget();
  const target = await createCacheSeedTarget();
  try {
    const initial = await generateFixture(source.projectRoot, 'smoke');
    const file = initial.files[0];
    const row = file?.legacyRows[0];
    if (file === undefined || row === undefined) throw new Error('fixture row required');
    const legacyRows = await Promise.all(Array.from({ length: count }, async (_, index) => ({ ...row,
      key: `unit-key-${index}`, contentHash: await computeStringHash(`seed-input-${index}`),
    })));
    const manifest = { ...initial, files: [{ ...file, legacyRows, structuredRows: [] }] };
    const keys = expectedCacheKeys(manifest, source.embeddingConfig);
    for (let start = 0; start < keys.length; start += 512) {
      const batch = keys.slice(start, start + 512);
      const vectors = await createSyntheticProvider().embed([...batch]);
      await source.metadataStore.setEmbeddings(batch.map((hash, index) => {
        const vector = vectors[index];
        if (vector === undefined) throw new Error('vector required');
        return { hash, vector };
      }));
    }
    return { source, target, manifest, keys,
      dispose: async () => { await target.dispose(); await source.dispose(); } };
  } catch (error) {
    await target.dispose();
    await source.dispose();
    throw error;
  }
}
