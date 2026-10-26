import { inspect } from 'node:util';

import pLimit from 'p-limit';

import type { IndexEvent, ReindexOptions, ReindexQueueEvent } from '../types/index.js';
import type { MetricsHooks } from '../observability/types.js';
import type { RuntimeObserver } from '../observability/runtime-observer.js';
import { emitRuntimeEvent, markRuntimeMutation, rememberQueuedObservation } from '../observability/runtime-observer.js';

export interface EventQueueOptions {
  observer?: RuntimeObserver;
  name?: string;
  debounceMs: number;
  maxQueueSize: number;
  fullScanThreshold: number;
  concurrency: number;
  onFullScanRequired?: () => Promise<void>;
  metricsHooks?: Pick<MetricsHooks, 'onQueueSnapshot'>;
}

export type QueueEvent = IndexEvent | ReindexQueueEvent;
export type BackpressureState = 'normal' | 'overflow' | 'full_scan';

export class EventQueue {
  private readonly debouncedEvents = new Map<string, IndexEvent>();

  private readonly watcherQueue: IndexEvent[] = [];

  private readonly reindexQueue: ReindexQueueEvent[] = [];

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private state: BackpressureState = 'normal';

  private droppedEventCount = 0;

  private readonly postScanQueue: IndexEvent[] = [];

  private postScanActive = false;

  private postScanOverflowed = false;

  constructor(private readonly options: EventQueueOptions) {
    if (this.options.fullScanThreshold > this.options.maxQueueSize) {
      throw new Error('fullScanThreshold must be less than or equal to maxQueueSize');
    }
  }

  getDroppedEventCount(): number {
    return this.droppedEventCount;
  }

  getState(): BackpressureState {
    return this.state;
  }

  enqueue(event: IndexEvent): boolean {
    if (this.options.observer !== undefined) rememberQueuedObservation(event);
    if (this.postScanActive) {
      if (this.postScanQueue.length + this.size() >= this.options.maxQueueSize) {
        // Keep the post-scan buffer bounded. The dropped event is recovered by
        // the full-scan path once the accepted post-scan events are drained.
        this.postScanOverflowed = true;
        return this.recordDroppedEvent();
      }
      this.postScanQueue.push(event);
      this.safeNotifyMetrics();
      return true;
    }

    if (this.state !== 'normal') {
      return this.recordDroppedEvent();
    }

    const existingEvent = this.debouncedEvents.get(event.filePath);
    let mergedEvent: IndexEvent | null = event;

    if (existingEvent) {
      if (existingEvent.type === 'added') {
        if (event.type === 'deleted') {
          // added -> deleted = cancel
          mergedEvent = null;
        } else if (event.type === 'modified') {
          // added -> modified = added
          mergedEvent = { ...event, type: 'added' };
        }
      } else if (existingEvent.type === 'modified') {
        if (event.type === 'deleted') {
          // modified -> deleted = deleted
          mergedEvent = { ...event, type: 'deleted' };
        }
      } else if (existingEvent.type === 'deleted') {
        if (event.type === 'added' || event.type === 'modified') {
          // deleted -> added/modified = modified
          mergedEvent = { ...event, type: 'modified' };
        }
      }
    }

    let sizeDelta = 0;
    if (existingEvent && !mergedEvent) {
      sizeDelta = -1;
    } else if (!existingEvent && mergedEvent) {
      sizeDelta = 1;
    }

    const nextSize = this.size() + sizeDelta;
    if (nextSize > this.options.maxQueueSize) {
      this.enterOverflow();
      return this.recordDroppedEvent();
    }

    const existingTimer = this.timers.get(event.filePath);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.timers.delete(event.filePath);
    }

    if (mergedEvent) {
      if (this.options.observer !== undefined) rememberQueuedObservation(mergedEvent);
      this.debouncedEvents.set(event.filePath, mergedEvent);
      const timer = setTimeout(() => {
        this.flushDebouncedEvent(event.filePath);
      }, this.options.debounceMs);
      this.timers.set(event.filePath, timer);
    } else {
      this.debouncedEvents.delete(event.filePath);
    }

    if (this.size() >= this.options.fullScanThreshold) {
      this.enterOverflow();
    }

    this.safeNotifyMetrics();

