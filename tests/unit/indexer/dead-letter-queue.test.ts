import { describe, expect, it, vi } from 'vitest';

import { DeadLetterQueue } from '../../../src/indexer/dead-letter-queue.js';
import type { DeadLetterEntry, IMetadataStore } from '../../../src/types/index.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';

const makeEntry = (overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry => ({
  id: overrides.id ?? 'dlq-1',
  filePath: overrides.filePath ?? '/repo/src/auth.ts',
  contentHash: overrides.contentHash ?? 'hash-1',
  errorMessage: overrides.errorMessage ?? 'embed failed',
  attempts: overrides.attempts ?? 3,
  createdAt: overrides.createdAt ?? '2026-04-07T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-07T00:00:00.000Z',
  lastRetryAt: overrides.lastRetryAt ?? null,
});

describe('DeadLetterQueue', () => {
  it('enqueues entries into memory and persistent storage', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    const queue = new DeadLetterQueue({ metadataStore, maxEntries: 2 });

    const entry = await queue.enqueue({
      filePath: '/repo/src/auth.ts',
      contentHash: 'hash-1',
      errorMessage: 'embed failed',
      attempts: 3,
    });

    expect(entry.id).toBeTruthy();
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([entry]);
    expect(queue.snapshot().get('/repo/src/auth.ts')).toBe('embed failed');
  });

  it('keeps only the latest entries in the in-memory ring buffer', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    const queue = new DeadLetterQueue({ metadataStore, maxEntries: 2 });

    await queue.enqueue({ filePath: '/repo/a.ts', contentHash: 'a', errorMessage: 'a', attempts: 3 });
    await queue.enqueue({ filePath: '/repo/b.ts', contentHash: 'b', errorMessage: 'b', attempts: 3 });
    await queue.enqueue({ filePath: '/repo/c.ts', contentHash: 'c', errorMessage: 'c', attempts: 3 });

    expect([...queue.snapshot().keys()]).toEqual(['/repo/b.ts', '/repo/c.ts']);
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([
      expect.objectContaining({ filePath: '/repo/b.ts' }),
      expect.objectContaining({ filePath: '/repo/c.ts' }),
    ]);
  });

  it('purges expired entries from memory and storage', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([
      makeEntry({ id: 'expired', createdAt: '2026-04-05T00:00:00.000Z', updatedAt: '2026-04-05T00:00:00.000Z' }),
      makeEntry({ id: 'fresh', filePath: '/repo/src/fresh.ts', createdAt: '2026-04-07T00:00:00.000Z', updatedAt: '2026-04-07T00:00:00.000Z' }),
    ]);

    const queue = new DeadLetterQueue({
      metadataStore,
      now: () => new Date('2026-04-07T12:00:00.000Z'),
      ttlMs: 24 * 60 * 60 * 1000,
    });
    await queue.load();

    const removed = await queue.purgeExpired();

    expect(removed).toBe(1);
    expect(queue.snapshot().has('/repo/src/auth.ts')).toBe(false);
    expect(queue.snapshot().has('/repo/src/fresh.ts')).toBe(true);
  });

  it('skips recovery when the embedding provider health check fails', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([makeEntry()]);

    const reprocess = vi.fn(async () => undefined);
    const queue = new DeadLetterQueue({
      metadataStore,
      embeddingHealthy: async () => false,
      reprocess,
    });

    const result = await queue.recoverySweep();

    expect(result).toEqual({ retried: 0, purged: 0, skipped: 1 });
    expect(reprocess).not.toHaveBeenCalled();
  });

  it('removes stale entries when the file hash no longer matches', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([makeEntry()]);

    const logger = { warn: vi.fn(), error: vi.fn() };
    const queue = new DeadLetterQueue({
      metadataStore,
      embeddingHealthy: async () => true,
      computeFileHash: async () => 'different-hash',
      reprocess: vi.fn(async () => undefined),
      logger,
    });

    const result = await queue.recoverySweep();

    expect(result).toEqual({ retried: 0, purged: 1, skipped: 0 });
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('retries matching entries and removes them after successful recovery', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([makeEntry()]);

    const reprocess = vi.fn(async () => undefined);
    const queue = new DeadLetterQueue({
      metadataStore,
      embeddingHealthy: async () => true,
      computeFileHash: async () => 'hash-1',
      reprocess,
    });

    const result = await queue.recoverySweep();

    expect(result).toEqual({ retried: 1, purged: 0, skipped: 0 });
    expect(reprocess).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/src/auth.ts', contentHash: 'hash-1' }),
    );
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
  });

  it('returns a no-op stopper when recovery loop is started twice', () => {
    vi.useFakeTimers();
    const metadataStore = new InMemoryMetadataStore();
    const queue = new DeadLetterQueue({
      metadataStore,
    });

    const stopFirst = queue.startRecoveryLoop(60_000);
    const stopSecond = queue.startRecoveryLoop(60_000);

    expect(stopSecond).not.toBe(stopFirst);
    stopSecond();
    stopFirst();
    vi.useRealTimers();
  });

  it('updates existing entries with the same filePath instead of creating new ones', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    const queue = new DeadLetterQueue({
      metadataStore,
      now: () => new Date('2026-04-07T00:00:00.000Z'),
    });

    const firstEntry = await queue.enqueue({
      filePath: '/repo/src/auth.ts',
      contentHash: 'hash-1',
      errorMessage: 'error 1',
      attempts: 1,
    });

    // 1時間後
    const secondNow = new Date('2026-04-07T01:00:00.000Z');
    const queue2 = new DeadLetterQueue({
      metadataStore,
      now: () => secondNow,
    });
    await queue2.load();

    const secondEntry = await queue2.enqueue({
      filePath: '/repo/src/auth.ts',
      contentHash: 'hash-2',
      errorMessage: 'error 2',
      attempts: 2,
    });

    expect(secondEntry.id).toBe(firstEntry.id);
    expect(secondEntry.createdAt).toBe(firstEntry.createdAt);
    expect(secondEntry.updatedAt).toBe(secondNow.toISOString());
    expect(secondEntry.contentHash).toBe('hash-2');
    expect(secondEntry.errorMessage).toBe('error 2');
    expect(secondEntry.attempts).toBe(2);

    const persisted = await metadataStore.getDeadLetterEntries();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(secondEntry);
  });

  it('prevents concurrent recovery sweeps', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    const queue = new DeadLetterQueue({
      metadataStore,
      computeFileHash: async () => 'a',
      reprocess: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50)); // 意図的に遅延させる
      },
    });
    await queue.enqueue({ filePath: 'a', contentHash: 'a', errorMessage: 'a', attempts: 1 });

    const sweep1 = queue.recoverySweep();
    const sweep2 = queue.recoverySweep();

    const [res1, res2] = await Promise.all([sweep1, sweep2]);

    expect(res1.retried).toBe(1);
    expect(res2.retried).toBe(0); // 2つ目はスキップされるはず
  });

  it('warns when starting recovery loop while already running', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const queue = new DeadLetterQueue({
      metadataStore: new InMemoryMetadataStore(),
      logger,
    });

    const stop1 = queue.startRecoveryLoop();
    queue.startRecoveryLoop();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already running'));
    stop1();
  });
});
