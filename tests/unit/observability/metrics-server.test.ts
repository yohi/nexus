import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Registry, Counter } from "prom-client";
import { MetricsHttpServer } from "../../../src/observability/metrics-server.js";
import { MetricsCollector } from "../../../src/observability/metrics-collector.js";
import { findFreePort } from "../../shared/port-utils.js";
import * as net from "node:net";

describe("MetricsHttpServer", () => {
  let registry: Registry;
  let httpServer: MetricsHttpServer;

  /**
   * Safe wrapper for net.Server startup
   */
  const startRawServer = (port: number): Promise<net.Server> => {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on("error", reject);
      s.listen(port, "127.0.0.1", () => {
        s.off("error", reject);
        resolve(s);
      });
    });
  };

  /**
   * Safe wrapper for net.Server shutdown
   */
  const stopRawServer = (s: net.Server): Promise<void> => {
    return new Promise((resolve, reject) => {
      s.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  beforeEach(async () => {
    registry = new Registry();
    httpServer = new MetricsHttpServer(registry);
  });

  afterEach(async () => {
    await httpServer.stop();
  });

  it("GET /metrics が Prometheus 形式を返す（200, text/plain, nexus_event_queue_size を含む）", async () => {
    const counter = new Counter({
      name: "nexus_event_queue_size",
      help: "Test",
      registers: [registry],
    });
    counter.inc(5);

    await httpServer.start(0);
    const boundPort = httpServer.getPort()!;

    const res = await fetch(`http://127.0.0.1:${boundPort}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("nexus_event_queue_size 5");
  });

  it("GET /metrics/json が JSON 配列を返す（200, application/json, パース可能）", async () => {
    const counter = new Counter({
      name: "nexus_test_counter",
      help: "Test",
      registers: [registry],
    });
    counter.inc(10);

    await httpServer.start(0);
    const boundPort = httpServer.getPort()!;

    const res = await fetch(`http://127.0.0.1:${boundPort}/metrics/json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
    expect(
      json.some(
        (m: Record<string, unknown>) => m.name === "nexus_test_counter",
      ),
    ).toBe(true);
  });

  it('GET /health が { "status": "ok" } を返す（200）', async () => {
    await httpServer.start(0);
    const boundPort = httpServer.getPort()!;

    const res = await fetch(`http://127.0.0.1:${boundPort}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });

  it("未定義パスに 404 を返す", async () => {
    await httpServer.start(0);
    const boundPort = httpServer.getPort()!;

    const res = await fetch(`http://127.0.0.1:${boundPort}/invalid`);
    expect(res.status).toBe(404);
  });

  it("ポート競合時に MetricsHttpServer が無効化される（start() は resolve し、isListening() は false となる）", async () => {
    const otherServer = await startRawServer(0);
    const port = (otherServer.address() as net.AddressInfo).port;

    try {
      const serverOnPort = new MetricsHttpServer(registry);
      await serverOnPort.start(port);
      expect(serverOnPort.isListening()).toBe(false);
    } finally {
      await stopRawServer(otherServer);
    }
  });

  it("EADDRINUSE 発生後もメトリクスコレクターとの連携が正常に動作する", async () => {
    const otherServer = await startRawServer(0);
    const port = (otherServer.address() as net.AddressInfo).port;

    try {
      const collector = new MetricsCollector(registry);
      const serverOnPort = new MetricsHttpServer(registry);
      await serverOnPort.start(port);

      collector.onChunksIndexed(5);
      const metrics = await registry.metrics();
      expect(metrics).toContain("nexus_indexing_chunks_total 5");
    } finally {
      await stopRawServer(otherServer);
    }
  });

  it("stop() が未起動状態でも安全", async () => {
    const server = new MetricsHttpServer(registry);
    await server.stop();
    expect(server.isListening()).toBe(false);
  });

  it("isListening() が初期状態で false", () => {
    const server = new MetricsHttpServer(registry);
    expect(server.isListening()).toBe(false);
  });
});
