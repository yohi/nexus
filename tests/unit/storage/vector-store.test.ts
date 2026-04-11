import { describe, expect, it, vi } from 'vitest';

import type { CodeChunk, IVectorStore } from '../../../src/types/index.js';
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

  it('renames file paths and handles conflicts correctly', async () => {
    const store = new InMemoryVectorStore({ dimensions: 3 });
    await store.initialize();

    // 1. Basic rename
    await store.upsertChunks([
      makeChunk({ id: 'src/file1.ts:0', filePath: 'src/file1.ts' }),
      makeChunk({ id: 'src/file1.ts:1', filePath: 'src/file1.ts' }),
    ]);

    await store.renameFilePath('src/file1.ts', 'src/target.ts');

    const results = await store.search([1, 0, 0], 10);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.chunk.filePath === 'src/target.ts')).toBe(true);
    expect(results.some((r) => r.chunk.id === 'src/target.ts:0')).toBe(true);

    // 2. Target path exists
    // Clear any existing at target path before rename
    await store.deleteByFilePath('src/target.ts');
    const result = await store.compactIfNeeded({ fragmentationThreshold: 0 });
    expect(result.compacted).toBe(true);

    await store.upsertChunks([
      makeChunk({ id: 'src/source.ts:0', filePath: 'src/source.ts' }),
      makeChunk({ id: 'src/source.ts:1', filePath: 'src/source.ts' }),
    ]);
    await store.renameFilePath('src/source.ts', 'src/target.ts');

    const targetResults = await store.search([1, 0, 0], 10);
    expect(targetResults).toHaveLength(2);
    expect(targetResults.every((r) => r.chunk.filePath === 'src/target.ts')).toBe(true);

    // 3. ID collision with a deleted chunk
    // Delete one chunk
    await store.deleteByFilePath('src/target.ts');
    await store.upsertChunks([makeChunk({ id: 'src/source.ts:0', filePath: 'src/source.ts' })]);

    // Rename source.ts to target.ts
    // This will collide with deleted src/target.ts:0
    await store.renameFilePath('src/source.ts', 'src/target.ts');

    const finalResults = await store.search([1, 0, 0], 10);
    expect(finalResults).toHaveLength(1);
    expect(finalResults[0]?.chunk.filePath).toBe('src/target.ts');
  });
});

