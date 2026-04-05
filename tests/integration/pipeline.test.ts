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

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-pipeline-integration-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes fixture files with SQLite metadata and vector storage implementations', async () => {
    const metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'metadata.db'),
    });
    const vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const chunker = new Chunker(registry);
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
    });
    const original = await readFile(fixturePath, 'utf8');
    const modified = `${original}\nexport const integrationMarker = true;\n`;

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
      async () => original,
    );

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-added', isDirectory: false }),
    );
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 6, totalFiles: 1, dimensions: 64 }),
    );

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

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-modified' }),
    );

    const searchResults = await vectorStore.search(Array(64).fill(0).map((_, index) => (index === 1 ? 1 : 0)), 20);
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

    await metadataStore.close();
  });

  it('returns completed for a manual reindex execution', async () => {
    const metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'metadata.db'),
    });
    const vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(registry),
      embeddingProvider: new TestEmbeddingProvider(),
    });

    await metadataStore.initialize();
    await vectorStore.initialize();

    await expect(pipeline.reindex(async () => [])).resolves.toEqual({ status: 'completed' });

    await metadataStore.close();
  });
});
