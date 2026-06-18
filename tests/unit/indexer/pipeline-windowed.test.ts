import { describe, expect, it, vi } from 'vitest';

import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { DimensionMismatchError, RetryExhaustedError } from '../../../src/types/index.js';
import type { IndexEvent } from '../../../src/types/index.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';

class CountingEmbeddingProvider extends TestEmbeddingProvider {
  calls = 0;
  batchSizes: number[] = [];

  override async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.batchSizes.push(texts.length);
    return super.embed(texts);
  }
}

class FailingEmbeddingProvider extends TestEmbeddingProvider {
  override async embed(): Promise<number[][]> {
    throw new RetryExhaustedError('embed failed', 3);
  }
}

class DimensionErrorEmbeddingProvider extends TestEmbeddingProvider {
  override async embed(): Promise<number[][]> {
    throw new DimensionMismatchError('bad dimensions');
  }
}

class ShortEmbeddingProvider extends TestEmbeddingProvider {
  // Returns one fewer embedding than chunks to simulate a broken provider.
  override async embed(texts: string[]): Promise<number[][]> {
    const all = await super.embed(texts);
    return all.slice(0, Math.max(0, all.length - 1));
  }
}

const addEvent = (filePath: string, contentHash: string): IndexEvent => ({
  type: 'added',
  filePath,
  contentHash,
  detectedAt: new Date().toISOString(),
});

/** Produces TypeScript content with `n` top-level functions (≈ n chunks). */
const tsFunctions = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `export function ${tag}_fn${i}(): number {\n  return ${i};\n}`).join('\n\n');

const ZERO_QUERY_64 = new Array(64).fill(0) as number[];