describe('LanceVectorStore', () => {
  it('throws an error if dimensions is not a positive integer', () => {
    expect(() => new LanceVectorStore({ dimensions: 0 })).toThrow('dimensions must be a positive integer');
  });

  it('implements the vector store interface shape', () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    expect(typeof store.initialize).toBe('function');
    expect(typeof store.upsertChunks).toBe('function');
    expect(typeof store.search).toBe('function');
    expect(typeof store.deleteByFilePath).toBe('function');
    expect(typeof store.deleteByPathPrefix).toBe('function');
    expect(typeof store.renameFilePath).toBe('function');
    expect(typeof store.compactIfNeeded).toBe('function');
    expect(typeof (store as IVectorStore).compactAfterReindex).toBe('function');
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
    // LanceVectorStore resets fragmentation ratio immediately on full overwrite/drop
    expect(stats.fragmentationRatio).toBe(0);

    // Re-upsert the same chunk
    await store.upsertChunks([
      makeChunk({ id: 'chunk1', filePath: 'src/file1.ts', content: 'updated content' })
    ]);
    stats = await store.getStats();
    expect(stats.fragmentationRatio).toBe(0);

    // Delete it again
    await store.deleteByFilePath('src/file1.ts');
    stats = await store.getStats();
    expect(stats.fragmentationRatio).toBe(0);
    
    // Compaction should report true but 0 chunks removed because they were already physically removed
    const compactResult = await store.compactIfNeeded({ fragmentationThreshold: 0 });
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.chunksRemoved).toBe(0);
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
  });

  it('renames file paths and handles conflicts correctly', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    // 1. Basic rename
    await store.upsertChunks([
      makeChunk({ id: 'src/file1.ts:0', filePath: 'src/file1.ts' }),
      makeChunk({ id: 'src/file1.ts:1', filePath: 'src/file1.ts' }),
    ]);

    await store.renameFilePath('src/file1.ts', 'src/target.ts');

    const results = await store.search([1, 0, 0], 10);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.chunk.filePath === 'src/target.ts')).toBe(true);
    expect(results.some((r) => r.chunk.id === 'src/target.ts:0')).toBe(true);

    // 2. Target path exists
    // Clear any existing at target path before rename
    await store.deleteByFilePath('src/target.ts');
    
    await store.upsertChunks([
      makeChunk({ id: 'src/source.ts:0', filePath: 'src/source.ts' }),
      makeChunk({ id: 'src/source.ts:1', filePath: 'src/source.ts' }),
    ]);
    await store.renameFilePath('src/source.ts', 'src/target.ts');

    let stats = await store.getStats();
    expect(stats.totalChunks).toBe(2);

    const targetResults = await store.search([1, 0, 0], 10);
    expect(targetResults).toHaveLength(2);
    expect(targetResults.every((r) => r.chunk.filePath === 'src/target.ts')).toBe(true);

    // 3. ID collision with a deleted chunk
    // Delete one chunk
    await store.deleteByFilePath('src/target.ts');
    stats = await store.getStats();
    expect(stats.fragmentationRatio).toBe(0);

    // Upsert a new file
    await store.upsertChunks([makeChunk({ id: 'src/source.ts:0', filePath: 'src/source.ts' })]);

    // Rename source.ts to target.ts
    await store.renameFilePath('src/source.ts', 'src/target.ts');

    stats = await store.getStats();
    expect(stats.totalChunks).toBe(1);
    expect(stats.fragmentationRatio).toBe(0);

    // 4. Does not mutate if oldPath does not exist
    await store.upsertChunks([makeChunk({ id: 'src/another.ts:0', filePath: 'src/another.ts' })]);
    const count = await store.renameFilePath('src/non-existent.ts', 'src/another.ts');
    expect(count).toBe(0);
    const anotherResults = await store.search([1, 0, 0], 10);
    expect(anotherResults.some(r => r.chunk.filePath === 'src/another.ts')).toBe(true);
  });

  it('handles multiple occurrences of the path in the ID during rename', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    // The ID contains 'src/path' twice to verify replaceAll.
    const oldPath = 'src/path';
    const newPath = 'dist/moved';
    const multiOccurId = `${oldPath}:${oldPath}:0`;

    await store.upsertChunks([makeChunk({ id: multiOccurId, filePath: oldPath })]);

    await store.renameFilePath(oldPath, newPath);

    const results = await store.search([1, 0, 0], 10);
    expect(results[0]?.chunk.id).toBe(`${newPath}:${newPath}:0`);
    expect(results[0]?.chunk.filePath).toBe(newPath);
  });

  it('throws if accessed after close', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();
    await store.close();

    await expect(store.getStats()).rejects.toThrow('VectorStore is closed');
    await expect(store.upsertChunks([])).rejects.toThrow('VectorStore is closed');
    await expect(store.search([0, 0, 0], 1)).rejects.toThrow('VectorStore is closed');
    await expect(store.deleteByFilePath('a')).rejects.toThrow('VectorStore is closed');
    await expect(store.deleteByPathPrefix('a')).rejects.toThrow('VectorStore is closed');
    await expect(store.renameFilePath('a', 'b')).rejects.toThrow('VectorStore is closed');
    await expect(store.compactIfNeeded()).rejects.toThrow('VectorStore is closed');
  });

  it('waits for in-flight operations during close', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    // Track a public async operation. 
    // In our implementation, it will NOT throw because we removed the post-op isClosed check.
    const upsertPromise = store.upsertChunks([makeChunk({ id: '1' })]);

    const closePromise = store.close();
    
    // closePromise should resolve
    await closePromise;
    
    // upsertPromise should now resolve because it finished normally
    await expect(upsertPromise).resolves.toBeUndefined();
    
    expect(true).toBe(true);
  });

  it('clears scheduled timeouts during close', async () => {
    // initialize BEFORE using fake timers to avoid setImmediate hang
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();

    vi.useFakeTimers();
    try {
      let compactionCalled = false;
      store.scheduleIdleCompaction(async () => {
        compactionCalled = true;
      }, 1000);

      await store.close();

      // Fast-forward time
      vi.advanceTimersByTime(2000);

      expect(compactionCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
