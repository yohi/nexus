import { type FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import path from 'node:path';
import picomatch from 'picomatch';

import type { FileWatcherOptions, IndexEventType } from '../types/index.js';
import { normalizeIgnorePaths } from '../utils/path-normalization.js';
import type { EventQueue } from './event-queue.js';

type WatcherFactory = (projectRoot: string, ignored: string[]) => FSWatcher;

const defaultWatcherFactory: WatcherFactory = (projectRoot, ignored) => {
  const normalizedRoot = projectRoot.split(path.sep).join('/');
  const patterns = ignored.flatMap((p) => {
    const isNegated = p.startsWith('!');
    const rawPattern = isNegated ? p.slice(1) : p;
    const normalized = normalizeIgnorePaths([rawPattern]);
    return normalized.map((p) => {
      const absolutePath = path.resolve(projectRoot, p).split(path.sep).join('/');
      return isNegated ? `!${absolutePath}` : absolutePath;
    });
  });

  return chokidar.watch(normalizedRoot, {
    ignored: patterns,
    ignoreInitial: true,
  });
};

export class FileWatcher {
  private watcher: FSWatcher | undefined;
  private startPromise: Promise<void> | undefined;
  private isStopped = false;
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
    const patterns = ignored.flatMap((p) => {
      const isNegated = p.startsWith('!');
      const rawPattern = isNegated ? p.slice(1) : p;
      const normalized = normalizeIgnorePaths([rawPattern]);
      return normalized.map((n) => (isNegated ? `!${n}` : n));
    });
    this.isIgnored = picomatch(patterns, { windows: true });
  }

  async start(): Promise<void> {
    if (this.watcher !== undefined) {
      return;
    }

    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.isStopped = false;
    this.startPromise = (async () => {
      await this.asyncBoundary();

      const ignored = [...(this.options.ignorePaths ?? [])];

      return new Promise<void>((resolve, reject) => {
        const watcher = this.createWatcher(this.options.projectRoot, ignored);
        this.watcher = watcher;
        let isReady = false;

        watcher.on('ready', () => {
          if (this.isStopped) {
            void watcher.close().finally(() => {
              this.watcher = undefined;
              this.startPromise = undefined;
              resolve();
            });
            return;
          }

          isReady = true;
          this.startPromise = undefined;
          resolve();
        });

        watcher.on('error', (error: unknown) => {
          if (!isReady) {
            // Initialization failure: cleanup resources
            this.startPromise = undefined;
            this.watcher = undefined;
            void watcher.close().finally(() => {
              reject(error instanceof Error ? error : new Error(String(error)));
            });
            return;
          }

          const hasEmfileCode =
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'EMFILE';

          if (hasEmfileCode) {
            console.error(
              '[Nexus Watcher Error] System limit hit (EMFILE). File watching is suspended.',
              error,
            );
          } else {
            console.error('[Nexus Watcher Error]', error);
          }
        });

        watcher.on('add', (filePath) => {
          this.handleFsEvent('added', filePath);
        });
        watcher.on('change', (filePath) => {
          this.handleFsEvent('modified', filePath);
        });
        watcher.on('unlink', (filePath) => {
          this.handleFsEvent('deleted', filePath);
        });
      });
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.isStopped = true;

    if (this.watcher === undefined) {
      if (this.startPromise) {
        await this.startPromise;
      }
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