describe('IndexPipeline – windowed batching', () => {
  it('batches chunks across multiple files into ONE embed() call per window', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
    });

    const files: Record<string, string> = {
      'src/a.ts': tsFunctions(2, 'a'),
      'src/b.ts': tsFunctions(3, 'b'),
      'src/c.ts': tsFunctions(1, 'c'),
    };
    const events = Object.keys(files).map((p, i) => addEvent(p, `h${i}`));

    const result = await pipeline.processEvents(events, async (p) => files[p] ?? '');

    // All three files fit in one window => exactly one embed() call.
    expect(embedding.calls).toBe(1);
    const stats = await vectorStore.getStats();
    expect(stats.totalFiles).toBe(3);
    // The single embed batch must contain every chunk across all files.
    expect(embedding.batchSizes[0]).toBe(stats.totalChunks);
    expect(result.chunksIndexed).toBe(stats.totalChunks);
    for (const p of Object.keys(files)) {
      await expect(metadataStore.getMerkleNode(p)).resolves.toEqual(
        expect.objectContaining({ isDirectory: false }),
      );
    }
  });

  it('splits files into windows of embedBatchWindowSize (2 windows for 3 files, size 2)', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 2,
    });

    const files: Record<string, string> = {
      'src/a.ts': tsFunctions(1, 'a'),
      'src/b.ts': tsFunctions(1, 'b'),
      'src/c.ts': tsFunctions(1, 'c'),
    };
    const events = Object.keys(files).map((p, i) => addEvent(p, `h${i}`));

    await pipeline.processEvents(events, async (p) => files[p] ?? '');

    // ceil(3 / 2) = 2 windows => 2 embed() calls.
    expect(embedding.calls).toBe(2);
    const stats = await vectorStore.getStats();
    expect(stats.totalFiles).toBe(3);
  });

  it('attributes embeddings to the correct file across a multi-file window', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new TestEmbeddingProvider();
    const upsertSpy = vi.spyOn(vectorStore, 'upsertChunks');
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
    });

    const files: Record<string, string> = {
      'src/one.ts': tsFunctions(1, 'one'),
      'src/three.ts': tsFunctions(3, 'three'),
    };
    const events = Object.keys(files).map((p, i) => addEvent(p, `h${i}`));

    await pipeline.processEvents(events, async (p) => files[p] ?? '');

    // Each file is upserted separately; embeddings slice length must equal its chunk count,
    // and the chunks' filePaths must match the affected paths (offset attribution correct).
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    for (const call of upsertSpy.mock.calls) {
      const [chunks, embeddings, paths] = call;
      expect(embeddings?.length).toBe(chunks.length);
      expect(new Set(chunks.map((c) => c.filePath))).toEqual(new Set(paths));
    }

    // Per-file chunk counts retrievable via prefix filter.
    const oneResults = await vectorStore.search(ZERO_QUERY_64, 100, { filePathPrefix: 'src/one.ts' });
    const threeResults = await vectorStore.search(ZERO_QUERY_64, 100, { filePathPrefix: 'src/three.ts' });
    expect(oneResults.every((r) => r.chunk.filePath === 'src/one.ts')).toBe(true);
    expect(threeResults.every((r) => r.chunk.filePath === 'src/three.ts')).toBe(true);
    expect(threeResults.length).toBeGreaterThan(oneResults.length);
  });

  it('routes ALL files in a failed embed window to the DLQ (cross-file attribution)', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new FailingEmbeddingProvider(),
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
    });

    const files: Record<string, string> = {
      'src/a.ts': tsFunctions(1, 'a'),
      'src/b.ts': tsFunctions(1, 'b'),
    };
    const events = Object.keys(files).map((p, i) => addEvent(p, `h${i}`));

    await pipeline.processEvents(events, async (p) => files[p] ?? '');

    const dlq = await metadataStore.getDeadLetterEntries();
    expect(dlq.map((e) => e.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(dlq.every((e) => e.errorMessage === 'embed failed' && e.attempts === 3)).toBe(true);
    expect(pipeline.getSkippedFiles().size).toBe(2);
    const stats = await vectorStore.getStats();
    expect(stats.totalChunks).toBe(0);
  });

  it('propagates DimensionMismatchError instead of routing to the DLQ', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new DimensionErrorEmbeddingProvider(),
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
    });

    await expect(
      pipeline.processEvents([addEvent('src/a.ts', 'h0')], async () => tsFunctions(1, 'a')),
    ).rejects.toBeInstanceOf(DimensionMismatchError);

    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
  });

  it('throws on embedding count mismatch instead of silently persisting bad data', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new ShortEmbeddingProvider(),
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
    });

    await expect(
      pipeline.processEvents([addEvent('src/a.ts', 'h0')], async () => tsFunctions(1, 'a')),
    ).rejects.toThrow(/Embedding count mismatch/);

    // No data should have been persisted.
    const stats = await vectorStore.getStats();
    expect(stats.totalChunks).toBe(0);
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
  });

  it('updates merkle and skips embedding for a file that yields zero chunks', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
    });

    await pipeline.processEvents([addEvent('src/empty.ts', 'h-empty')], async () => '');

    // No chunks => no embed() call at all.
    expect(embedding.calls).toBe(0);
    await expect(metadataStore.getMerkleNode('src/empty.ts')).resolves.toEqual(
      expect.objectContaining({ hash: 'h-empty', isDirectory: false }),
    );
  });

  it('keeps processedFiles accurate across deletes and windowed adds', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 2,
    });

    // Seed a file to delete.
    await metadataStore.bulkUpsertMerkleNodes([
      { path: 'src/old.ts', hash: 'old', parentPath: 'src', isDirectory: false },
      { path: 'src', hash: 'dir', parentPath: null, isDirectory: true },
    ]);

    const events: IndexEvent[] = [
      { type: 'deleted', filePath: 'src/old.ts', contentHash: 'old', detectedAt: new Date().toISOString() },
      addEvent('src/a.ts', 'h0'),
      addEvent('src/b.ts', 'h1'),
      addEvent('src/c.ts', 'h2'),
    ];
    const files: Record<string, string> = {
      'src/a.ts': tsFunctions(1, 'a'),
      'src/b.ts': tsFunctions(1, 'b'),
      'src/c.ts': tsFunctions(1, 'c'),
    };

    await pipeline.processEvents(events, async (p) => files[p] ?? '');

    // 1 delete + 3 adds = 4 processed files.
    expect(pipeline.getProgress().processedFiles).toBe(4);
    const stats = await vectorStore.getStats();
    expect(stats.totalFiles).toBe(3);
  });
});

