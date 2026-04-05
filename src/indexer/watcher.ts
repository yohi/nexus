import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';

import type { FileWatcherOptions, IndexEventType } from '../types/index.js';
import type { EventQueue } from './event-queue.js';

type WatcherFactory = (projectRoot: string, ignored: string[]) => FSWatcher;

const defaultWatcherFactory: WatcherFactory = (projectRoot, ignored) =>
  chokidar.watch(projectRoot, {
    ignored,
    ignoreInitial: true,
  });

export class FileWatcher {
  private watcher: FSWatcher | undefined;

  private readonly asyncBoundary = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  constructor(
    private readonly options: FileWatcherOptions,
    private readonly eventQueue: EventQueue,
    private readonly createWatcher: WatcherFactory = defaultWatcherFactory,
  ) {}

  async start(): Promise<void> {
    await this.asyncBoundary();
    if (this.watcher !== undefined) {
      return;
    }

    const ignored = [...(this.options.ignorePaths ?? [])];
    this.watcher = this.createWatcher(this.options.projectRoot, ignored);

    this.watcher.on('add', (filePath) => {
      this.handleFsEvent('added', filePath);
    });
    this.watcher.on('change', (filePath) => {
      this.handleFsEvent('modified', filePath);
    });
    this.watcher.on('unlink', (filePath) => {
      this.handleFsEvent('deleted', filePath);
    });
  }

  async stop(): Promise<void> {
    if (this.watcher === undefined) {
      return;
    }

    const currentWatcher = this.watcher;
    this.watcher = undefined;
    await currentWatcher.close();
  }

  private handleFsEvent(type: IndexEventType, absolutePath: string): void {
    if (this.shouldIgnore(absolutePath)) {
      return;
    }

    const filePath = path.relative(this.options.projectRoot, absolutePath);
    this.eventQueue.enqueue({
      type,
      filePath,
      detectedAt: new Date().toISOString(),
    });
  }

  private shouldIgnore(absolutePath: string): boolean {
    return (this.options.ignorePaths ?? []).some((ignorePath) => absolutePath.includes(ignorePath));
  }
}
