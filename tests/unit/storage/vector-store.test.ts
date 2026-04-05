import { describe, expect, it } from 'vitest';

import type { CodeChunk } from '../../../src/types/index.js';
import { InMemoryVectorStore } from './in-memory-vector-store.js';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

const makeChunk = (overrides: Partial<CodeChunk>): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/index.ts',
  content: overrides.content ?? 'export const value = 1;',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
});

describe('InMemoryVectorStore', () => {
  it('upserts chunks and returns them by vector similarity search', async () => {
    const store = new InMemoryVectorStore({ dimensions: 3 });

    await store.initialize();
    await store.upsertChunks([
      makeChunk({ id: 'a', filePath: 'src/a.ts', content: 'alpha' }),
      makeChunk({ id: 'b', filePath: 'src/b.ts', content: 'beta' }),
    ]);

    const results = await store.search([1, 0, 0], 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.chunk.filePath).toBe('src/a.ts');
  });

  it('deletes vectors by file path', async () => {
    const store = new InMemoryVectorStore({ dimensions: 3 });

    await store.initialize();
    await store.upsertChunks([
      makeChunk({ id: 'a', filePath: 'src/a.ts' }),
      makeChunk({ id: 'b', filePath: 'src/b.ts' }),
    ]);

    const deleted = await store.deleteByFilePath('src/a.ts');

    expect(deleted).toBe(1);
    await expect(store.search([1, 0, 0], 10)).resolves.toHaveLength(1);
  });

  it('deletes vectors by path prefix', async () => {
    const store = new InMemoryVectorStore({ dimensions: 3 });

    await store.initialize();
    await store.upsertChunks([
      makeChunk({ id: 'a', filePath: 'src/a.ts' }),
      makeChunk({ id: 'b', filePath: 'src/nested/b.ts' }),
      makeChunk({ id: 'c', filePath: 'tests/test.ts' }),
    ]);

    const deleted = await store.deleteByPathPrefix('src');

    expect(deleted).toBe(2);
    const results = await store.search([1, 0, 0], 10);
    expect(results.map((result) => result.chunk.filePath)).toEqual(['tests/test.ts']);
  });

  it('skips compaction when fragmentation ratio is below threshold', async () => {
    const store = new InMemoryVectorStore({ dimensions: 3 });

    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a', filePath: 'src/a.ts' })]);

    const result = await store.compactIfNeeded({ fragmentationThreshold: 0.2 });

    expect(result).toEqual({
      compacted: false,
      fragmentationRatioBefore: 0,
      fragmentationRatioAfter: 0,
      chunksRemoved: 0,
    });
  });
});

describe('LanceVectorStore', () => {
  it('implements the vector store interface shape', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });

    await store.initialize();
    await expect(store.getStats()).resolves.toEqual({
      totalChunks: 0,
      totalFiles: 0,
      dimensions: 3,
      fragmentationRatio: 0,
      lastCompactedAt: undefined,
    });
  });
});