describe('IndexPipeline – chunk embedding cache', () => {
  it('skips embed() on second processEvents call when content is identical', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
      embeddingCacheSize: 10_000,
    });

    const content = tsFunctions(2, 'x');

    // First index: cache is empty → embed() called.
    await pipeline.processEvents([addEvent('src/a.ts', 'h1')], async () => content);
    expect(embedding.calls).toBe(1);
    const firstBatchSize = embedding.batchSizes[0]!;

    // Second index with identical content: all chunks hit the cache → embed() NOT called.
    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/a.ts', contentHash: 'h2', detectedAt: new Date().toISOString() }],
      async () => content,
    );
    expect(embedding.calls).toBe(1); // no additional call
    expect(embedding.batchSizes).toHaveLength(1); // still just the one batch from first call

    // Vectors are still present after the second update.
    const stats = await vectorStore.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalChunks).toBe(firstBatchSize); // same chunk count
  });

  it('re-embeds only changed chunks when content differs after modification', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
      embeddingCacheSize: 10_000,
    });

    const original = tsFunctions(2, 'y');
    const modified = tsFunctions(2, 'y') + '\n\nexport function y_fn2(): number { return 99; }';

    await pipeline.processEvents([addEvent('src/b.ts', 'h1')], async () => original);
    const callsAfterFirst = embedding.calls;

    // Modified content → at least the new chunk must be embedded.
    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/b.ts', contentHash: 'h2', detectedAt: new Date().toISOString() }],
      async () => modified,
    );
    // embed() was called again because at least one chunk hash changed.
    expect(embedding.calls).toBeGreaterThan(callsAfterFirst);
  });

  it('respects embeddingCacheSize=0 (cache disabled) and always calls embed()', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
      embeddingCacheSize: 0,
    });

    const content = tsFunctions(1, 'z');

    await pipeline.processEvents([addEvent('src/c.ts', 'h1')], async () => content);
    expect(embedding.calls).toBe(1);

    // Clear persistent L2 cache to isolate L1 cache-disabled behavior.
    await metadataStore.clearEmbeddings();

    // Same content, cache disabled → embed() is called again.
    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/c.ts', contentHash: 'h2', detectedAt: new Date().toISOString() }],
      async () => content,
    );
    expect(embedding.calls).toBe(2);
  });

  it('evicts LRU entries when embeddingCacheSize is exceeded', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    // Cache size of 1 forces eviction after every new chunk.
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
      embeddingCacheSize: 1,
    });

    const contentA = tsFunctions(1, 'lru_a');
    const contentB = tsFunctions(1, 'lru_b');

    // Index A (1 chunk in cache).
    await pipeline.processEvents([addEvent('src/lru_a.ts', 'h1')], async () => contentA);
    const callsAfterA = embedding.calls;

    // Index B (evicts A from cache).
    // Index B (evicts A from L1 cache).
    await pipeline.processEvents([addEvent('src/lru_b.ts', 'h2')], async () => contentB);
    const callsAfterB = embedding.calls;

    // Clear persistent L2 cache so re-indexing A exercises L1 eviction.
    await metadataStore.clearEmbeddings();

    // Re-index A: A was evicted from L1 and is no longer in L2 → embed() is called again.
    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/lru_a.ts', contentHash: 'h3', detectedAt: new Date().toISOString() }],
      async () => contentA,
    );
    expect(embedding.calls).toBeGreaterThan(callsAfterB);
  });
});


