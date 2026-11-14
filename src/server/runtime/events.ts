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
  private readonly fullScanPromises = new Set<Promise<void>>();
  private eventQueue?: EventQueue;

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
          this.fullScanPromises.delete(promise);
        });
        this.fullScanPromises.add(promise);
        return Promise.resolve();
      },
    });
    this.eventQueue = eventQueue;
    this.pipeline.setEventQueue(eventQueue);
    const watcher = new FileWatcher({ projectRoot: this.projectRoot, ignorePaths: this.ignorePaths }, eventQueue);
    this.drainTask = this.startDrainLoop(eventQueue);
    return { eventQueue, watcher, onClose: () => this.stop() };
  }

  getPendingDrainCount(): number { return this.pendingDrains; }
  private pendingDrains = 0;

  private async stop() {
    this.abortController.abort();
    await Promise.allSettled([this.drainTask ?? Promise.resolve()]);
    while (this.fullScanPromises.size > 0) await Promise.allSettled([...this.fullScanPromises]);
  }

  private async triggerFullScan(reason: ReindexOptions['reason'] = 'overflow-recovery', retryCount = 3, baseDelayMs = 1000) {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      if (this.abortController.signal.aborted) return;
      try {
        const runFullScan = () => DirectoryScanner.scan(this.projectRoot, this.projectRoot, this.ignorePaths, this.onLog);
        let result = await this.pipeline.reindex(runFullScan, this.loadFileContent, true, reason);
        if ('status' in result && result.status === 'rebuild_required') {
          result = await this.pipeline.reindex(
            runFullScan, this.loadFileContent, true, 'integrity-recovery', result.request,
          );
        }
        if ('status' in result) {
          if (result.status === 'already_running') throw new Error('already_running');
          if (result.status === 'integrity_unknown') {
            this.onLog?.(`[Nexus] Background full scan refused to repair unknown integrity: ${result.reason}`);
            if (reason === 'overflow-recovery') {
              const shouldRetry = attempt < retryCount - 1;
              if (shouldRetry && !this.abortController.signal.aborted) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                try { await sleep(delay, undefined, { signal: this.abortController.signal }); }
                catch { /* AbortError is expected. */ }
              }
              continue;
            }
            return;
          }
          if (result.status === 'rebuild_required') {
            this.onLog?.('[Nexus] Background full scan recovery request expired; storage was not changed.');
            return;
          }
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
    if (reason === 'overflow-recovery' && !this.abortController.signal.aborted) {
      if (this.eventQueue?.getState() === 'full_scan' && this.pipeline.getProgress().status !== 'running') {
        this.eventQueue.releaseFullScan();
      }
      this.eventQueue?.requestFullScan();
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
