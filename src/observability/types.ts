import type { BackpressureState } from '../indexer/event-queue.js';

export interface MetricsHooks {
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number): void;

  onChunksIndexed(count: number): void;

  onReindexComplete(durationMs: number, fullRebuild: boolean): void;

  onDlqSnapshot(size: number): void;

  onRecoverySweepComplete(retried: number, purged: number, skipped: number): void;
}