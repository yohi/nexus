import { setTimeout as sleep } from 'node:timers/promises';
import { EventQueue } from '../../indexer/event-queue.js';
import type { IndexPipeline } from '../../indexer/pipeline.js';
import { FileWatcher } from '../../indexer/watcher.js';
import type { MetricsCollector } from '../../observability/metrics-collector.js';
import type { Config, ReindexOptions } from '../../types/index.js';
import { DirectoryScanner } from './directory-scan.js';
import { emitRuntimeEvent, withQueuedObservation } from '../../observability/runtime-observer.js';
import type { RuntimeObserver } from '../../observability/runtime-observer.js';
import { observeRuntimeWork } from '../../observability/runtime-work.js';

export class EventProcessingManager {
  private abortController = new AbortController();
  private drainTask?: Promise<void>;
  private fullScanPromise?: Promise<void>;

  constructor(private config: Config, private projectRoot: string, private ignorePaths: string[],
    private pipeline: IndexPipeline, private loadFileContent: (path: string) => Promise<string>,
    private onLog?: (msg: string) => void, private metricsCollector?: MetricsCollector,
    private observer?: RuntimeObserver) {}

  setup(): { eventQueue: EventQueue; watcher: FileWatcher; onClose: () => Promise<void> } {
    const eventQueue = new EventQueue({
      debounceMs: this.config.watcher.debounceMs,
      maxQueueSize: this.config.watcher.maxQueueSize,
      fullScanThreshold: this.config.watcher.fullScanThreshold,
      concurrency: 4, metricsHooks: this.metricsCollector, observer: this.observer,
      onFullScanRequired: () => {
        const promise = this.triggerFullScan('overflow-recovery').finally(() => {
          if (this.fullScanPromise === promise) this.fullScanPromise = undefined;
        });
        this.fullScanPromise = promise;
        return Promise.resolve();
      },
    });
    this.pipeline.setEventQueue(eventQueue);
    const watcher = new FileWatcher({ projectRoot: this.projectRoot, ignorePaths: this.ignorePaths }, eventQueue);
    this.drainTask = this.startDrainLoop(eventQueue);
    return { eventQueue, watcher, onClose: () => this.stop() };
  }

  getPendingDrainCount(): number { return this.pendingDrains; }
  private pendingDrains = 0;

  private async stop() {
    this.abortController.abort();
    await Promise.allSettled([this.drainTask ?? Promise.resolve(), this.fullScanPromise ?? Promise.resolve()]);
  }

  private async triggerFullScan(reason: ReindexOptions['reason'] = 'overflow-recovery', retryCount = 3, baseDelayMs = 1000) {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      if (this.abortController.signal.aborted) return;
      try {
        const result = await this.pipeline.reindex(
          () => DirectoryScanner.scan(this.projectRoot, this.projectRoot, this.ignorePaths, this.onLog),
          this.loadFileContent, true, reason,
        );
        if ('status' in result) {
          if (result.status === 'already_running') throw new Error('already_running');
          this.onLog?.('[Nexus] Background full scan incomplete; dead-letter queue entries remain.');
          return;
        }
        if (this.onLog) this.onLog('[Nexus] Background full scan completed successfully.');
        return;
      } catch (error) {
        const isAlreadyRunning = error instanceof Error && error.message === 'already_running';
        const msg = `[Nexus] Background full scan ${isAlreadyRunning ? 'skipped' : 'failed'} (attempt ${attempt + 1}/${retryCount})`;
        console.error(msg, error);
        if (this.onLog) this.onLog(`${msg}: ${String(error)}`);
        const shouldWait = attempt < retryCount - 1;
        if (shouldWait && !this.abortController.signal.aborted) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          try { await sleep(delay, undefined, { signal: this.abortController.signal }); }
          catch { /* AbortError is expected. */ }
        }
      }
    }
  }

  private async startDrainLoop(eventQueue: EventQueue) {
    while (!this.abortController.signal.aborted) {
      try {
        await eventQueue.drain(async (event) => {
          this.pendingDrains += 1;
          this.observeDrain(eventQueue);
          try {
            await withQueuedObservation(event, () => observeRuntimeWork(this.observer, 'drain', async () => {
              if (event.type === 'reindex') await this.triggerFullScan(event.options.reason ?? 'manual');
              else await this.pipeline.processEvents([event], this.loadFileContent, { trackProgress: false });
            }));
          } finally { this.pendingDrains -= 1; this.observeDrain(eventQueue); }
        });
      } catch (error) {
        console.error('[Nexus] Error in event queue drain loop:', error);
        if (this.onLog) this.onLog(`[Nexus] Error in event queue drain loop: ${String(error)}`);
      }
      try { await sleep(500, undefined, { signal: this.abortController.signal }); }
      catch { /* AbortError is expected when the loop should terminate. */ }
    }
  }

  private observeDrain(queue: EventQueue): void {
    emitRuntimeEvent(this.observer, { kind: 'drain_state', pending: this.pendingDrains,
      queued: queue.size(), postScanQueued: queue.getPostScanQueueSize(), dropped: queue.getDroppedEventCount() });
  }
}
