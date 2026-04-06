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

    expect(result).toEqual({ retried: 0, removed: 0, skipped: 1 });
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

    expect(result).toEqual({ retried: 0, removed: 1, skipped: 0 });
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

    expect(result).toEqual({ retried: 1, removed: 1, skipped: 0 });
    expect(reprocess).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/src/auth.ts', contentHash: 'hash-1' }),
    );
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
  });
});
