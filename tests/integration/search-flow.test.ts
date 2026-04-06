import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

describe('Phase 2 search flow integration', () => {
  const projectRoot = process.cwd();

  let registry: PluginRegistry;
  let vectorStore: InMemoryVectorStore;
  let pipeline: IndexPipeline;
  let grepEngine: TestGrepEngine;
  let orchestrator: SearchOrchestrator;

  beforeEach(async () => {
    const metadataStore = new InMemoryMetadataStore();
    vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    const embeddingProvider = new TestEmbeddingProvider();

    await metadataStore.initialize();
    await vectorStore.initialize();

    registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerEmbeddingProvider('test', embeddingProvider);
    registry.setActiveEmbeddingProvider('test');

    pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(registry),
      embeddingProvider,
      pluginRegistry: registry,
    });

    grepEngine = new TestGrepEngine();
    const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });
    orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot: process.cwd() });

    const content = await readFile(fixturePath, 'utf8');
    grepEngine.addFile(fixturePath, content);

    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-auth',
          detectedAt: new Date().toISOString(),
        },
      ],
      async (filePath) => {
        expect(filePath).toBe(fixturePath);
        return content;
      },
    );
  });

  it('indexes fixture content and returns ranked hybrid search results', async () => {
    const config = await loadConfig({
      projectRoot,
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'test',
      },
    });

    expect(config.embedding.provider).toBe('test');
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalFiles: 1, totalChunks: 7, dimensions: 64 }),
    );

    const response = await orchestrator.search({
      query: 'authenticate token issuer',
      grepPattern: 'authenticate',
      filePattern: '**/auth.ts',
      topK: 5,
    });

    expect(response.query).toBe('authenticate token issuer');
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]).toMatchObject({
      source: 'hybrid',
      chunk: expect.objectContaining({ filePath: fixturePath }),
    });
    expect(response.results[0]).toHaveProperty('rank');
    expect(response.results[0]).toHaveProperty('reciprocalRankScore');
  });
});
