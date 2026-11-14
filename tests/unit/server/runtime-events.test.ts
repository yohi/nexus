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
  getProgress: vi.fn(() => ({ status: 'idle' })),
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
    const reindex = vi.fn(async () => {
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

    setup.eventQueue.requestFullScan();
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(4), { timeout: 10000 });

    expect(reindex).toHaveBeenCalledTimes(4);
    await setup.onClose();
  });

  it('does not release a full-scan queue owned by a competing reindex', async () => {
    let eventQueue: EventQueue | undefined;
    let calls = 0;
    const reindex = vi.fn(async () => {
      calls += 1;
      return { status: 'integrity_unknown' as const, reason: 'audit_incomplete' };
    });
    const pipeline = makePipeline(reindex);
    const idleProgress = pipeline.getProgress();
    vi.mocked(pipeline.getProgress).mockImplementation(() => ({
      ...idleProgress, status: 'running',
    }));
    const manager = new EventProcessingManager(
      config, process.cwd(), [], pipeline, async () => '',
    );
    const setup = manager.setup();
    eventQueue = setup.eventQueue;
    eventQueue.requestFullScan();

    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 10000 });
    expect(eventQueue.getState()).toBe('full_scan');

    eventQueue.releaseFullScan();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(3), { timeout: 5000 });
    await setup.onClose();
  });

  it('processes post-scan watcher events after a DLQ-held mutex abandons recovery', async () => {
    let eventQueue: EventQueue | undefined;
    let reindexCalls = 0;
    const request = { rebuildEpoch: 2, fingerprint: 'recovery-fingerprint' };
    const reindex = vi.fn<IndexPipeline['reindex']>(async () => {
      reindexCalls += 1;
      if (reindexCalls === 1) {
        eventQueue?.enqueue({ type: 'modified', filePath: 'src/queued.ts', detectedAt: 'now' });
        return { status: 'rebuild_required', request };
      }
      return { status: 'already_running' };
    });
    const pipeline = makePipeline(reindex);
    const processEvents = vi.mocked(pipeline.processEvents);
    const manager = new EventProcessingManager(config, process.cwd(), [], pipeline, async () => '');
    const setup = manager.setup();
    eventQueue = setup.eventQueue;
    eventQueue.requestFullScan();

    await vi.waitFor(() => expect(processEvents).toHaveBeenCalledWith(
      [{ type: 'modified', filePath: 'src/queued.ts', detectedAt: 'now' }],
      expect.any(Function),
      { trackProgress: false },
    ), { timeout: 10000 });

    expect(eventQueue.getPostScanQueueSize()).toBe(0);
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
