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
      () => fakeWatcher as never,
    );

    await watcher.start();

    for (let index = 0; index < 12_000; index += 1) {
      fakeWatcher.emit('change', `/repo/src/file-${index}.ts`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queue.isOverflowing()).toBe(true);
    expect(queue.size()).toBe(5_001);
    expect(queue.getDroppedEventCount()).toBeGreaterThan(0);
    expect(fakeWatcher.closeCalls).toBe(0);

    const drained = await queue.drain(async (event) => event);

    expect(drained).toHaveLength(5_001);
    expect(queue.size()).toBe(0);
    expect(queue.isOverflowing()).toBe(false);
    expect(fakeWatcher.closeCalls).toBe(0);

    await watcher.stop();

    expect(fakeWatcher.closeCalls).toBe(1);
  }, 15_000);
});
