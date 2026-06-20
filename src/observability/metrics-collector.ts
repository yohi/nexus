import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import path from 'node:path';
import type { MetricsHooks } from './types.js';
import type { BackpressureState } from '../indexer/event-queue.js';

const BACKPRESSURE_STATES = ['normal', 'overflow', 'full_scan'] as const satisfies readonly BackpressureState[];
const REINDEX_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];

const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const SEARCH_RESULTS_BUCKETS = [0, 1, 5, 10, 25, 50, 100, 250];
const EMBEDDING_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const EMBEDDING_BATCH_SIZE_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250];
export class MetricsCollector implements MetricsHooks {


  readonly registry: Registry;

  private readonly queueSizeGauge: Gauge;
  private readonly queueStateGauge: Gauge;
  private readonly droppedCounter: Counter;
  private readonly chunksCounter: Counter;
  private readonly reindexHistogram: Histogram;
  private readonly dlqSizeGauge: Gauge;
  private readonly recoveryCounter: Counter;
  private readonly indexingActiveGauge: Gauge;
  private readonly indexingProcessedFilesGauge: Gauge;
  private readonly indexingTotalFilesGauge: Gauge;
  // New metrics
  private readonly toolCallsTotal: Counter;
  private readonly toolDurationSeconds: Histogram;
  private readonly searchResults: Histogram;
  private readonly contextLinesFetchedTotal: Counter;
  private readonly embeddingRequestsTotal: Counter;
  private readonly embeddingDurationSeconds: Histogram;
  private readonly embeddingBatchSize: Histogram;

  private readonly prevDroppedBySource = new Map<string, number>();


  constructor(options: { projectName?: string; registry?: Registry } = {}) {
    const { projectName, registry } = options;
    this.registry = registry ?? new Registry();
    if (!registry) {
      this.registry.setDefaultLabels({
        project: projectName || process.env.NEXUS_PROJECT_NAME || path.basename(process.cwd()),
      });
    }

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

    this.indexingActiveGauge = new Gauge({
      name: 'nexus_indexing_active',
      help: 'Whether indexing is currently active (1 = active, 0 = idle)',
      registers: [this.registry],
    });

    this.indexingProcessedFilesGauge = new Gauge({
      name: 'nexus_indexing_processed_files',
      help: 'Number of processed files in the current indexing run',
      registers: [this.registry],
    });

    this.indexingTotalFilesGauge = new Gauge({
      name: 'nexus_indexing_total_files',
      help: 'Total number of files to process in the current indexing run',
      registers: [this.registry],
    });

    // Initialize new metrics
    this.toolCallsTotal = new Counter({
      name: 'nexus_tool_calls_total',
      help: 'Total tool calls count',
      labelNames: ['tool_name', 'status'] as const,
      registers: [this.registry],
    });

    this.toolDurationSeconds = new Histogram({
      name: 'nexus_tool_duration_seconds',
      help: 'Tool execution duration in seconds',
      labelNames: ['tool_name'] as const,
      buckets: TOOL_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.searchResults = new Histogram({
      name: 'nexus_search_results',
      help: 'Search hit results count distribution',
      labelNames: ['search_type'] as const,
      buckets: SEARCH_RESULTS_BUCKETS,
      registers: [this.registry],
    });

    this.contextLinesFetchedTotal = new Counter({
      name: 'nexus_context_lines_fetched_total',
      help: 'Total number of lines fetched by context tools',
      labelNames: ['tool_name'] as const,
      registers: [this.registry],
    });

    this.embeddingRequestsTotal = new Counter({
      name: 'nexus_embedding_requests_total',
      help: 'Total embedding provider request count',
      labelNames: ['provider', 'status'] as const,
      registers: [this.registry],
    });

    this.embeddingDurationSeconds = new Histogram({
      name: 'nexus_embedding_duration_seconds',
      help: 'Embedding request duration in seconds',
      labelNames: ['provider'] as const,
      buckets: EMBEDDING_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.embeddingBatchSize = new Histogram({
      name: 'nexus_embedding_batch_size',
      help: 'Embedding request batch size distribution',
      labelNames: ['provider'] as const,
      buckets: EMBEDDING_BATCH_SIZE_BUCKETS,
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
    
    if (droppedTotal < prevDropped) {
      // Counter reset detected (e.g. source restart)
      if (droppedTotal > 0) {
        this.droppedCounter.labels(labels).inc(droppedTotal);
      }
    } else {
      const delta = droppedTotal - prevDropped;
      if (delta > 0) {
        this.droppedCounter.labels(labels).inc(delta);
      }
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

  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source = 'default'): void {
    const labels = { dlq_id: source };
    if (retried > 0) this.recoveryCounter.labels({ ...labels, result: 'retried' }).inc(retried);
    if (purged > 0) this.recoveryCounter.labels({ ...labels, result: 'purged' }).inc(purged);
    if (skipped > 0) this.recoveryCounter.labels({ ...labels, result: 'skipped' }).inc(skipped);
    if (abandoned > 0) this.recoveryCounter.labels({ ...labels, result: 'abandoned' }).inc(abandoned);
  }

  onIndexingProgress(processed: number, total: number, active: boolean): void {
    this.indexingActiveGauge.set(active ? 1 : 0);
    this.indexingProcessedFilesGauge.set(processed);
    this.indexingTotalFilesGauge.set(total);
  }

  // Implement new hooks
  onToolCall(toolName: string, status: 'success' | 'error', durationSeconds: number): void {
    this.toolCallsTotal.labels(toolName, status).inc();
    this.toolDurationSeconds.labels(toolName).observe(durationSeconds);
  }

  onSearchResults(searchType: 'semantic' | 'grep' | 'hybrid', resultCount: number): void {
    this.searchResults.labels(searchType).observe(resultCount);
  }

  onContextLinesFetched(toolName: string, lineCount: number): void {
    if (lineCount > 0) {
      this.contextLinesFetchedTotal.labels(toolName).inc(lineCount);
    }
  }

  onEmbeddingRequest(provider: string, status: 'success' | 'error', durationSeconds: number, batchSize: number): void {
    this.embeddingRequestsTotal.labels(provider, status).inc();
    this.embeddingDurationSeconds.labels(provider).observe(durationSeconds);
    this.embeddingBatchSize.labels(provider).observe(batchSize);
  }
}