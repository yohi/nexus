import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventQueue } from '../../../src/indexer/event-queue.js';
import { EventProcessingManager } from '../../../src/server/runtime/events.js';
import type { IndexPipeline } from '../../../src/indexer/pipeline.js';
import type { Config } from '../../../src/types/index.js';

const config = {
  watcher: { debounceMs: 0, maxQueueSize: 10, fullScanThreshold: 8 },
} as Config;

const makePipeline = (reindex: IndexPipeline['reindex']): IndexPipeline => ({
  reindex,
  processEvents: vi.fn(async () => undefined),
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

    eventQueue.requestFullScan();
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
    let eventQueue: EventQueue | undefined;
    const reindex = vi.fn(async () => {
      eventQueue?.releaseFullScan();
      return { status: 'integrity_unknown' as const, reason: 'audit_incomplete' };
    });
    const manager = new EventProcessingManager(
      config,
      process.cwd(),
      [],
      makePipeline(reindex),
      async () => '',
    );
    const setup = manager.setup();
    eventQueue = setup.eventQueue;

    eventQueue.requestFullScan();
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(4), { timeout: 10000 });

    expect(reindex).toHaveBeenCalledTimes(4);
    await setup.onClose();
  });

  it('reconciles a file whose watcher event was dropped after integrity-unknown scans', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-overflow-reconcile-'));
    let eventQueue: EventQueue | undefined;
    let scanAttempts = 0;
    const scannedPaths: string[] = [];
    const reindex = vi.fn<IndexPipeline['reindex']>(async (runFullScan) => {
      scanAttempts += 1;
      if (scanAttempts < 4) {
        eventQueue?.releaseFullScan();
        return { status: 'integrity_unknown', reason: 'audit_incomplete' };
      }
      const events = await runFullScan({ fullScan: true, reason: 'overflow-recovery' });
      scannedPaths.push(...events.map((event) => event.filePath));
      return {
        startedAt: '2026-08-20T00:00:00.000Z',
        finishedAt: '2026-08-20T00:00:01.000Z',
        durationMs: 1000,
        reconciliation: { added: events.length, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      };
    });
    const manager = new EventProcessingManager(
      config,
      projectRoot,
      [],
      makePipeline(reindex),
      async () => '',
    );
    const setup = manager.setup();
    eventQueue = setup.eventQueue;
    const target = 'lost-change.ts';

    try {
      for (let index = 0; index < 11; index += 1) {
        const filePath = join(projectRoot, index === 10 ? target : `file-${index}.ts`);
        await writeFile(filePath, `export const value${index} = ${index};\n`);
        const accepted = eventQueue.enqueue({
          type: 'added',
          filePath,
          detectedAt: new Date().toISOString(),
        });
        if (index === 10) expect(accepted).toBe(false);
      }

      expect(eventQueue.getDroppedEventCount()).toBeGreaterThan(0);
      await vi.waitFor(() => expect(scanAttempts).toBeGreaterThanOrEqual(4), { timeout: 15000 });
      await vi.waitFor(() => expect(scannedPaths).toContain(target), { timeout: 15000 });
    } finally {
      await setup.onClose();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
