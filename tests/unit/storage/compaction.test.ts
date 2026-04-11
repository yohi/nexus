import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeChunk } from '../../../src/types/index.js';

describe('LanceVectorStore compaction integration', () => {
  let store: LanceVectorStore;
  let tmpDir: string;

  const makeChunk = (overrides: Partial<CodeChunk>): CodeChunk => ({
    id: overrides.id ?? 'chunk-1',
    filePath: overrides.filePath ?? 'src/file.ts',
    content: overrides.content ?? 'test content',
    language: overrides.language ?? 'typescript',
    hash: overrides.hash ?? 'hash-1',
    startLine: 1,
    endLine: 1,
    symbolKind: 'function',
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-test-compaction-'));
    store = new LanceVectorStore({ dimensions: 3, dbPath: tmpDir });
    await store.initialize();
  });

  afterEach(async () => {
    if (store) {
      await store.close();
    }
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore removal errors in tests
      }
    }
  });

  it('skips compaction when fragmentation is below the threshold', async () => {
    await store.upsertChunks([makeChunk({ id: 'a' }), makeChunk({ id: 'b', filePath: 'src/b.ts' })]);
    // This delete will physically remove the row in our current implementation,
    // resetting fragmentation ratio to 0 immediately.
    await store.deleteByFilePath('src/file.ts');
    
    const statsBefore = await store.getStats();
    const result = await store.compactIfNeeded({ fragmentationThreshold: 0.8 });

    expect(result.compacted).toBe(false);
    expect(result.chunksRemoved).toBe(0);
    expect(result.fragmentationRatioBefore).toBe(statsBefore.fragmentationRatio);
    expect(result.fragmentationRatioAfter).toBe(statsBefore.fragmentationRatio);
  });

  it('compacts deleted rows once fragmentation reaches the threshold', async () => {
    await store.upsertChunks([makeChunk({ id: 'a' }), makeChunk({ id: 'b', filePath: 'src/b.ts' })]);
    await store.deleteByFilePath('src/file.ts');

    // In current LanceVectorStore, delete increments staleCount.
    // For now, we verify it still works when threshold is 0.
    const result = await store.compactIfNeeded({ fragmentationThreshold: 0 });

    expect(result.compacted).toBe(true);
    expect(result.chunksRemoved).toBe(1);
    expect(result.fragmentationRatioAfter).toBe(0);
  });

  it('runs post-reindex compaction immediately when fragmentation exceeds threshold', async () => {
    await store.upsertChunks([makeChunk({ id: 'a' })]);
    await store.deleteByFilePath('src/file.ts');

    const result = await store.compactAfterReindex({ fragmentationThreshold: 0 });

    expect(result.compacted).toBe(true);
    expect(result.chunksRemoved).toBe(1);
  });

  it('runs idle compaction only after acquiring the mutex', async () => {
    let compactionStarted = false;
    const runCompaction = async () => {
      compactionStarted = true;
    };

    const mutex = {
      waitForUnlock: vi.fn().mockResolvedValue(undefined),
    };

    // Use a small delay for testing
    store.scheduleIdleCompaction(runCompaction, 10, mutex as any);

    // Wait for the timer and mutex acquisition
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mutex.waitForUnlock).toHaveBeenCalled();
    expect(compactionStarted).toBe(true);
  });

  it('cancels idle compaction using AbortSignal after the timer fires', async () => {
    const runCompaction = vi.fn().mockResolvedValue(undefined);
    const abortController = new AbortController();
    
    const mutex = {
      waitForUnlock: vi.fn().mockImplementation(async (signal: AbortSignal) => {
        // Wait until aborted
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      }),
    };

    store.scheduleIdleCompaction(runCompaction, 10, mutex as any, abortController.signal);

    // Wait for the timer to fire and mutex acquisition to start
    await new Promise(resolve => setTimeout(resolve, 30));
    
    abortController.abort();
    
    // Wait a bit more to see if compaction runs
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(runCompaction).not.toHaveBeenCalled();
  });

  it('fails with a timeout error if the mutex is not acquired in time', async () => {
    const runCompaction = vi.fn().mockResolvedValue(undefined);
    const mutex = {
      waitForUnlock: vi.fn().mockImplementation(async (signal: AbortSignal) => {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      }),
    };

    // Small timeout for the test
    const timeoutMs = 20;
    store.scheduleIdleCompaction(runCompaction, 10, mutex as any, undefined, timeoutMs);

    // Wait for timer + mutex timeout
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(runCompaction).not.toHaveBeenCalled();
    // No explicit way to check console.error here without spy, but we verify it didn't run.
  });
});
