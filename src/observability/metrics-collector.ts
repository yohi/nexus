import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import type { MetricsHooks } from './types.js';
import type { BackpressureState } from '../indexer/event-queue.js';

const BACKPRESSURE_STATES = ['normal', 'overflow', 'full_scan'] as const satisfies readonly BackpressureState[];

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

  private readonly prevDroppedBySource = new Map<string, number>();

  constructor(registry?: Registry) {
    this.registry = registry ?? new Registry();

    this.queueSizeGauge = new Gauge({
      name: 'nexus_event_queue_size',
      help: 'Current event queue size',
      labelNames: ['queue_id'] as const,
      registers: [this.registry],
    });

    this.queueStateGauge = new Gauge({
      name: 'nexus_event_queue_state',
      help: 'Current backpressure state (1 = active)',
      labelNames: ['queue_id', 'state'] as const,
      registers: [this.registry],
    });

    this.droppedCounter = new Counter({
      name: 'nexus_event_queue_dropped_total',
      help: 'Total dropped events',
      labelNames: ['queue_id'] as const,
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
      labelNames: ['dlq_id'] as const,
      registers: [this.registry],
    });

    this.recoveryCounter = new Counter({
      name: 'nexus_dlq_recovery_total',
      help: 'DLQ recovery sweep results',
      labelNames: ['dlq_id', 'result'] as const,
      registers: [this.registry],
    });
  }

  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source = 'default'): void {
    const labels = { queue_id: source };
    this.queueSizeGauge.labels(labels).set(size);
    for (const s of BACKPRESSURE_STATES) {
      this.queueStateGauge.labels({ ...labels, state: s }).set(s === state ? 1 : 0);
    }

    const prevDropped = this.prevDroppedBySource.get(source) ?? 0;
    const delta = droppedTotal - prevDropped;
    if (delta > 0) {
      this.droppedCounter.labels(labels).inc(delta);
    }
    this.prevDroppedBySource.set(source, droppedTotal);
  }

  onChunksIndexed(count: number): void {
    if (count > 0) {
      this.chunksCounter.inc(count);
    }
  }

  onReindexComplete(durationMs: number, fullRebuild: boolean): void {
    this.reindexHistogram.labels(String(fullRebuild)).observe(durationMs / 1000);
  }

  onDlqSnapshot(size: number, source = 'default'): void {
    this.dlqSizeGauge.labels({ dlq_id: source }).set(size);
  }

  onRecoverySweepComplete(retried: number, purged: number, skipped: number, source = 'default'): void {
    const labels = { dlq_id: source };
    if (retried > 0) this.recoveryCounter.labels({ ...labels, result: 'retried' }).inc(retried);
    if (purged > 0) this.recoveryCounter.labels({ ...labels, result: 'purged' }).inc(purged);
    if (skipped > 0) this.recoveryCounter.labels({ ...labels, result: 'skipped' }).inc(skipped);
  }
}