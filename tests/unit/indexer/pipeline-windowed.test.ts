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
