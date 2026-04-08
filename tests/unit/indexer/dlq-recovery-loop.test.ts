import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeadLetterQueue } from '../../../src/indexer/dead-letter-queue.js';

describe('DeadLetterQueue recovery loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a periodic recovery sweep and stops cleanly', async () => {
    vi.useFakeTimers();
    const queue = new DeadLetterQueue({
      metadataStore: {
        initialize: async () => undefined,
        bulkUpsertMerkleNodes: async () => undefined,
        bulkDeleteMerkleNodes: async () => undefined,
        deleteSubtree: async () => 0,
        getMerkleNode: async () => null,
        getAllNodes: async () => [],
        getAllFileNodes: async () => [],
        getAllPaths: async () => [],
        getIndexStats: async () => null,
        setIndexStats: async () => undefined,
        upsertDeadLetterEntries: async () => undefined,
        removeDeadLetterEntries: async () => undefined,
        getDeadLetterEntries: async () => [],
      },
    } as any);
    const recoverySweep = vi.spyOn(queue, 'recoverySweep').mockResolvedValue({
      retried: 0,
      purged: 0,
      skipped: 0,
    });

    const stop = queue.startRecoveryLoop(60_000);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(recoverySweep).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoverySweep).toHaveBeenCalledTimes(3);
  });
});
