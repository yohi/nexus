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

  constructor(private readonly options: EventQueueOptions) {}

  enqueue(event: IndexEvent): boolean {
    if (this.overflow) {
      return false;
    }

    const existingTimer = this.timers.get(event.filePath);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    this.debouncedEvents.set(event.filePath, event);
    const timer = setTimeout(() => {
      this.flushDebouncedEvent(event.filePath);
    }, this.options.debounceMs);
    this.timers.set(event.filePath, timer);
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
    const queue = [...this.reindexQueue, ...this.watcherQueue];

    this.reindexQueue.length = 0;
    this.watcherQueue.length = 0;

    const results = await Promise.all(queue.map((event) => limit(() => handler(event))));

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

  size(): number {
    return this.watcherQueue.length + this.reindexQueue.length;
  }

  isOverflowing(): boolean {
    return this.overflow;
  }

  private flushDebouncedEvent(filePath: string): void {
    const event = this.debouncedEvents.get(filePath);
    if (event === undefined) {
      return;
    }

    this.debouncedEvents.delete(filePath);
    this.timers.delete(filePath);

    if (this.watcherQueue.length < this.options.maxQueueSize) {
      this.watcherQueue.push(event);
    }

    if (this.watcherQueue.length > this.options.fullScanThreshold) {
      this.overflow = true;
    }
  }

  private flushAllDebounced(): void {
    for (const filePath of [...this.debouncedEvents.keys()]) {
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
