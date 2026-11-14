import { describe, expect, it, vi } from 'vitest';

import { EventProcessingManager } from '../../../src/server/runtime/events.js';
import type { IndexPipeline } from '../../../src/indexer/pipeline.js';
import type { Config } from '../../../src/types/index.js';

const config = {
  watcher: { debounceMs: 0, maxQueueSize: 10, fullScanThreshold: 8 },
} as Config;

const makePipeline = (reindex: IndexPipeline['reindex']): IndexPipeline => ({
  reindex,
  setEventQueue: vi.fn(),
} as unknown as IndexPipeline);

describe('EventProcessingManager overflow recovery', () => {
  it('retries an overflow full scan after integrity becomes unknown', async () => {
    let calls = 0;
    const reindex = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { status: 'integrity_unknown' as const, reason: 'audit_incomplete' }
        : {
          startedAt: '2026-08-20T00:00:00.000Z',
          finishedAt: '2026-08-20T00:00:01.000Z',
          durationMs: 1000,
          reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
          chunksIndexed: 0,
        };
    });
    const manager = new EventProcessingManager(
      config,
      process.cwd(),
      [],
      makePipeline(reindex),
      async () => '',
    );
    const { eventQueue, onClose } = manager.setup();

    eventQueue.enqueueReindex({ fullScan: true, reason: 'overflow-recovery' });
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(2), { timeout: 5000 });

    expect(reindex).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      expect.any(Function),
      true,
      'overflow-recovery',
    );
    await onClose();
  });

  it('does not retry a non-overflow full scan after integrity becomes unknown', async () => {
    const reindex = vi.fn(async () => ({
      status: 'integrity_unknown' as const,
      reason: 'audit_incomplete',
    }));
    const manager = new EventProcessingManager(
      config,
      process.cwd(),
      [],
      makePipeline(reindex),
      async () => '',
    );
    const { eventQueue, onClose } = manager.setup();

    eventQueue.enqueueReindex({ fullScan: true, reason: 'manual' });
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reindex).toHaveBeenCalledOnce();
    await onClose();
  });

  it('queues another overflow scan when all bounded retries remain integrity-unknown', async () => {
    const reindex = vi.fn(async () => ({
      status: 'integrity_unknown' as const,
      reason: 'audit_incomplete',
    }));
    const manager = new EventProcessingManager(
      config,
      process.cwd(),
      [],
      makePipeline(reindex),
      async () => '',
    );
    const { eventQueue, onClose } = manager.setup();

    eventQueue.enqueueReindex({ fullScan: true, reason: 'overflow-recovery' });
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(4), { timeout: 10000 });

    expect(reindex).toHaveBeenCalledTimes(4);
    await onClose();
  });
});
