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

    collector.onQueueSnapshot(42, 'normal', 0);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_size 42');
    expect(metrics).toContain('nexus_event_queue_state{state="normal"} 1');
    expect(metrics).toContain('nexus_event_queue_state{state="overflow"} 0');
    expect(metrics).toContain('nexus_event_queue_state{state="full_scan"} 0');
  });

  it('onQueueSnapshot で dropped Counter が累積する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(10, 'overflow', 3);

    const metrics1 = await registry.metrics();
    expect(metrics1).toContain('nexus_event_queue_dropped_total 3');

    collector.onQueueSnapshot(10, 'overflow', 7);

    const metrics2 = await registry.metrics();
    expect(metrics2).toContain('nexus_event_queue_dropped_total 7');
  });

  it('onQueueSnapshot で droppedTotal がリセットされても正しく計測を継続する', async () => {
    const collector = new MetricsCollector(registry);

    // 1. 初回のドロップ計上 (0 -> 3)
    collector.onQueueSnapshot(10, 'overflow', 3);
    expect(await registry.metrics()).toContain('nexus_event_queue_dropped_total 3');

    // 2. ソースのリセット (3 -> 0) : カウンタは 3 のまま維持されるべき
    collector.onQueueSnapshot(10, 'overflow', 0);
    expect(await registry.metrics()).toContain('nexus_event_queue_dropped_total 3');

    // 3. リセット後の新規ドロップ (0 -> 1) : 合計は 4 (3 + 1) になるべき
    collector.onQueueSnapshot(10, 'overflow', 1);
    expect(await registry.metrics()).toContain('nexus_event_queue_dropped_total 4');
  });

  it('急激な Queue サイズ変動に追従する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(0, 'normal', 0);
    collector.onQueueSnapshot(10000, 'full_scan', 500);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_size 10000');
    expect(metrics).toContain('nexus_event_queue_state{state="full_scan"} 1');
    expect(metrics).toContain('nexus_event_queue_state{state="normal"} 0');
  });

  it('state の高速遷移を正確に追跡する', async () => {
    const collector = new MetricsCollector(registry);

    collector.onQueueSnapshot(5, 'normal' as BackpressureState, 0);
    collector.onQueueSnapshot(10, 'overflow' as BackpressureState, 0);
    collector.onQueueSnapshot(20, 'full_scan' as BackpressureState, 0);
    collector.onQueueSnapshot(0, 'normal' as BackpressureState, 0);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_event_queue_state{state="normal"} 1');
    expect(metrics).toContain('nexus_event_queue_state{state="overflow"} 0');
    expect(metrics).toContain('nexus_event_queue_state{state="full_scan"} 0');
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
    expect(metrics).toContain('nexus_dlq_size 0');
  });

  it('onRecoverySweepComplete で Counter が加算される', async () => {
    const collector = new MetricsCollector(registry);

    collector.onRecoverySweepComplete(5, 2, 1);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_dlq_recovery_total{result="retried"} 5');
    expect(metrics).toContain('nexus_dlq_recovery_total{result="purged"} 2');
    expect(metrics).toContain('nexus_dlq_recovery_total{result="skipped"} 1');
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