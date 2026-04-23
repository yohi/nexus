import { type FSWatcher } from "chokidar";
import chokidar from "chokidar";
import path from "node:path";
import picomatch from "picomatch";

import type { FileWatcherOptions, IndexEventType } from "../types/index.js";
import { normalizeIgnorePaths } from "../utils/path-normalization.js";
import type { EventQueue } from "./event-queue.js";

type WatcherFactory = (projectRoot: string, ignored: string[]) => FSWatcher;

const expandIgnoredPatterns = (ignored: string[]): string[] => {
  const patterns: string[] = [];
  for (const entry of ignored) {
    const isNegated = entry.startsWith("!");
    const rawPattern = isNegated ? entry.slice(1) : entry;
    for (const normalizedPath of normalizeIgnorePaths([rawPattern])) {
      patterns.push(isNegated ? `!${normalizedPath}` : normalizedPath);
    }
  }
  return patterns;
};

const defaultWatcherFactory: WatcherFactory = (projectRoot, ignored) => {
  return chokidar.watch(".", {
    cwd: projectRoot,
    ignored: expandIgnoredPatterns(ignored),
    ignoreInitial: true,
  });
};

export class FileWatcher {
  private watcher: FSWatcher | undefined;
  private startPromise: Promise<void> | undefined;
  private settleStartPromise: (() => void) | undefined;
  private isStopped = false;
  private isStarting = false;
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
    const ignored = this.options.ignorePaths ?? [];
    this.isIgnored = picomatch(expandIgnoredPatterns(ignored), {
      windows: true,
    });
  }

  async start(): Promise<void> {
    if (this.watcher !== undefined) {
      return;
    }

    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.isStopped = false;
    this.isStarting = true;
    this.startPromise = (async () => {
      await this.asyncBoundary();

      const ignored = [...(this.options.ignorePaths ?? [])];

      return new Promise<void>((resolve, reject) => {
        this.settleStartPromise = () => {
          this.settleStartPromise = undefined;
          this.startPromise = undefined;
          this.isStarting = false;
          resolve();
        };

        const watcher = this.createWatcher(this.options.projectRoot, ignored);
        this.watcher = watcher;
        let isReady = false;

        watcher.on("ready", () => {
          if (this.isStopped) {
            void watcher.close().finally(() => {
              if (this.watcher === watcher) {
                this.watcher = undefined;
              }
              this.settleStartPromise?.();
            });
            return;
          }

          isReady = true;
          this.settleStartPromise?.();
        });

        watcher.on("error", (error: unknown) => {
          const isEnospc =
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOSPC";

          if (!isReady) {
            // Initialization failure: cleanup resources
            if (isEnospc) {
              const msg = [
                "❌ Nexus Watcher failed to start: System limit for file watchers reached (ENOSPC).",
                '👉 Solution: Increase inotify limits or add more paths to "watcher.ignorePaths" in your config.',
                "   To increase limits, run: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p",
              ].join("\n");
              console.error(msg);
            }

            const wrappedError =
              error instanceof Error ? error : new Error(String(error));
            void watcher.close().finally(() => {
              if (this.watcher === watcher) {
                this.watcher = undefined;
              }
              this.settleStartPromise = undefined;
              this.startPromise = undefined;
              this.isStarting = false;
              reject(wrappedError);
            });
            return;
          }

          const hasEmfileCode =
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EMFILE";

          if (isEnospc) {
            console.error(
              "[Nexus Watcher Error] System limit hit (ENOSPC). File watching may be incomplete.",
              error,
            );
          } else if (hasEmfileCode) {
            console.error(
              "[Nexus Watcher Error] System limit hit (EMFILE). File watching is suspended.",
              error,
            );
          } else {
            console.error("[Nexus Watcher Error]", error);
          }
        });

        watcher.on("add", (filePath) => {
          this.handleFsEvent(
            "added",
            path.resolve(this.options.projectRoot, filePath),
          );
        });
        watcher.on("change", (filePath) => {
          this.handleFsEvent(
            "modified",
            path.resolve(this.options.projectRoot, filePath),
          );
        });
        watcher.on("unlink", (filePath) => {
          this.handleFsEvent(
            "deleted",
            path.resolve(this.options.projectRoot, filePath),
          );
        });
      });
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.isStopped = true;

    if (this.isStarting) {
      // If we are still in the process of starting, let the start handle its own cleanup
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch {
          // Ignore error from start as we are stopping
        }
      }
      return;
    }

    if (this.watcher === undefined) {
      this.settleStartPromise?.();
      if (this.startPromise) {
        await this.startPromise;
      }
      return;
    }

    const currentWatcher = this.watcher;
    this.watcher = undefined;
    this.settleStartPromise?.();
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
      console.warn("Event queue rejected event (overflow):", {
        type,
        filePath,
        detectedAt,
      });
      void this.options.onFullScanRequired?.().catch((err) => {
        console.error("onFullScanRequired failed:", err);
      });
    }
  }

  private shouldIgnore(absolutePath: string): boolean {
    const relativePath = path.relative(this.options.projectRoot, absolutePath);
    const normalizedPath = relativePath.split(path.sep).join("/");

    return this.isIgnored(normalizedPath);
  }
}
