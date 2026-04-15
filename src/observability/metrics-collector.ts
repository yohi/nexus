import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import type { MetricsHooks } from './types.js';
import type { BackpressureState } from '../indexer/event-queue.js';

const BACKPRESSURE_STATES: readonly BackpressureState[] = ['normal', 'overflow', 'full_scan'];

const REINDEX_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];

export class MetricsCollector implements MetricsHooks {
  readonly registry: Registry;

  private readonly queueSizeGauge: Gauge;
  private readonly queueStateGauge: Gauge;
  private readonly droppedCounter: Counter;
  private readonly chunksCounter: Counter;
  private readonly reindexHistogram: Histogram;
  private readonly dlqSizeGauge: Gauge;
  private readonly recoveryCounter: Counter;

  private prevDropped = 0;

  constructor(registry?: Registry) {
    this.registry = registry ?? new Registry();

    this.queueSizeGauge = new Gauge({
      name: 'nexus_event_queue_size',
      help: 'Current event queue size',
      registers: [this.registry],
    });

    this.queueStateGauge = new Gauge({
      name: 'nexus_event_queue_state',
      help: 'Current backpressure state (1 = active)',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });

    this.droppedCounter = new Counter({
      name: 'nexus_event_queue_dropped_total',
      help: 'Total dropped events',
      registers: [this.registry],
    });

    this.chunksCounter = new Counter({
      name: 'nexus_indexing_chunks_total',
      help: 'Total chunks indexed',
      registers: [this.registry],
    });

    this.reindexHistogram = new Histogram({
      name: 'nexus_reindex_duration_seconds',
      help: 'Reindex duration in seconds',
      labelNames: ['full_rebuild'] as const,
      buckets: REINDEX_BUCKETS,
      registers: [this.registry],
    });

    this.dlqSizeGauge = new Gauge({
      name: 'nexus_dlq_size',
      help: 'Current DLQ entry count',
      registers: [this.registry],
    });

    this.recoveryCounter = new Counter({
      name: 'nexus_dlq_recovery_total',
      help: 'DLQ recovery sweep results',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });
  }

  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number): void {
    this.queueSizeGauge.set(size);
    for (const s of BACKPRESSURE_STATES) {
      this.queueStateGauge.labels(s).set(s === state ? 1 : 0);
    }
    const delta = droppedTotal - this.prevDropped;
    if (delta > 0) {
      this.droppedCounter.inc(delta);
      this.prevDropped = droppedTotal;
    }
  }

  onChunksIndexed(count: number): void {
    if (count > 0) {
      this.chunksCounter.inc(count);
    }
  }

  onReindexComplete(durationMs: number, fullRebuild: boolean): void {
    this.reindexHistogram.labels(String(fullRebuild)).observe(durationMs / 1000);
  }

  onDlqSnapshot(size: number): void {
    this.dlqSizeGauge.set(size);
  }

  onRecoverySweepComplete(retried: number, purged: number, skipped: number): void {
    if (retried > 0) this.recoveryCounter.labels('retried').inc(retried);
    if (purged > 0) this.recoveryCounter.labels('purged').inc(purged);
    if (skipped > 0) this.recoveryCounter.labels('skipped').inc(skipped);
  }
}