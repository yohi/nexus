import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { EventQueue } from '../../../src/indexer/event-queue.js';
import { FileWatcher } from '../../../src/indexer/watcher.js';

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe('FileWatcher', () => {
  it('enqueues added events', async () => {
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });
    const fakeWatcher = new FakeWatcher();
    const watcher = new FileWatcher(
      { projectRoot: '/repo', ignorePaths: [] },
      queue,
      () => fakeWatcher as never,
    );

    await watcher.start();
    fakeWatcher.emit('add', '/repo/src/new.ts');

    const events = await queue.drain(async (event) => event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'added',
        filePath: 'src/new.ts',
      }),
    ]);
  });

  it('enqueues modified events', async () => {
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });
    const fakeWatcher = new FakeWatcher();
    const watcher = new FileWatcher(
      { projectRoot: '/repo', ignorePaths: [] },
      queue,
      () => fakeWatcher as never,
    );

    await watcher.start();
    fakeWatcher.emit('change', '/repo/src/existing.ts');

    const events = await queue.drain(async (event) => event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'modified',
        filePath: 'src/existing.ts',
      }),
    ]);
  });

  it('enqueues deleted events', async () => {
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });
    const fakeWatcher = new FakeWatcher();
    const watcher = new FileWatcher(
      { projectRoot: '/repo', ignorePaths: [] },
      queue,
      () => fakeWatcher as never,
    );

    await watcher.start();
    fakeWatcher.emit('unlink', '/repo/src/removed.ts');

    const events = await queue.drain(async (event) => event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'deleted',
        filePath: 'src/removed.ts',
      }),
    ]);
  });

  it('ignores paths matched by ignorePaths', async () => {
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });
    const fakeWatcher = new FakeWatcher();
    const watcher = new FileWatcher(
      { projectRoot: '/repo', ignorePaths: ['node_modules', '.nexus'] },
      queue,
      () => fakeWatcher as never,
    );

    await watcher.start();
    fakeWatcher.emit('add', '/repo/node_modules/pkg/index.js');
    fakeWatcher.emit('change', '/repo/.nexus/cache.db');

    const events = await queue.drain(async (event) => event);

    expect(events).toEqual([]);
  });

  it('does not close the underlying watcher until stop is called', async () => {
    const queue = new EventQueue({ debounceMs: 10, maxQueueSize: 10, fullScanThreshold: 5, concurrency: 1 });
    const fakeWatcher = new FakeWatcher();
    const watcher = new FileWatcher(
      { projectRoot: '/repo', ignorePaths: [] },
      queue,
      () => fakeWatcher as never,
    );

    await watcher.start();

    expect(fakeWatcher.closeCalls).toBe(0);

    await watcher.stop();

    expect(fakeWatcher.closeCalls).toBe(1);
  });
});
