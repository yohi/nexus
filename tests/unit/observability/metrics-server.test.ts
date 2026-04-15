import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import { setTimeout as setTimeoutPromise } from 'timers/promises';

describe('MetricsHttpServer', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('stop() が未起動状態でも安全', async () => {
    const { MetricsHttpServer } = await import('../../../src/observability/metrics-server.js');

    const httpServer = new MetricsHttpServer(registry);
    await httpServer.stop();
    expect(httpServer.isListening()).toBe(false);
  });

  it(' MetricsCollector と連携して Counter を更新', async () => {
    const { MetricsCollector } = await import('../../../src/observability/metrics-collector.js');

    const collector = new MetricsCollector(registry);
    collector.onChunksIndexed(42);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_indexing_chunks_total 42');
  });

  it('isListening() が初期状态で false', async () => {
    const { MetricsHttpServer } = await import('../../../src/observability/metrics-server.js');

    const httpServer = new MetricsHttpServer(registry);
    expect(httpServer.isListening()).toBe(false);
  });
});