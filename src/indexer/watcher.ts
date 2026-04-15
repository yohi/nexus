import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import picomatch from 'picomatch';

import type { FileWatcherOptions, IndexEventType } from '../types/index.js';
import type { EventQueue } from './event-queue.js';

type WatcherFactory = (projectRoot: string, ignored: string[]) => FSWatcher;

const normalizePatterns = (ignorePaths: string[]) =>
  ignorePaths.flatMap((p) => {
    const normalized = p.replaceAll('\\\\', '/').replace(/^\.\/+|\/+$/g, '');
    return [`**/${normalized}`, `**/${normalized}/**`];
  });

const defaultWatcherFactory: WatcherFactory = (projectRoot, ignored) => {
  const patterns = normalizePatterns(ignored);
  const isIgnored = picomatch(patterns, { windows: true });

  return chokidar.watch(projectRoot, {
    ignored: (path: string) => {
      const relativePath = path.startsWith(projectRoot)
        ? path.slice(projectRoot.length).replace(/^[\\\\/]/, '')
        : path;
      const normalizedPath = relativePath.split(/[\\\\/]/).join('/');
      return isIgnored(normalizedPath);
    },
    ignoreInitial: true,
  });
};

export class FileWatcher {
  private watcher: FSWatcher | undefined;
  private isIgnored: (path: string) => boolean = () => false;

  /**
   * Separates filesystem event callbacks from the initialization flow.
   * Ensures that the watcher start process doesn't block and helps isolate
   * asynchronous operations during testing and event loop management.
   */
  private readonly asyncBoundary = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  constructor(
    private readonly options: FileWatcherOptions,
    private readonly eventQueue: EventQueue,
    private readonly createWatcher: WatcherFactory = defaultWatcherFactory,
  ) {
    const ignored = [...(this.options.ignorePaths ?? [])];
    const patterns = normalizePatterns(ignored);
    this.isIgnored = picomatch(patterns, { windows: true });
  }

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
    const detectedAt = new Date().toISOString();
    const accepted = this.eventQueue.enqueue({
      type,
      filePath,
      detectedAt,
    });

    if (!accepted) {
      console.warn('Event queue rejected event (overflow):', {
        type,
        filePath,
        detectedAt,
      });
      void this.options.onFullScanRequired?.().catch((err) => {
        console.error('onFullScanRequired failed:', err);
      });
    }
  }

  private shouldIgnore(absolutePath: string): boolean {
    const relativePath = path.relative(this.options.projectRoot, absolutePath);
    const normalizedPath = relativePath.split(path.sep).join('/');

    return this.isIgnored(normalizedPath);
  }
}
