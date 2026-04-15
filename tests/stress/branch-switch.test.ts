import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventQueue } from '../../src/indexer/event-queue.js';
import { FileWatcher } from '../../src/indexer/watcher.js';

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe('stress: branch switch watcher load', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the watcher alive when a branch switch floods the queue with events', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const queue = new EventQueue({
      debounceMs: 0,
      maxQueueSize: 10_000,
      fullScanThreshold: 5_000,
      concurrency: 32,
    });
    const fakeWatcher = new FakeWatcher();
    const watcher = new FileWatcher(
      { projectRoot: '/repo', ignorePaths: ['.nexus', 'node_modules'] },
      queue,
      () => {
        setImmediate(() => fakeWatcher.emit('ready'));
        return fakeWatcher as never;
      },
    );

    await watcher.start();

    try {
      for (let index = 0; index < 12_000; index += 1) {
        fakeWatcher.emit('change', `/repo/src/file-${index}.ts`);
      }

      // Wait for the queue to process enough events to overflow
      await vi.waitFor(() => {
        if (!queue.isOverflowing()) {
          throw new Error('Queue has not overflowed yet');
        }
      });

      const actualSize = queue.size();
      expect(queue.isOverflowing()).toBe(true);
      expect(actualSize).toBe(5_000);
      expect(queue.getDroppedEventCount()).toBeGreaterThan(0);
      expect(fakeWatcher.closeCalls).toBe(0);

      const drained = await queue.drain(async (event) => event);

      expect(drained).toHaveLength(5_000);
      expect(queue.size()).toBe(0);

      // drain transitions overflow → full_scan; call markFullScanComplete to reset
      queue.markFullScanComplete();
      expect(queue.isOverflowing()).toBe(false);
      expect(fakeWatcher.closeCalls).toBe(0);
    } finally {
      await watcher.stop();
    }

    expect(fakeWatcher.closeCalls).toBe(1);
  }, 30_000);
});
