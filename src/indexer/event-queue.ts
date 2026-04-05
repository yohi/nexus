import pLimit from 'p-limit';

import type { IndexEvent, ReindexOptions, ReindexQueueEvent } from '../types/index.js';

export interface EventQueueOptions {
  debounceMs: number;
  maxQueueSize: number;
  fullScanThreshold: number;
  concurrency: number;
}

export type QueueEvent = IndexEvent | ReindexQueueEvent;

export class EventQueue {
  private readonly debouncedEvents = new Map<string, IndexEvent>();

  private readonly watcherQueue: IndexEvent[] = [];

  private readonly reindexQueue: ReindexQueueEvent[] = [];

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private overflow = false;

  private droppedEventCount = 0;

  constructor(private readonly options: EventQueueOptions) {}

  getDroppedEventCount(): number {
    return this.droppedEventCount;
  }

  enqueue(event: IndexEvent): boolean {
    if (this.overflow) {
      return false;
    }

    const existingEvent = this.debouncedEvents.get(event.filePath);
    const existingTimer = this.timers.get(event.filePath);

    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      this.timers.delete(event.filePath);
    }

    let mergedEvent: IndexEvent | null = event;

    if (existingEvent) {
      if (existingEvent.type === 'added') {
        if (event.type === 'deleted') {
          // added -> deleted = cancel
          this.debouncedEvents.delete(event.filePath);
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

    if (mergedEvent) {
      this.debouncedEvents.set(event.filePath, mergedEvent);
      const timer = setTimeout(() => {
        this.flushDebouncedEvent(event.filePath);
      }, this.options.debounceMs);
      this.timers.set(event.filePath, timer);
    }

    return true;
  }

  enqueueReindex(options: ReindexOptions): void {
    this.reindexQueue.push({
      type: 'reindex',
      priority: 'high',
      options,
      detectedAt: new Date().toISOString(),
    });
  }

  async drain<T>(handler: (event: QueueEvent) => Promise<T>): Promise<T[]> {
    this.flushAllDebounced();

    const limit = pLimit(this.options.concurrency);
    const results: T[] = [];

    // Phase 1: Reindex events (sequential phase)
    if (this.reindexQueue.length > 0) {
      const events = [...this.reindexQueue];
      this.reindexQueue.length = 0;
      const completed = new Set<QueueEvent>();
      try {
        const phaseResults = await Promise.all(
          events.map((event) =>
            limit(async () => {
              const result = await handler(event);
              completed.add(event);
              return result;
            })
          )
        );
        results.push(...phaseResults);
      } catch (error) {
        const uncompleted = events.filter((e) => !completed.has(e));
        this.reindexQueue.unshift(...uncompleted);
        throw error;
      }
    }

    // Phase 2: Watcher events (sequential phase)
    if (this.watcherQueue.length > 0) {
      const events = [...this.watcherQueue];
      this.watcherQueue.length = 0;
      const completed = new Set<QueueEvent>();
      try {
        const phaseResults = await Promise.all(
          events.map((event) =>
            limit(async () => {
              const result = await handler(event);
              completed.add(event);
              return result;
            })
          )
        );
        results.push(...phaseResults);
      } catch (error) {
        const uncompleted = events.filter((e) => !completed.has(e));
        this.watcherQueue.unshift(...uncompleted);
        throw error;
      }
    }

    if (this.watcherQueue.length === 0 && this.reindexQueue.length === 0) {
      this.overflow = false;
    }

    return results;
  }

  clear(): void {
    this.flushTimers();
    this.debouncedEvents.clear();
    this.watcherQueue.length = 0;
    this.reindexQueue.length = 0;
    this.overflow = false;
  }

  /**
   * Returns the total number of events currently in the queue,
   * including pending debounced events.
   */
  size(): number {
    return this.watcherQueue.length + this.reindexQueue.length + this.debouncedEvents.size;
  }

  isOverflowing(): boolean {
    return this.overflow;
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

    if (this.watcherQueue.length < this.options.maxQueueSize) {
      this.watcherQueue.push(event);
    } else {
      this.droppedEventCount += 1;
      console.warn('Event queue at capacity, dropping event:', {
        filePath,
        type: event.type,
        currentQueueSize: this.watcherQueue.length,
        totalDropped: this.droppedEventCount,
      });
    }

    if (this.watcherQueue.length > this.options.fullScanThreshold) {
      this.overflow = true;
    }
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
}
