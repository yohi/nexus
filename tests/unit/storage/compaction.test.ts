import { describe, expect, it, vi } from 'vitest';

import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import type { CodeChunk } from '../../../src/types/index.js';

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

describe('LanceVectorStore compaction integration', () => {
  it('waits for the mutex before running idle compaction', async () => {
    vi.useFakeTimers();
    const mutex = {
      waitForUnlock: vi.fn(async () => undefined),
    };
    const runCompaction = vi.fn(async () => undefined);
    const store = new LanceVectorStore({ dimensions: 3 });

    store.scheduleIdleCompaction(runCompaction, 10, mutex as any);
    await vi.advanceTimersByTimeAsync(10);

    expect(mutex.waitForUnlock).toHaveBeenCalledTimes(1);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('runs post-reindex compaction immediately when fragmentation exceeds threshold', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a', filePath: 'src/a.ts' })]);
    await store.deleteByFilePath('src/a.ts');

    const result = await store.compactAfterReindex({ fragmentationThreshold: 0, minStaleChunks: 1 });

    expect(result.compacted).toBe(true);
    expect(result.chunksRemoved).toBe(1);
  });

  it('skips post-reindex compaction when fragmentation is below threshold', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a', filePath: 'src/a.ts' })]);

    const result = await store.compactAfterReindex({ fragmentationThreshold: 0.2, minStaleChunks: 1 });

    expect(result).toEqual({
      compacted: false,
      fragmentationRatioBefore: 0,
      fragmentationRatioAfter: 0,
      chunksRemoved: 0,
    });
  });
});
