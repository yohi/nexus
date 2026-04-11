import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { CodeChunk, CompactionMutex } from '../../../src/types/index.js';
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
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-compaction-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips compaction when fragmentation is below the threshold', async () => {
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a' }), makeChunk({ id: 'b', filePath: 'src/b.ts' })]);
    await store.deleteByFilePath('src/file.ts');

    const result = await store.compactIfNeeded({ fragmentationThreshold: 0.8 });

    expect(result.compacted).toBe(false);
    expect(result.fragmentationRatioBefore).toBeLessThan(0.8);
    await store.close();
  });

  it('compacts deleted rows once fragmentation reaches the threshold', async () => {
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a' }), makeChunk({ id: 'b', filePath: 'src/b.ts' })]);
    await store.deleteByFilePath('src/file.ts');

    const result = await store.compactIfNeeded({ fragmentationThreshold: 0.2, minStaleChunks: 1 });

    expect(result.compacted).toBe(true);
    expect(result.chunksRemoved).toBe(1);
    expect(result.fragmentationRatioAfter).toBe(0);
    await store.close();
  });

  it('runs post-reindex compaction immediately when fragmentation exceeds threshold', async () => {
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 3 });
    await store.initialize();
    await store.upsertChunks([makeChunk({ id: 'a', filePath: 'src/a.ts' })]);
    await store.deleteByFilePath('src/a.ts');

    const result = await store.compactAfterReindex({ fragmentationThreshold: 0, minStaleChunks: 1 });

    expect(result.compacted).toBe(true);
    expect(result.chunksRemoved).toBe(1);
    await store.close();
  });

  it('runs idle compaction only after acquiring the mutex', async () => {
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 3 });
    await store.initialize();
    const order: string[] = [];
    let unlock: (() => void) | undefined;
    const mutex: CompactionMutex = {
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

    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual([]);
    expect(mutex.waitForUnlock).toHaveBeenCalledOnce();

    unlock?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(['compaction-start']);
    await store.close();
  });

  it('cancels idle compaction using AbortSignal after the timer fires', async () => {
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 3 });
    await store.initialize();
    const order: string[] = [];
    const controller = new AbortController();
    let unlock: (() => void) | undefined;
    const mutex: CompactionMutex = {
      waitForUnlock: vi.fn(
        (signal?: AbortSignal) =>
          new Promise<void>((resolve, reject) => {
            unlock = resolve;
            signal?.addEventListener('abort', () => {
              reject(new Error('AbortError'));
            });
          }),
      ),
    };

    store.scheduleIdleCompaction(
      async () => {
        order.push('compaction-start');
      },
      10,
      mutex,
      controller.signal,
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(mutex.waitForUnlock).toHaveBeenCalledOnce();

    controller.abort();
    
    unlock?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual([]);
    await store.close();
  });

  it('fails with a timeout error if the mutex is not acquired in time', async () => {
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 3 });
    await store.initialize();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    try {
      const mutex: CompactionMutex = {
        waitForUnlock: vi.fn(
          (signal?: AbortSignal) =>
            new Promise<void>((_, reject) => {
              if (signal?.aborted) {
                reject(signal.reason ?? new Error('AbortError'));
                return;
              }
              signal?.addEventListener('abort', () => {
                reject(signal.reason ?? new Error('AbortError'));
              }, { once: true });
            }),
        ),
      };

      store.scheduleIdleCompaction(
        async () => {},
        10,
        mutex,
        undefined,
        50, // 50ms timeout
      );

      await vi.advanceTimersByTimeAsync(10); // Wait for delayMs
      await vi.advanceTimersByTimeAsync(50); // Wait for mutexTimeoutMs
      await vi.advanceTimersByTimeAsync(0);  // Allow catch block to run

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Compaction failed:',
        expect.objectContaining({
          message: expect.stringContaining('Compaction mutex acquisition timed out after 50ms'),
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
      await store.close();
    }
  });
});
