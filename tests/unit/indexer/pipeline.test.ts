import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { RetryExhaustedError } from '../../../src/types/index.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

class FailingEmbeddingProvider extends TestEmbeddingProvider {
  override async embed(): Promise<number[][]> {
    throw new RetryExhaustedError('embed failed', 3);
  }
}

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

const createPipeline = async () => {
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  const registry = new PluginRegistry();
  registry.registerLanguage(new TypeScriptLanguagePlugin());

  await metadataStore.initialize();
  await vectorStore.initialize();

  return {
    metadataStore,
    vectorStore,
    chunker: new Chunker(registry),
    registry,
  };
};

describe('IndexPipeline', () => {
  it('indexes an added file into merkle metadata and vector storage', async () => {
    const { metadataStore, vectorStore, chunker } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
    });
    const content = await readFile(fixturePath, 'utf8');

    await pipeline.processEvents([
      {
        type: 'added',
        filePath: fixturePath,
        contentHash: 'hash-added',
        detectedAt: new Date().toISOString(),
      },
    ], async () => content);

    const stats = await vectorStore.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-added', isDirectory: false }),
    );
  });

  it('replaces vectors when a file is modified', async () => {
    const { metadataStore, vectorStore, chunker } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
    });
    const original = await readFile(fixturePath, 'utf8');
    const modified = `${original}\nexport const marker = true;\n`;

    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-original',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => original,
    );
    const before = await vectorStore.getStats();

    await pipeline.processEvents(
      [
        {
          type: 'modified',
          filePath: fixturePath,
          contentHash: 'hash-modified',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => modified,
    );

    const after = await vectorStore.getStats();
    expect(after.totalChunks).toBeGreaterThan(0);
    expect(after.totalChunks).toBe(before.totalChunks);
    const results = await vectorStore.search([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 20);
    expect(results.every((result) => result.chunk.filePath === fixturePath)).toBe(true);
    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-modified' }),
    );
  });

  it('removes metadata and vectors when a file is deleted', async () => {
    const { metadataStore, vectorStore, chunker } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
    });
    const content = await readFile(fixturePath, 'utf8');

    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-added',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => content,
    );

    await pipeline.processEvents([
      {
        type: 'deleted',
        filePath: fixturePath,
        contentHash: 'hash-added',
        detectedAt: new Date().toISOString(),
      },
    ]);

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toBeNull();
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 0, totalFiles: 0 }),
    );
  });

  it('returns already_running when reindex is invoked concurrently', async () => {
    const { metadataStore, vectorStore, chunker } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
    });

    const first = pipeline.reindex(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [];
    });
    const second = pipeline.reindex(async () => []);

    await expect(second).resolves.toEqual({ status: 'already_running' });
    await expect(first).resolves.toEqual({ status: 'completed' });
  });

  it('tracks skipped files when embedding retries are exhausted', async () => {
    const { metadataStore, vectorStore, chunker } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new FailingEmbeddingProvider(),
    });
    const content = await readFile(fixturePath, 'utf8');

    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-added',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => content,
    );

    expect(pipeline.getSkippedFiles().get(fixturePath)).toBe('embed failed');
  });
});