    return true;
  }

  enqueueReindex(options: ReindexOptions): boolean {
    if (this.postScanActive && this.postScanQueue.length + this.size() >= this.options.maxQueueSize) {
      this.postScanOverflowed = true;
      return this.recordDroppedEvent();
    }

    if (this.state !== 'normal') {
      return this.recordDroppedEvent();
    }

    if (this.size() >= this.options.maxQueueSize) {
      this.enterOverflow();
      return this.recordDroppedEvent();
    }

    const event: ReindexQueueEvent = {
      type: 'reindex',
      priority: 'high',
      options,
      detectedAt: new Date().toISOString(),
    };
    if (this.options.observer !== undefined) rememberQueuedObservation(event);
    this.reindexQueue.push(event);

    if (this.size() >= this.options.fullScanThreshold) {
      this.enterOverflow();
    }

    this.safeNotifyMetrics();

    return true;
  }

  async drain<T>(handler: (event: QueueEvent) => Promise<T>): Promise<T[]> {
    try {
      this.flushAllDebounced();

      const limit = pLimit(this.options.concurrency);
      const results: T[] = [];
      let firstError: unknown;
      let hasError = false;

      // Phase 1: Reindex events
      if (this.reindexQueue.length > 0) {
        const events = [...this.reindexQueue];
        this.reindexQueue.length = 0;
        const settled = await Promise.allSettled(
          events.map((event) =>
            limit(async () => {
              return handler(event);
            })
          )
        );

        for (let i = 0; i < settled.length; i += 1) {
          const res = settled[i];
          const event = events[i];
          if (res === undefined || event === undefined) {
            continue;
          }
          if (res.status === 'fulfilled') {
            results.push(res.value);
          } else {
            if (this.size() >= this.options.maxQueueSize) {
              this.enterOverflow();
              this.droppedEventCount += 1;
            } else {
              this.reindexQueue.push(event);
              if (this.size() >= this.options.fullScanThreshold) {
                this.enterOverflow();
              }
            }
            if (!hasError) {
              firstError = res.reason;
              hasError = true;
            }
          }
        }
      }

      // Phase 2: Watcher events
      if (this.watcherQueue.length > 0) {
        const events = [...this.watcherQueue];
        this.watcherQueue.length = 0;
        const settled = await Promise.allSettled(
          events.map((event) =>
            limit(async () => {
              return handler(event);
            })
          )
        );

        for (let i = 0; i < settled.length; i += 1) {
          const res = settled[i];
          const event = events[i];
          if (res === undefined || event === undefined) {
            continue;
          }
          if (res.status === 'fulfilled') {
            results.push(res.value);
          } else {
            if (typeof res.reason === 'object' && res.reason !== null && Reflect.get(res.reason, 'code') === 'ENOENT') {
              continue;
            }
            if (this.size() >= this.options.maxQueueSize) {
              this.enterOverflow();
              this.droppedEventCount += 1;
            } else {
              this.watcherQueue.push(event);
              if (this.size() >= this.options.fullScanThreshold) {
                this.enterOverflow();
              }
            }
            if (!hasError) {
              firstError = res.reason;
              hasError = true;
            }
          }
        }
      }

      if (this.state === 'overflow' && this.watcherQueue.length === 0 && this.reindexQueue.length === 0) {
        this.flushTimers();
        this.debouncedEvents.clear();
        this.state = 'full_scan';
        await this.options.onFullScanRequired?.();
      }

      if (hasError) {
        if (firstError instanceof Error) {
          throw firstError;
        }
        let message: string;
        try {
          const stringified = typeof firstError === 'string' ? firstError : JSON.stringify(firstError);
          if (typeof stringified !== 'string') {
            throw new Error();
          }
          message = stringified;
        } catch {
          message = inspect(firstError, { depth: null });
        }
        throw new Error(message);
      }

      return results;
    } finally {
      this.safeNotifyMetrics();
    }
  }

  clear(): void {
    this.resetInternalState();
    this.safeNotifyMetrics();
  }

  markFullScanComplete(): void {
    if (this.state !== 'full_scan') {
      return;
    }

    this.flushTimers();
    this.debouncedEvents.clear();
    this.watcherQueue.length = 0;
    this.reindexQueue.length = 0;
    this.state = 'normal';
    this.safeNotifyMetrics();
  }

  enterPostScanMode(): void {
    this.postScanActive = true;
    this.observeQueueState();
  }

  drainPostScanQueue(): number {
    if (!this.postScanActive) {
      return 0;
    }

    const drained = this.postScanQueue.length;
    let forwarded = 0;
    try {
      for (const event of this.postScanQueue) {
        this.watcherQueue.push(event);
        forwarded += 1;
      }
    } catch (error) {
      // Retain only events that were not forwarded so a later drain can retry
      // without duplicating events that already reached the watcher queue.
      this.postScanQueue.splice(0, forwarded);
      this.safeNotifyMetrics();
      throw error;
    }

    this.postScanQueue.length = 0;
    if (this.postScanOverflowed) {
      this.enterOverflow();
      this.postScanOverflowed = false;
    }
    this.postScanActive = false;
    this.safeNotifyMetrics();
    return drained;
  }

  abortPostScanMode(): void {
    this.postScanActive = false;
    this.postScanOverflowed = false;
    this.postScanQueue.length = 0;
    this.safeNotifyMetrics();
  }

  getPostScanQueueSize(): number {
    return this.postScanQueue.length;
  }

  isPostScanActive(): boolean {
    return this.postScanActive;
  }

  private resetInternalState(): void {
    this.flushTimers();
    this.debouncedEvents.clear();
    this.watcherQueue.length = 0;
    this.reindexQueue.length = 0;
    this.postScanQueue.length = 0;
    this.postScanActive = false;
    this.postScanOverflowed = false;
    this.state = 'normal';
  }

  /**
   * Returns the total number of events currently in the queue,
   * including pending debounced events.
   */
  size(): number {
    return this.watcherQueue.length + this.reindexQueue.length + this.debouncedEvents.size;
  }

  isOverflowing(): boolean {
    return this.state !== 'normal';
  }

  private recordDroppedEvent(): false {
    this.droppedEventCount += 1;
    this.safeNotifyMetrics();
    return false;
  }

  private safeNotifyMetrics(): void {
    this.observeQueueState();
    const { metricsHooks } = this.options;
    if (!metricsHooks) return;
    try {
      metricsHooks.onQueueSnapshot(
        this.size(),
        this.state,
        this.droppedEventCount,
        this.options.name,
      );
    } catch (err) {
      console.warn('[Nexus EventQueue] Metrics hook failed:', err);
    }
  }

  private lastObservationSnapshot: string | undefined;

  private observeQueueState(): void {
    const observer = this.options.observer;
    if (observer === undefined) return;
    const snapshot = { queued: this.size(), postScanQueued: this.postScanQueue.length,
      dropped: this.droppedEventCount, postScanActive: this.postScanActive, state: this.state };
    const identity = JSON.stringify(snapshot);
    if (identity === this.lastObservationSnapshot) return;
    this.lastObservationSnapshot = identity;
    markRuntimeMutation(observer);
    emitRuntimeEvent(observer, { kind: 'queue_state', ...snapshot });
  }

  private flushDebouncedEvent(filePath: string): void {
    const event = this.debouncedEvents.get(filePath);
    if (event === undefined) {
      return;
    }

    const timer = this.timers.get(filePath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(filePath);
    }

    this.debouncedEvents.delete(filePath);

    if (this.size() < this.options.maxQueueSize) {
      this.watcherQueue.push(event);
    } else {
      this.droppedEventCount += 1;
      console.warn('Event queue at capacity, dropping event:', {
        filePath,
        type: event.type,
        currentQueueSize: this.size(),
        totalDropped: this.droppedEventCount,
      });
    }

    if (this.size() >= this.options.fullScanThreshold) {
      this.enterOverflow();
    }

    this.safeNotifyMetrics();
  }

  private flushAllDebounced(): void {
    const filePaths = Array.from(this.debouncedEvents.keys());
    for (const filePath of filePaths) {
      this.flushDebouncedEvent(filePath);
    }
    this.flushTimers();
  }

  private flushTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private enterOverflow(): void {
    if (this.state !== 'normal') {
      return;
    }

    this.state = 'overflow';
    this.safeNotifyMetrics();
  }
}
