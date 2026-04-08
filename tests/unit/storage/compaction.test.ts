import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodeChunk } from '../../../src/types/index.js';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

const makeChunk = (overrides: Partial<CodeChunk>): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/file.ts',
  content: overrides.content ?? 'export const value = 1;',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
});

describe('LanceVectorStore compaction integration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips compaction when fragmentation is below the threshold', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a' }), makeChunk({ id: 'b', filePath: 'src/b.ts' })]);
    await store.deleteByFilePath('src/file.ts');

    const result = await store.compactIfNeeded({ fragmentationThreshold: 0.8 });

    expect(result.compacted).toBe(false);
    expect(result.fragmentationRatioBefore).toBeLessThan(0.8);
  });

  it('compacts deleted rows once fragmentation reaches the threshold', async () => {
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a' }), makeChunk({ id: 'b', filePath: 'src/b.ts' })]);
    await store.deleteByFilePath('src/file.ts');

    const result = await store.compactIfNeeded({ fragmentationThreshold: 0.2, minStaleChunks: 1 });

    expect(result.compacted).toBe(true);
    expect(result.chunksRemoved).toBe(1);
    expect(result.fragmentationRatioAfter).toBe(0);
  });

  it('runs idle compaction only after acquiring the mutex', async () => {
    vi.useRealTimers();
    const store = new LanceVectorStore({ dimensions: 3 });
    await store.initialize();
    const order: string[] = [];
    let unlock: (() => void) | undefined;
    const mutex = {
      waitForUnlock: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            unlock = resolve;
          }),
      ),
    };

    store.scheduleIdleCompaction(
      async () => {
        order.push('compaction-start');
      },
      10,
      mutex,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    expect(mutex.waitForUnlock).toHaveBeenCalledOnce();

    unlock?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(order).toEqual(['compaction-start']);
  });
});
