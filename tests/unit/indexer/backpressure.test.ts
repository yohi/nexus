import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventQueue } from '../../../src/indexer/event-queue.js';
import type { IndexEvent } from '../../../src/types/index.js';

const makeEvent = (filePath: string): IndexEvent => ({
  type: 'modified',
  filePath,
  contentHash: `hash:${filePath}`,
  detectedAt: new Date('2026-04-07T00:00:00.000Z').toISOString(),
});

describe('EventQueue backpressure state machine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters overflow once the queue reaches the full scan threshold', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 2, concurrency: 1 });

    queue.enqueue(makeEvent('src/a.ts'));
    queue.enqueue(makeEvent('src/b.ts'));
    vi.runAllTimers();

    expect(queue.isOverflowing()).toBe(true);
    expect(queue.getState()).toBe('overflow');
  });

  it('transitions to full_scan after draining overflowed events', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 1, concurrency: 1 });

    queue.enqueue(makeEvent('src/a.ts'));
    queue.enqueue(makeEvent('src/b.ts'));
    vi.runAllTimers();

    await queue.drain(async (event) => event);

    expect(queue.getState()).toBe('full_scan');
    expect(queue.isOverflowing()).toBe(true);
  });

  it('clears queues before and after full scan to avoid death spirals', async () => {
    vi.useFakeTimers();
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 1, concurrency: 1 });

    queue.enqueue(makeEvent('src/a.ts'));
    queue.enqueue(makeEvent('src/b.ts'));
    vi.runAllTimers();

    await queue.drain(async () => undefined);
    expect(queue.getState()).toBe('full_scan');

    expect(queue.enqueue(makeEvent('src/c.ts'))).toBe(false);
    expect(queue.size()).toBe(0);

    queue.markFullScanComplete();

    expect(queue.getState()).toBe('normal');
    expect(queue.isOverflowing()).toBe(false);
    expect(queue.size()).toBe(0);
  });
});
