import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import { MetricsCollector } from '../../../src/observability/metrics-collector.js';
import type { BackpressureState } from '../../../src/indexer/event-queue.js';

describe('MetricsCollector', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('onQueueSnapshot で Gauge が更新される', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(42, 'normal', 0, 'test-queue');

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_size{queue_id="test-queue"} 42');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="normal"} 1');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="overflow"} 0');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="full_scan"} 0');
  });

  it('onQueueSnapshot で dropped Counter が累積する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(10, 'overflow', 3, 'test-queue');

    const metrics1 = await registry.metrics();
    expect(metrics1).toContain('nexus_event_queue_dropped_total{queue_id="test-queue"} 3');

    collector.onQueueSnapshot(10, 'overflow', 7, 'test-queue');

    const metrics2 = await registry.metrics();
    expect(metrics2).toContain('nexus_event_queue_dropped_total{queue_id="test-queue"} 7');
  });

  it('onQueueSnapshot で droppedTotal がリセットされても正しく計測を継続する', async () => {
    const collector = new MetricsCollector(registry);

    // 1. 初回のドロップ計上 (0 -> 3)
    collector.onQueueSnapshot(10, 'overflow', 3, 'test-queue');
    expect(await registry.metrics()).toContain('nexus_event_queue_dropped_total{queue_id="test-queue"} 3');

    // 2. ソースのリセット (3 -> 0) : カウンタは 3 のまま維持されるべき
    collector.onQueueSnapshot(10, 'overflow', 0, 'test-queue');
    expect(await registry.metrics()).toContain('nexus_event_queue_dropped_total{queue_id="test-queue"} 3');

    // 3. リセット後の新規ドロップ (0 -> 1) : 合計は 4 (3 + 1) になるべき
    collector.onQueueSnapshot(10, 'overflow', 1, 'test-queue');
    expect(await registry.metrics()).toContain('nexus_event_queue_dropped_total{queue_id="test-queue"} 4');
  });

  it('複数ソースのドロップイベントを個別に追跡する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(10, 'overflow', 5, 'queue-a');
    collector.onQueueSnapshot(20, 'overflow', 3, 'queue-b');

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_dropped_total{queue_id="queue-a"} 5');
    expect(metrics).toContain('nexus_event_queue_dropped_total{queue_id="queue-b"} 3');

    collector.onQueueSnapshot(10, 'overflow', 8, 'queue-a'); // delta 3
    collector.onQueueSnapshot(20, 'overflow', 2, 'queue-b'); // reset (3 -> 2), no inc

    const updatedMetrics = await registry.metrics();
    expect(updatedMetrics).toContain('nexus_event_queue_dropped_total{queue_id="queue-a"} 8');
    expect(updatedMetrics).toContain('nexus_event_queue_dropped_total{queue_id="queue-b"} 3');
  });

  it('急激な Queue サイズ変動に追従する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(0, 'normal', 0, 'test-queue');
    collector.onQueueSnapshot(10000, 'full_scan', 500, 'test-queue');

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_size{queue_id="test-queue"} 10000');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="full_scan"} 1');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="normal"} 0');
  });

  it('state の高速遷移を正確に追跡する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(5, 'normal' as BackpressureState, 0, 'test-queue');
    collector.onQueueSnapshot(10, 'overflow' as BackpressureState, 0, 'test-queue');
    collector.onQueueSnapshot(20, 'full_scan' as BackpressureState, 0, 'test-queue');
    collector.onQueueSnapshot(0, 'normal' as BackpressureState, 0, 'test-queue');

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="normal"} 1');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="overflow"} 0');
    expect(metrics).toContain('nexus_event_queue_state{queue_id="test-queue",state="full_scan"} 0');
  });

  it('onChunksIndexed で Counter が加算される', async () => {
    const collector = new MetricsCollector(registry);

    collector.onChunksIndexed(100);
    collector.onChunksIndexed(100);
    collector.onChunksIndexed(100);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_indexing_chunks_total 300');
  });

  it('onChunksIndexed にゼロを渡しても安全', async () => {
    const collector = new MetricsCollector(registry);

    collector.onChunksIndexed(50);
    collector.onChunksIndexed(0);
    collector.onChunksIndexed(0);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_indexing_chunks_total 50');
  });

  it('onReindexComplete で Histogram にサンプルが記録される', async () => {
    const collector = new MetricsCollector(registry);

    collector.onReindexComplete(1204, false);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_reindex_duration_seconds_count{full_rebuild="false"} 1');
  });

  it('onReindexComplete の極端な duration', async () => {
    const collector = new MetricsCollector(registry);

    collector.onReindexComplete(0.5, true);
    collector.onReindexComplete(180000, true);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_reindex_duration_seconds_count{full_rebuild="true"} 2');
  });

  it('onDlqSnapshot で Gauge が更新される', async () => {
    const collector = new MetricsCollector(registry);

    collector.onDlqSnapshot(3);
    collector.onDlqSnapshot(0);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_dlq_size{dlq_id="default"} 0');
  });

  it('onRecoverySweepComplete で Counter が加算される', async () => {
    const collector = new MetricsCollector(registry);

    collector.onRecoverySweepComplete(5, 2, 1);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_dlq_recovery_total{dlq_id="default",result="retried"} 5');
    expect(metrics).toContain('nexus_dlq_recovery_total{dlq_id="default",result="purged"} 2');
    expect(metrics).toContain('nexus_dlq_recovery_total{dlq_id="default",result="skipped"} 1');
  });

  it('カスタム Registry を注入できる', async () => {
    const customRegistry = new Registry();
    const anotherRegistry = new Registry();

    const collectorInCustom = new MetricsCollector(customRegistry);
    collectorInCustom.onChunksIndexed(100);

    const collectorInAnother = new MetricsCollector(anotherRegistry);
    collectorInAnother.onChunksIndexed(200);

    const customMetrics = await customRegistry.metrics();
    expect(customMetrics).toContain('nexus_indexing_chunks_total 100');

    const anotherMetrics = await anotherRegistry.metrics();
    expect(anotherMetrics).toContain('nexus_indexing_chunks_total 200');
  });
});