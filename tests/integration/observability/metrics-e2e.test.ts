import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Registry } from "prom-client";
import { EventQueue } from "../../../src/indexer/event-queue.js";
import { DeadLetterQueue } from "../../../src/indexer/dead-letter-queue.js";
import { MetricsCollector } from "../../../src/observability/metrics-collector.js";
import { MetricsHttpServer } from "../../../src/observability/metrics-server.js";
import type { IMetadataStore } from "../../../src/types/index.js";
import * as net from "node:net";

describe("Metrics E2E Integration", () => {
  let registry: Registry;
  let collector: MetricsCollector;
  let httpServer: MetricsHttpServer;
  let port: number;
  let mockMetadataStore: any;

  const findFreePort = (): Promise<number> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, () => {
        const address = server.address() as net.AddressInfo;
        resolve(address.port);
        server.close();
      });
    });
  };

  beforeEach(async () => {
    registry = new Registry();
    collector = new MetricsCollector(registry);
    httpServer = new MetricsHttpServer(registry);
    port = await findFreePort();

    mockMetadataStore = {
      initialize: vi.fn().mockResolvedValue(undefined),
      upsertDeadLetterEntries: vi.fn().mockResolvedValue(undefined),
      removeDeadLetterEntries: vi.fn().mockResolvedValue(undefined),
      getDeadLetterEntries: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(async () => {
    if (httpServer) {
      await httpServer.stop();
    }
  });

  it("EventQueue 操作が /metrics/json に反映される", async () => {
    await httpServer.start(port);

    const eventQueue = new EventQueue({
      debounceMs: 10,
      maxQueueSize: 100,
      fullScanThreshold: 0.8,
      concurrency: 1,
      metricsHooks: {
        onQueueSnapshot: (size, state, dropped, source) => {
          collector.onQueueSnapshot(size, state, dropped, source);
        },
      },
      name: "test-queue",
    });

    eventQueue.enqueue({
      type: "added",
      filePath: "/test/file.ts",
      detectedAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 20));
    eventQueue.drain();

    const res = await fetch(`http://127.0.0.1:${port}/metrics/json`);
    const json = (await res.json()) as Array<{
      name?: string;
      values?: Array<{ value: number }>;
    }>;
    const queueSize = json.find((m) => m.name === "nexus_event_queue_size");
    expect(queueSize).toBeDefined();
  });

  it("DLQ 操作が /metrics/json に反映される", async () => {
    await httpServer.start(port);

    const dlq = new DeadLetterQueue({
      metadataStore: mockMetadataStore as unknown as IMetadataStore,
      metricsHooks: {
        onDlqSnapshot: (size, source) => collector.onDlqSnapshot(size, source),
        onRecoverySweepComplete: (retried, purged, skipped, source) =>
          collector.onRecoverySweepComplete(retried, purged, skipped, source),
      },
      name: "test-dlq",
    });

    await dlq.load();

    const res = await fetch(`http://127.0.0.1:${port}/metrics/json`);
    const json = (await res.json()) as Array<{ name?: string }>;
    const dlqSize = json.find((m) => m.name === "nexus_dlq_size");
    expect(dlqSize).toBeDefined();
  });

  it("極端なメトリクス変動のエンドツーエンド追従", async () => {
    await httpServer.start(port);

    collector.onChunksIndexed(1);
    collector.onChunksIndexed(5);
    collector.onChunksIndexed(100);

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    const text = await res.text();
    expect(text).toContain("nexus_indexing_chunks_total");
  });

  it("ポート競合時もコアモジュール→メトリクス収集は動作する", async () => {
    const otherServer = await new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(port, () => resolve(s));
    });

    try {
      const serverOnPort = new MetricsHttpServer(registry);
      await serverOnPort.start(port);

      collector.onChunksIndexed(42);
      const metrics = await registry.metrics();
      expect(metrics).toContain("nexus_indexing_chunks_total 42");
    } finally {
      otherServer.close();
    }
  });

  it("シャットダウンチェーンが正常に完了する", async () => {
    await httpServer.start(port);
    expect(httpServer.isListening()).toBe(true);

    await httpServer.stop();
    expect(httpServer.isListening()).toBe(false);

    collector.onChunksIndexed(1);
    const metrics = await registry.metrics();
    expect(metrics).toContain("nexus_indexing_chunks_total 1");
  });
});
