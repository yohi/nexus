import { describe, expect, it } from 'vitest';

import { SemanticSearch } from '../../../src/search/semantic.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';
import type { CodeChunk } from '../../../src/types/index.js';

const makeChunk = (overrides: Partial<CodeChunk>): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/example.ts',
  content: overrides.content ?? 'export function example() {}',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
});

describe('SemanticSearch', () => {
  it('returns ANN matches ranked by embedding similarity', async () => {
    const embeddingProvider = new TestEmbeddingProvider();
    const vectorStore = new InMemoryVectorStore({ dimensions: embeddingProvider.dimensions });
    await vectorStore.initialize();

    const matchingChunk = makeChunk({
      id: 'match',
      filePath: 'src/auth.ts',
      content: 'authenticate user with token',
    });
    const secondaryChunk = makeChunk({
      id: 'secondary',
      filePath: 'src/config.ts',
      content: 'load application settings',
    });

    await vectorStore.upsertChunks(
      [matchingChunk, secondaryChunk],
      await embeddingProvider.embed([matchingChunk.content, secondaryChunk.content]),
    );

    const search = new SemanticSearch({ vectorStore, embeddingProvider });
    const results = await search.search({ query: matchingChunk.content, topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      chunk: expect.objectContaining({ id: 'match' }),
      source: 'semantic',
    });
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0);
  });

  it('applies language and filePattern filters before returning results', async () => {
    const embeddingProvider = new TestEmbeddingProvider();
    const vectorStore = new InMemoryVectorStore({ dimensions: embeddingProvider.dimensions });
    await vectorStore.initialize();

    const authChunk = makeChunk({
      id: 'auth',
      filePath: 'src/auth.ts',
      content: 'authenticate current user',
      language: 'typescript',
    });
    const pythonChunk = makeChunk({
      id: 'python',
      filePath: 'src/auth.py',
      content: 'authenticate current user',
      language: 'python',
    });

    await vectorStore.upsertChunks(
      [authChunk, pythonChunk],
      await embeddingProvider.embed([authChunk.content, pythonChunk.content]),
    );

    const search = new SemanticSearch({ vectorStore, embeddingProvider });
    const results = await search.search({
      query: authChunk.content,
      topK: 10,
      filePattern: 'src/*.ts',
      language: 'typescript',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.filePath).toBe('src/auth.ts');
  });
});
