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
  it('throws an error if dimensions is not a positive integer', () => {
    expect(() => new InMemoryVectorStore({ dimensions: 0 })).toThrow('dimensions must be a positive integer');
    expect(() => new InMemoryVectorStore({ dimensions: -1 })).toThrow('dimensions must be a positive integer');
    expect(() => new InMemoryVectorStore({ dimensions: 3.5 })).toThrow('dimensions must be a positive integer');
    expect(() => new InMemoryVectorStore({ dimensions: NaN })).toThrow('dimensions must be a positive integer');
    expect(() => new InMemoryVectorStore({ dimensions: Infinity })).toThrow('dimensions must be a positive integer');
  });

  it('upserts chunks and returns them by vector similarity search', async () => {
    const store = new InMemoryVectorStore({ dimensions: 3 });

    await store.initialize();
    await store.upsertChunks([
      makeChunk({ id: 'a', filePath: 'src/a.ts', content: 'alpha' }),
      makeChunk({ id: 'b', filePath: 'src/b.ts', content: 'beta' }),
    ]);

    // 'alpha' maps to [0, 1, 0] when dimensions=3
    const results = await store.search([0, 1, 0], 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.chunk.filePath).toBe('src/a.ts');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
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
  it('throws an error if dimensions is not a positive integer', () => {
    expect(() => new LanceVectorStore({ dimensions: 0 })).toThrow('dimensions must be a positive integer');
    expect(() => new LanceVectorStore({ dimensions: -1 })).toThrow('dimensions must be a positive integer');
    expect(() => new LanceVectorStore({ dimensions: 3.5 })).toThrow('dimensions must be a positive integer');
    expect(() => new LanceVectorStore({ dimensions: NaN })).toThrow('dimensions must be a positive integer');
    expect(() => new LanceVectorStore({ dimensions: Infinity })).toThrow('dimensions must be a positive integer');
  });

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

  it('performs core vector store operations: upsert, search, delete, and compact', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    await store.upsertChunks([
      makeChunk({ id: 'chunk1', filePath: 'src/file1.ts', content: 'test content' })
    ]);
    let stats = await store.getStats();
    expect(stats.totalChunks).toBe(1);
    expect(stats.totalFiles).toBe(1);

    // 'test content' (t=116) maps to [0, 0, 1] when dimensions=3
    const results = await store.search([0, 0, 1], 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('chunk1');

    await store.deleteByFilePath('src/file1.ts');
    const afterDeleteResults = await store.search([0, 0, 1], 10);
    expect(afterDeleteResults).toHaveLength(0);
    stats = await store.getStats();
    expect(stats.fragmentationRatio).toBe(1); // 1 deleted / 1 total row

    // Re-upsert the same chunk
    await store.upsertChunks([
      makeChunk({ id: 'chunk1', filePath: 'src/file1.ts', content: 'updated content' })
    ]);
    stats = await store.getStats();
    // This should be 0 because the only row is now active again
    expect(stats.fragmentationRatio).toBe(0);

    // Delete it again to test compaction
    await store.deleteByFilePath('src/file1.ts');
    stats = await store.getStats();
    expect(stats.fragmentationRatio).toBe(1);
    
    const compactResult = await store.compactIfNeeded({ fragmentationThreshold: 0 });
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.chunksRemoved).toBe(1);
    stats = await store.getStats();
    expect(stats.lastCompactedAt).toBeDefined();
  });

  it('validates embeddings in upsertChunks', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    const chunk = makeChunk({ id: 'c1' });

    // Length mismatch (top-level array)
    await expect(store.upsertChunks([chunk], [[1, 0, 0], [0, 1, 0]]))
      .rejects.toThrow('VectorStore.upsertChunks: embeddings length mismatch');

    // Vector dimension mismatch
    await expect(store.upsertChunks([chunk], [[1, 0]]))
      .rejects.toThrow('VectorStore.upsertChunks: vector length mismatch for chunk c1');

    // Non-finite values
    await expect(store.upsertChunks([chunk], [[1, NaN, 0]]))
      .rejects.toThrow('VectorStore.upsertChunks: vector contains non-finite values for chunk c1');
    await expect(store.upsertChunks([chunk], [[1, Infinity, 0]]))
      .rejects.toThrow('VectorStore.upsertChunks: vector contains non-finite values for chunk c1');
  });

  it('validates queryVector in search', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    await expect(store.search([1, NaN, 0], 10))
      .rejects.toThrow('queryVector contains non-finite values');
    await expect(store.search([1, Infinity, 0], 10))
      .rejects.toThrow('queryVector contains non-finite values');
  });

  it('renames file paths and handles conflicts correctly', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    // 1. Basic rename
    await store.upsertChunks([
      makeChunk({ id: 'src/file1.ts:0', filePath: 'src/file1.ts' }),
      makeChunk({ id: 'src/file1.ts:1', filePath: 'src/file1.ts' }),
    ]);

    let stats = await store.getStats();
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalChunks).toBe(2);

    const renamedCount = await store.renameFilePath('src/file1.ts', 'src/moved.ts');
    expect(renamedCount).toBe(2);

    stats = await store.getStats();
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalChunks).toBe(2);

    const results = await store.search([1, 0, 0], 10);
    expect(results.every((r) => r.chunk.filePath === 'src/moved.ts')).toBe(true);
    expect(results.map((r) => r.chunk.id).sort()).toEqual(['src/moved.ts:0', 'src/moved.ts:1'].sort());

    // 2. Behavior when newPath already contains chunks (should be cleared)
    await store.upsertChunks([makeChunk({ id: 'src/target.ts:0', filePath: 'src/target.ts' })]);
    stats = await store.getStats();
    expect(stats.totalChunks).toBe(3); // 2 moved + 1 target

    // Rename moved.ts to target.ts. Pre-existing target.ts:0 should be cleared.
    await store.renameFilePath('src/moved.ts', 'src/target.ts');
    stats = await store.getStats();
    expect(stats.totalChunks).toBe(2); // Only the 2 renamed chunks should remain

    const targetResults = await store.search([1, 0, 0], 10);
    expect(targetResults).toHaveLength(2);
    expect(targetResults.every((r) => r.chunk.filePath === 'src/target.ts')).toBe(true);

    // 3. ID collision with a deleted chunk
    // Delete one chunk
    await store.deleteByFilePath('src/target.ts');
    stats = await store.getStats();
    expect(stats.fragmentationRatio).toBe(1); // 2/2 deleted

    // Upsert a new file
    await store.upsertChunks([makeChunk({ id: 'src/source.ts:0', filePath: 'src/source.ts' })]);
    // Now we have:
    // - src/target.ts:0 (deleted)
    // - src/target.ts:1 (deleted)
    // - src/source.ts:0 (active)

    // Rename source.ts to target.ts
    // This will collide with deleted src/target.ts:0
    await store.renameFilePath('src/source.ts', 'src/target.ts');

    stats = await store.getStats();
    // The collision should be handled by removing the deleted chunk first or replacing it.
    // deletedCount should decrement correctly when replacing a deleted chunk.
    expect(stats.totalChunks).toBe(1);
    expect(stats.fragmentationRatio).toBe(0);
  });

  it('handles multiple occurrences of the path in the ID during rename', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    const complexPath = 'src/src/file.ts';
    await store.upsertChunks([makeChunk({ id: `${complexPath}:0`, filePath: complexPath })]);

    await store.renameFilePath(complexPath, 'dist/file.ts');

    const results = await store.search([1, 0, 0], 10);
    expect(results[0]?.chunk.id).toBe('dist/file.ts:0');
    expect(results[0]?.chunk.filePath).toBe('dist/file.ts');
  });
});
