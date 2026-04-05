import { describe, expect, it, vi } from 'vitest';

import type { IndexEvent } from '../../../src/types/index.js';
import { EventQueue } from '../../../src/indexer/event-queue.js';

const makeEvent = (overrides: Partial<IndexEvent> = {}): IndexEvent => ({
  type: overrides.type ?? 'modified',
  filePath: overrides.filePath ?? 'src/index.ts',
  contentHash: overrides.contentHash ?? 'hash-1',
  detectedAt: overrides.detectedAt ?? new Date('2026-04-05T00:00:00.000Z').toISOString(),
});

describe('EventQueue', () => {
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
    vi.useRealTimers();
  });

  it('prioritizes reindex events ahead of watcher events', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 100, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 2 });

    queue.enqueue(makeEvent({ filePath: 'src/index.ts' }));
    queue.enqueueReindex({ reason: 'manual' });
    vi.runAllTimers();

    const processed = await queue.drain(async (event) => event.type);

    expect(processed).toEqual(['reindex', 'modified']);
    vi.useRealTimers();
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
    vi.useRealTimers();
  });

  it('sets overflow when the queue size exceeds the full scan threshold', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 2, concurrency: 1 });

    queue.enqueue(makeEvent({ filePath: 'src/a.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/b.ts' }));
    queue.enqueue(makeEvent({ filePath: 'src/c.ts' }));
    vi.runAllTimers();

    expect(queue.isOverflowing()).toBe(true);
    vi.useRealTimers();
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
    vi.useRealTimers();
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
    vi.useRealTimers();
  });
});
