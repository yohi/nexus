import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import { LanceVectorStore } from '../../src/storage/vector-store.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

describe('IndexPipeline integration', () => {
  let tempDir: string;
  let metadataStore: SqliteMetadataStore;
  let vectorStore: LanceVectorStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-pipeline-integration-'));
  });

  afterEach(async () => {
    await metadataStore?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes fixture files with SQLite metadata and vector storage implementations', async () => {
    metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'metadata.db'),
    });
    vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const chunker = new Chunker(registry);
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const original = await readFile(fixturePath, 'utf8');
    const modified = `${original}\nexport function integrationMarker() {\n}\n`;

    await metadataStore.initialize();
    await vectorStore.initialize();

    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-added',
          detectedAt: new Date().toISOString(),
        },
      ],
      async (path) => {
        expect(path).toBe(fixturePath);
        return original;
      },
    );

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-added', isDirectory: false }),
    );

    // auth.ts currently yields some declarations depending on chunking heuristics.
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalFiles: 1, dimensions: 64 }),
    );
    await expect((await vectorStore.getStats()).totalChunks).toBeGreaterThan(0);
    const initialChunks = (await vectorStore.getStats()).totalChunks;

    await pipeline.processEvents(
      [
        {
          type: 'modified',
          filePath: fixturePath,
          contentHash: 'hash-modified',
          detectedAt: new Date().toISOString(),
        },
      ],
      async (path) => {
        expect(path).toBe(fixturePath);
        return modified;
      },
    );

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-modified' }),
    );

    // After modification with integrationMarker function, chunk count should increase.
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalFiles: 1, dimensions: 64 }),
    );
    await expect((await vectorStore.getStats()).totalChunks).toBeGreaterThan(initialChunks);
    const searchResults = await vectorStore.search(Array(64).fill(0).map((_, index) => (index === 1 ? 1 : 0)), 20);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.every((result) => result.chunk.filePath === fixturePath)).toBe(true);

    await pipeline.processEvents([
      {
        type: 'deleted',
        filePath: fixturePath,
        contentHash: 'hash-modified',
        detectedAt: new Date().toISOString(),
      },
    ]);

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toBeNull();
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 0, totalFiles: 0 }),
    );
  });

  it('handles manual reindex with observable side-effects', async () => {
    metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'reindex-metadata.db'),
    });
    vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(registry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    await metadataStore.initialize();
    await vectorStore.initialize();

    const original = await readFile(fixturePath, 'utf8');

    // 1. Initial indexing
    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-1',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => original,
    );

    // 2. Perform reindex with empty events (Verify ReindexResult per contract)
    const emptyResult = await pipeline.reindex(async () => [], async () => '');
    expect(emptyResult).toMatchObject({
      chunksIndexed: 0,
    });

    // 3. Perform reindex that deletes the file
    const result = await pipeline.reindex(
      async () => [
        {
          type: 'deleted',
          filePath: fixturePath,
          contentHash: 'hash-1',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => '',
    );

    // 4. Verify ReindexResult structure and side-effects
    expect(result).toMatchObject({
      reconciliation: { added: 0, modified: 0, deleted: 1 },
      chunksIndexed: 0,
    });

    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 0, totalFiles: 0 }),
    );

    // 5. Test lock/already-running case
    let startedResolve: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const runReindex = (shouldSignal = false) =>
      pipeline.reindex(
        async () => {
          if (shouldSignal) startedResolve();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [];
        },
        async () => '',
      );

    const firstPromise = runReindex(true);
    await startedPromise;
    const second = await runReindex(false);
    const first = await firstPromise;

    expect(first).not.toEqual({ status: 'already_running' });
    expect(second).toEqual({ status: 'already_running' });
  });
});
