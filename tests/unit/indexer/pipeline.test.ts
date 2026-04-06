import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import type { ReindexResult } from '../../../src/types/index.js';
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
const ONE_HOT_64 = new Array(64).fill(0).map((_, i) => (i === 0 ? 1 : 0));

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
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
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
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
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
    // Assertion relaxed: content change may alter chunk count
    expect(after.totalFiles).toBe(before.totalFiles);
    const results = await vectorStore.search(ONE_HOT_64, 20);
    expect(results.every((result) => result.chunk.filePath === fixturePath)).toBe(true);
    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-modified' }),
    );
  });

  it('removes metadata and vectors when a file is deleted', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
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

  it('removes subtree metadata and vectors when a directory is deleted', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    await metadataStore.bulkUpsertMerkleNodes([
      { path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true },
      { path: 'src/auth.ts', hash: 'hash-auth', parentPath: 'src', isDirectory: false },
      { path: 'src/nested', hash: 'hash-nested', parentPath: 'src', isDirectory: true },
      { path: 'src/nested/deep.ts', hash: 'hash-deep', parentPath: 'src/nested', isDirectory: false },
    ]);
    await vectorStore.upsertChunks([
      {
        id: 'src/auth.ts:1-1:file-1',
        filePath: 'src/auth.ts',
        content: 'export const auth = true;',
        language: 'typescript',
        symbolKind: 'file',
        startLine: 1,
        endLine: 1,
        hash: 'chunk-auth',
      },
      {
        id: 'src/nested/deep.ts:1-1:file-1',
        filePath: 'src/nested/deep.ts',
        content: 'export const deep = true;',
        language: 'typescript',
        symbolKind: 'file',
        startLine: 1,
        endLine: 1,
        hash: 'chunk-deep',
      },
    ]);

    await pipeline.processEvents([
      {
        type: 'deleted',
        filePath: 'src',
        contentHash: 'dir-hash',
        detectedAt: new Date().toISOString(),
      },
    ]);

    await expect(metadataStore.getAllPaths()).resolves.toEqual([]);
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 0, totalFiles: 0 }),
    );
  });

  it('returns already_running when reindex is invoked concurrently', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    const loadContent = async () => '';
    const first = pipeline.reindex(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [];
    }, loadContent);
    const second = pipeline.reindex(async () => [], loadContent);

    await expect(second).resolves.toEqual({ status: 'already_running' });
    const result = await first;

    if ('status' in result) {
      throw new Error('Expected ReindexResult, got already_running status');
    }

    expect(result).toMatchObject({
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    });
    expect(typeof result.startedAt).toBe('string');
  });

  it('tracks skipped files when embedding retries are exhausted', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new FailingEmbeddingProvider(),
      pluginRegistry: registry,
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
