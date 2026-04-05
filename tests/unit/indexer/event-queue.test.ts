import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IndexEvent } from '../../../src/types/index.js';
import { EventQueue } from '../../../src/indexer/event-queue.js';

const makeEvent = (overrides: Partial<IndexEvent> = {}): IndexEvent => ({
  type: overrides.type ?? 'modified',
  filePath: overrides.filePath ?? 'src/index.ts',
  contentHash: overrides.contentHash ?? 'hash-1',
  detectedAt: overrides.detectedAt ?? new Date('2026-04-05T00:00:00.000Z').toISOString(),
});

describe('EventQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('debounces consecutive events for the same file within the debounce window', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 100, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 2 });

    queue.enqueue(makeEvent({ filePath: 'src/index.ts', contentHash: 'hash-1' }));
    vi.advanceTimersByTime(50);
    queue.enqueue(makeEvent({ filePath: 'src/index.ts', contentHash: 'hash-2' }));
    vi.advanceTimersByTime(100);

    const drained = await queue.drain(async (event) => {
      if (event.type === 'reindex') {
        throw new Error('unexpected reindex event');
      }
      return event;
    });

    expect(drained).toHaveLength(1);
    expect(drained[0]?.contentHash).toBe('hash-2');
  });

  it('prioritizes reindex events ahead of watcher events', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 100, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 2 });

    queue.enqueue(makeEvent({ filePath: 'src/index.ts' }));
    queue.enqueueReindex({ reason: 'manual' });
    vi.runAllTimers();

    const processed = await queue.drain(async (event) => event.type);

    expect(processed).toEqual(['reindex', 'modified']);
  });

  it('does not exceed the configured concurrency limit while draining', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 2 });
    const running = { current: 0, peak: 0 };

    queue.enqueue(makeEvent({ filePath: 'src/a.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/b.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/c.ts' }));
    vi.runAllTimers();

    await queue.drain(async () => {
      running.current += 1;
      running.peak = Math.max(running.peak, running.current);
      await Promise.resolve();
      running.current -= 1;
    });

    expect(running.peak).toBeLessThanOrEqual(2);
  });

  it('sets overflow when the queue size exceeds the full scan threshold', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 2, concurrency: 1 });

    queue.enqueue(makeEvent({ filePath: 'src/a.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/b.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/c.ts' }));
    vi.runAllTimers();

    expect(queue.isOverflowing()).toBe(true);
  });

  it('rejects new watcher events while overflowing', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 1, concurrency: 1 });

    queue.enqueue(makeEvent({ filePath: 'src/a.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/b.ts' }));
    vi.runAllTimers();

    const accepted = queue.enqueue(makeEvent({ filePath: 'src/c.ts' }));

    expect(accepted).toBe(false);
    expect(queue.size()).toBe(2);
  });

  it('clears queued events and resets overflow state', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 1, concurrency: 1 });

    queue.enqueue(makeEvent({ filePath: 'src/a.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/b.ts' }));
    vi.runAllTimers();

    queue.clear();

    expect(queue.size()).toBe(0);
    expect(queue.isOverflowing()).toBe(false);
  });

  describe('Event Merging', () => {
    it('cancels added followed by deleted', async () => {
      vi.useFakeTimers();
      const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });

      queue.enqueue(makeEvent({ type: 'added', filePath: 'src/new.ts' }));
      expect(queue.size()).toBe(1);

      queue.enqueue(makeEvent({ type: 'deleted', filePath: 'src/new.ts' }));
      expect(queue.size()).toBe(0);

      vi.runAllTimers();
      const processed = await queue.drain(async (e) => e);
      expect(processed).toHaveLength(0);
    });

    it('merges added followed by modified into added', async () => {
      vi.useFakeTimers();
      const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });

      queue.enqueue(makeEvent({ type: 'added', filePath: 'src/new.ts', contentHash: 'h1' }));
      queue.enqueue(makeEvent({ type: 'modified', filePath: 'src/new.ts', contentHash: 'h2' }));

      vi.runAllTimers();
      const processed = await queue.drain(async (e) => e);
      expect(processed).toHaveLength(1);
      expect(processed[0]?.type).toBe('added');
      expect((processed[0] as IndexEvent).contentHash).toBe('h2');
    });

    it('merges modified followed by deleted into deleted', async () => {
      vi.useFakeTimers();
      const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });

      queue.enqueue(makeEvent({ type: 'modified', filePath: 'src/existing.ts' }));
      queue.enqueue(makeEvent({ type: 'deleted', filePath: 'src/existing.ts' }));

      vi.runAllTimers();
      const processed = await queue.drain(async (e) => e);
      expect(processed).toHaveLength(1);
      expect(processed[0]?.type).toBe('deleted');
    });

    it('merges deleted followed by added into modified', async () => {
      vi.useFakeTimers();
      const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });

      queue.enqueue(makeEvent({ type: 'deleted', filePath: 'src/existing.ts' }));
      queue.enqueue(makeEvent({ type: 'added', filePath: 'src/existing.ts' }));

      vi.runAllTimers();
      const processed = await queue.drain(async (e) => e);
      expect(processed).toHaveLength(1);
      expect(processed[0]?.type).toBe('modified');
    });
  });

  it('exposes droppedEventCount via getter', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 0, maxQueueSize: 1, fullScanThreshold: 10, concurrency: 1 });

    // Fill the queue (watcherQueue)
    queue.enqueue(makeEvent({ filePath: 'src/a.ts' }));
    vi.runAllTimers();
    expect(queue.size()).toBe(1);

    // This event should be dropped when flushed
    queue.enqueue(makeEvent({ filePath: 'src/b.ts' }));
    vi.runAllTimers();

    expect(queue.getDroppedEventCount()).toBe(1);
  });

  describe('drain with error handling', () => {
    it('re-enqueues only failed events when handler rejects', async () => {
      vi.useFakeTimers();
      const queue = new EventQueue({ debounceMs: 0, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 2 });

      queue.enqueue(makeEvent({ filePath: 'src/success.ts' }));
      queue.enqueue(makeEvent({ filePath: 'src/fail.ts' }));
      vi.runAllTimers();

      let failCalled = 0;
      const handler = async (event: any) => {
        if (event.filePath === 'src/fail.ts') {
          failCalled += 1;
          throw new Error('processing failed');
        }
        return event.filePath;
      };

      // First drain attempt
      await expect(queue.drain(handler)).rejects.toThrow('processing failed');

      expect(failCalled).toBe(1);
      expect(queue.size()).toBe(1); // src/fail.ts should be back in queue

      // Second drain attempt
      const results = await queue.drain(async (event: any) => event.filePath);
      expect(results).toEqual(['src/fail.ts']);
      expect(queue.size()).toBe(0);
    });

    it('waits for all in-flight tasks even if some fail', async () => {
      vi.useFakeTimers();
      const queue = new EventQueue({ debounceMs: 0, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 2 });

      queue.enqueue(makeEvent({ filePath: 'src/slow-success.ts' }));
      queue.enqueue(makeEvent({ filePath: 'src/fast-fail.ts' }));
      vi.runAllTimers();

      const order: string[] = [];
      const handler = async (event: any) => {
        if (event.filePath === 'src/slow-success.ts') {
          await new Promise((resolve) => setTimeout(resolve, 100));
          order.push('slow-success');
          return 'slow';
        }
        if (event.filePath === 'src/fast-fail.ts') {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('fast-fail');
          throw new Error('fast fail');
        }
      };

      const drainPromise = queue.drain(handler);

      // Advance timers repeatedly to resolve the internal promises
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(100);

      await expect(drainPromise).rejects.toThrow('fast fail');
      expect(order).toEqual(['fast-fail', 'slow-success']);
      expect(queue.size()).toBe(1); // fast-fail.ts should be re-enqueued
    });
  });
});
