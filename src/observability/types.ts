import type { BackpressureState } from '../indexer/event-queue.js';

export interface MetricsHooks {
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source?: string): void;

  onChunksIndexed(count: number): void;

  onReindexComplete(durationMs: number, fullRebuild: boolean): void;

  onDlqSnapshot(size: number, source?: string): void;

  onRecoverySweepComplete(retried: number, purged: number, skipped: number, source?: string): void;
}