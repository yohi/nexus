import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import { MetricsHttpServer } from '../../../src/observability/metrics-server.js';
import { MetricsCollector } from '../../../src/observability/metrics-collector.js';

describe('MetricsHttpServer', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('stop() が未起動状態でも安全', async () => {
    const httpServer = new MetricsHttpServer(registry);
    await httpServer.stop();
    expect(httpServer.isListening()).toBe(false);
  });

  it('isListening() が初期状態で false', async () => {
    const httpServer = new MetricsHttpServer(registry);
    expect(httpServer.isListening()).toBe(false);
  });
});

describe('MetricsCollector', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('MetricsCollector と連携して Counter を更新', async () => {
    const collector = new MetricsCollector(registry);
    collector.onChunksIndexed(42);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_indexing_chunks_total 42');
  });
});