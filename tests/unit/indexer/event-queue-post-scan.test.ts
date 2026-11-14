import { describe, expect, it } from 'vitest';

import { EventQueue } from '../../../src/indexer/event-queue.js';

const makeEvent = (filePath: string) => ({
  type: 'added' as const,
  filePath,
  detectedAt: new Date().toISOString(),
});

const makeQueue = (overrides: { maxQueueSize?: number; fullScanThreshold?: number; onFullScanRequired?: () => Promise<void> } = {}) =>
  new EventQueue({
    debounceMs: 0,
    maxQueueSize: overrides.maxQueueSize ?? 100,
    fullScanThreshold: overrides.fullScanThreshold ?? 50,
    concurrency: 1,
    onFullScanRequired: overrides.onFullScanRequired,
  });

describe('EventQueue post-scan queue', () => {
  it('bounds post-scan events and records overflow drops', () => {
    const queue = makeQueue({ maxQueueSize: 2, fullScanThreshold: 1 });
    queue.enterPostScanMode();

    expect(queue.enqueue(makeEvent('a.ts'))).toBe(true);
    expect(queue.enqueue(makeEvent('b.ts'))).toBe(true);
    expect(queue.enqueue(makeEvent('c.ts'))).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(2);
    expect(queue.getDroppedEventCount()).toBe(1);
    expect(queue.getState()).toBe('normal');
    expect(queue.size()).toBe(0);
  });

  it('applies the post-scan capacity bound to reindex events', () => {
    const queue = makeQueue({ maxQueueSize: 2, fullScanThreshold: 1 });
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));

    expect(queue.enqueueReindex({ reason: 'manual' })).toBe(false);
    expect(queue.getDroppedEventCount()).toBe(1);
  });

  it('counts queued reindex events when accepting post-scan watcher events', () => {
    const queue = makeQueue({ maxQueueSize: 2, fullScanThreshold: 1 });
    queue.enterPostScanMode();

    expect(queue.enqueueReindex({ reason: 'manual' })).toBe(true);
    expect(queue.enqueue(makeEvent('a.ts'))).toBe(true);
    expect(queue.enqueue(makeEvent('b.ts'))).toBe(false);
    expect(queue.getDroppedEventCount()).toBe(1);
  });

  it('requests a full scan after draining a post-scan queue that overflowed', async () => {
    let fullScanTriggered = false;
    const queue = makeQueue({
      maxQueueSize: 2,
      fullScanThreshold: 1,
      onFullScanRequired: () => {
        fullScanTriggered = true;
        return Promise.resolve();
      },
    });
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));
    expect(queue.enqueue(makeEvent('c.ts'))).toBe(false);

    expect(queue.drainPostScanQueue()).toBe(2);
    await queue.drain(() => Promise.resolve(undefined));

    expect(fullScanTriggered).toBe(true);
    expect(queue.getState()).toBe('full_scan');
  });

  it('moves buffered events into the normal watcher queue when drained', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));

    expect(queue.drainPostScanQueue()).toBe(2);
    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(2);
    expect(queue.drainPostScanQueue()).toBe(0);
  });

  it('drains post-scan events and requests another scan when buffered events overflow', async () => {
    let fullScanTriggered = false;
    const queue = makeQueue({
      maxQueueSize: 2,
      fullScanThreshold: 1,
      onFullScanRequired: () => {
        fullScanTriggered = true;
        return Promise.resolve();
      },
    });

    queue.enterPostScanMode();
    queue.enqueue(makeEvent('post-1.ts'));
    queue.enqueue(makeEvent('post-2.ts'));
    expect(queue.getPostScanQueueSize()).toBe(2);

    queue.markFullScanComplete();
    expect(queue.getPostScanQueueSize()).toBe(2);
    expect(queue.isPostScanActive()).toBe(true);

    queue.drainPostScanQueue();
    queue.enqueue(makeEvent('normal-1.ts'));
    queue.enqueue(makeEvent('normal-2.ts'));
    queue.enqueue(makeEvent('overflow.ts'));
    await queue.drain(() => Promise.resolve(undefined));

    expect(fullScanTriggered).toBe(true);
    expect(queue.getState()).toBe('full_scan');

    queue.enterPostScanMode();
    queue.enqueue(makeEvent('post-4.ts'));
    queue.markFullScanComplete();
    expect(queue.getState()).toBe('overflow');
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(1);
    await expect(queue.drain(async (event) => event)).resolves.toMatchObject([
      { type: 'added', filePath: 'post-4.ts' },
    ]);
  });

  it('keeps post-scan mode active when transferring events fails', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));

    const internals = queue as unknown as {
      watcherQueue: { length: number; push: (...events: unknown[]) => number };
    };
    internals.watcherQueue = {
      length: 0,
      push: () => {
        throw new Error('transfer failed');
      },
    };

    expect(() => queue.drainPostScanQueue()).toThrow('transfer failed');
    expect(queue.isPostScanActive()).toBe(true);
    expect(queue.getPostScanQueueSize()).toBe(1);
  });

  it('forwards post-scan events without passing the whole queue to push', () => {
    const eventCount = 2_000;
    const queue = makeQueue({ maxQueueSize: eventCount, fullScanThreshold: eventCount });
    queue.enterPostScanMode();
    for (let index = 0; index < eventCount; index += 1) {
      expect(queue.enqueue(makeEvent(`large-${index}.ts`))).toBe(true);
    }

    class GuardedWatcherQueue extends Array<ReturnType<typeof makeEvent>> {
      override push(...events: ReturnType<typeof makeEvent>[]): number {
        if (events.length > 64) {
          throw new Error('transfer batch too large');
        }
        return super.push(...events);
      }
    }

    const internals = queue as unknown as { watcherQueue: GuardedWatcherQueue };
    internals.watcherQueue = new GuardedWatcherQueue();

    expect(queue.drainPostScanQueue()).toBe(eventCount);
    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(eventCount);
  });

  it('aborts post-scan mode without forwarding buffered events', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.abortPostScanMode();

    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(0);
  });
});
