import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import { MetricsCollector } from '../../../src/observability/metrics-collector.js';
import type { BackpressureState } from '../../../src/indexer/event-queue.js';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const metricPattern = (name: string, value: string | number, ...labels: readonly string[]): RegExp => {
  const labelChecks = labels.map((label) => '(?=[^}]*' + escapeRegExp(label) + ')').join('');
  return new RegExp(String.raw`${name}(?:\{${labelChecks}[^}]*\})? ${value}`);
};

describe('MetricsCollector', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('onQueueSnapshot で Gauge が更新される', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onQueueSnapshot(42, 'normal', 0, 'test-queue');

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_event_queue_size', 42, 'queue_id="test-queue"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 1, 'queue_id="test-queue"', 'state="normal"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 0, 'queue_id="test-queue"', 'state="overflow"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 0, 'queue_id="test-queue"', 'state="full_scan"'));
  });

  it('onQueueSnapshot で dropped Counter が累積する', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onQueueSnapshot(10, 'overflow', 3, 'test-queue');

    const metrics1 = await registry.metrics();
    expect(metrics1).toMatch(metricPattern('nexus_event_queue_dropped_total', 3, 'queue_id="test-queue"'));

    collector.onQueueSnapshot(10, 'overflow', 7, 'test-queue');

    const metrics2 = await registry.metrics();
    expect(metrics2).toMatch(metricPattern('nexus_event_queue_dropped_total', 7, 'queue_id="test-queue"'));
  });

  it('onQueueSnapshot で droppedTotal がリセットされても正しく計測を継続する', async () => {
    const collector = new MetricsCollector({ registry });

    // 1. 初回のドロップ計上 (0 -> 3)
    collector.onQueueSnapshot(10, 'overflow', 3, 'test-queue');
    expect(await registry.metrics()).toMatch(metricPattern('nexus_event_queue_dropped_total', 3, 'queue_id="test-queue"'));

    // 2. ソースのリセット (3 -> 0) : カウンタは 3 のまま維持されるべき
    collector.onQueueSnapshot(10, 'overflow', 0, 'test-queue');
    expect(await registry.metrics()).toMatch(metricPattern('nexus_event_queue_dropped_total', 3, 'queue_id="test-queue"'));

    // 3. リセット後の新規ドロップ (0 -> 1) : 合計は 4 (3 + 1) になるべき
    collector.onQueueSnapshot(10, 'overflow', 1, 'test-queue');
    expect(await registry.metrics()).toMatch(metricPattern('nexus_event_queue_dropped_total', 4, 'queue_id="test-queue"'));
  });

  it('複数ソースのドロップイベントを個別に追跡する', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onQueueSnapshot(10, 'overflow', 5, 'queue-a');
    collector.onQueueSnapshot(20, 'overflow', 3, 'queue-b');

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_event_queue_dropped_total', 5, 'queue_id="queue-a"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_dropped_total', 3, 'queue_id="queue-b"'));

    collector.onQueueSnapshot(10, 'overflow', 8, 'queue-a'); // delta 3
    collector.onQueueSnapshot(20, 'overflow', 2, 'queue-b'); // reset (3 -> 2), inc(2)

    const updatedMetrics = await registry.metrics();
    expect(updatedMetrics).toMatch(metricPattern('nexus_event_queue_dropped_total', 8, 'queue_id="queue-a"'));
    expect(updatedMetrics).toMatch(metricPattern('nexus_event_queue_dropped_total', 5, 'queue_id="queue-b"'));
  });

  it('急激な Queue サイズ変動に追従する', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onQueueSnapshot(0, 'normal', 0, 'test-queue');
    collector.onQueueSnapshot(10000, 'full_scan', 500, 'test-queue');

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_event_queue_size', 10000, 'queue_id="test-queue"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 1, 'queue_id="test-queue"', 'state="full_scan"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 0, 'queue_id="test-queue"', 'state="normal"'));
  });

  it('state の高速遷移を正確に追跡する', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onQueueSnapshot(5, 'normal' as BackpressureState, 0, 'test-queue');
    collector.onQueueSnapshot(10, 'overflow' as BackpressureState, 0, 'test-queue');
    collector.onQueueSnapshot(20, 'full_scan' as BackpressureState, 0, 'test-queue');
    collector.onQueueSnapshot(0, 'normal' as BackpressureState, 0, 'test-queue');

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 1, 'queue_id="test-queue"', 'state="normal"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 0, 'queue_id="test-queue"', 'state="overflow"'));
    expect(metrics).toMatch(metricPattern('nexus_event_queue_state', 0, 'queue_id="test-queue"', 'state="full_scan"'));
  });

  it('onChunksIndexed で Counter が加算される', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onChunksIndexed(100);
    collector.onChunksIndexed(100);
    collector.onChunksIndexed(100);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_indexing_chunks_total', 300));
  });

  it('onChunksIndexed にゼロを渡しても安全', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onChunksIndexed(50);
    collector.onChunksIndexed(0);
    collector.onChunksIndexed(0);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_indexing_chunks_total', 50));
  });

  it('onReindexComplete で Histogram にサンプルが記録される', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onReindexComplete(1204, false);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_reindex_duration_seconds_count', 1, 'full_rebuild="false"'));
  });

  it('onReindexComplete の極端な duration', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onReindexComplete(0.5, true);
    collector.onReindexComplete(180000, true);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_reindex_duration_seconds_count', 2, 'full_rebuild="true"'));
  });

  it('onDlqSnapshot で Gauge が更新される', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onDlqSnapshot(3);
    collector.onDlqSnapshot(0);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_dlq_size', 0, 'dlq_id="default"'));
  });

  it('onRecoverySweepComplete で Counter が加算される', async () => {
    const collector = new MetricsCollector({ registry });

    collector.onRecoverySweepComplete(5, 2, 1, 3);

    const metrics = await registry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_dlq_recovery_total', 5, 'dlq_id="default"', 'result="retried"'));
    expect(metrics).toMatch(metricPattern('nexus_dlq_recovery_total', 2, 'dlq_id="default"', 'result="purged"'));
    expect(metrics).toMatch(metricPattern('nexus_dlq_recovery_total', 1, 'dlq_id="default"', 'result="skipped"'));
    expect(metrics).toMatch(metricPattern('nexus_dlq_recovery_total', 3, 'dlq_id="default"', 'result="abandoned"'));
  });

  it('カスタム Registry を注入できる', async () => {
    const customRegistry = new Registry();
    const anotherRegistry = new Registry();

    const collectorInCustom = new MetricsCollector({ registry: customRegistry });
    collectorInCustom.onChunksIndexed(100);

    const collectorInAnother = new MetricsCollector({ registry: anotherRegistry });
    collectorInAnother.onChunksIndexed(200);

    const customMetrics = await customRegistry.metrics();
    expect(customMetrics).toMatch(metricPattern('nexus_indexing_chunks_total', 100));

    const anotherMetrics = await anotherRegistry.metrics();
    expect(anotherMetrics).toMatch(metricPattern('nexus_indexing_chunks_total', 200));
  });


  it('defaultLabels are set on new registry', async () => {
    const collector = new MetricsCollector({ projectName: 'test-project-labels' });
    const metricsCollectorRegistry = collector.registry;

    collector.onChunksIndexed(5);
    const metrics = await metricsCollectorRegistry.metrics();
    expect(metrics).toMatch(/\{(?=[^}]*project="test-project-labels")[^}]*\}/);
  });

  it('onToolCall increments counters and observes durations', async () => {
    const collector = new MetricsCollector({ projectName: 'test-project' });
    const toolRegistry = collector.registry;
    collector.onToolCall('semantic_search', 'success', 0.45);

    const metrics = await toolRegistry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_tool_calls_total', 1, 'project="test-project"', 'status="success"', 'tool_name="semantic_search"'));
    expect(metrics).toMatch(metricPattern('nexus_tool_duration_seconds_bucket', 1, 'le="0.5"', 'project="test-project"', 'tool_name="semantic_search"'));
  });

  it('onSearchResults records results counts', async () => {
    const collector = new MetricsCollector({ projectName: 'test-project' });
    const searchRegistry = collector.registry;
    collector.onSearchResults('hybrid', 15);

    const metrics = await searchRegistry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_search_results_bucket', 1, 'le="25"', 'project="test-project"', 'search_type="hybrid"'));
  });

  it('onContextLinesFetched increments line count metrics', async () => {
    const collector = new MetricsCollector({ projectName: 'test-project' });
    const contextRegistry = collector.registry;
    collector.onContextLinesFetched('get_context', 120);

    const metrics = await contextRegistry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_context_lines_fetched_total', 120, 'project="test-project"', 'tool_name="get_context"'));
  });

  it('onEmbeddingRequest records embedding stats', async () => {
    const collector = new MetricsCollector({ projectName: 'test-project' });
    const embedRegistry = collector.registry;
    collector.onEmbeddingRequest('ollama', 'success', 1.25, 4);

    const metrics = await embedRegistry.metrics();
    expect(metrics).toMatch(metricPattern('nexus_embedding_requests_total', 1, 'project="test-project"', 'provider="ollama"', 'status="success"'));
    expect(metrics).toMatch(metricPattern('nexus_embedding_duration_seconds_bucket', 1, 'le="2.5"', 'project="test-project"', 'provider="ollama"'));
    expect(metrics).toMatch(metricPattern('nexus_embedding_batch_size_bucket', 1, 'le="5"', 'project="test-project"', 'provider="ollama"'));
  });
});
