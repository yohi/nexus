import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Registry, Counter } from "prom-client";
import { MetricsHttpServer } from "../../../src/observability/metrics-server.js";
import { MetricsCollector } from "../../../src/observability/metrics-collector.js";
import * as net from "node:net";

describe("MetricsHttpServer", () => {
  let registry: Registry;
  let httpServer: MetricsHttpServer;
  let port: number;

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
    port = await findFreePort();
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

    await httpServer.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
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

    await httpServer.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/metrics/json`);
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
    await httpServer.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });

  it("未定義パスに 404 を返す", async () => {
    await httpServer.start(port);

    const res = await fetch(`http://127.0.0.1:${port}/invalid`);
    expect(res.status).toBe(404);
  });

  it("EADDRINUSE 時に MCP サーバーが継続稼働する（start() が reject せず resolve、isListening() が false）", async () => {
    const otherServer = await new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(port, () => resolve(s));
    });

    try {
      const serverOnPort = new MetricsHttpServer(registry);
      await serverOnPort.start(port);
      expect(serverOnPort.isListening()).toBe(false);
    } finally {
      otherServer.close();
    }
  });

  it("EADDRINUSE 後もメトリクスコールバックが動作する", async () => {
    const otherServer = await new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(port, () => resolve(s));
    });

    try {
      const serverOnPort = new MetricsHttpServer(registry);
      await serverOnPort.start(port);
      expect(serverOnPort.isListening()).toBe(false);
    } finally {
      otherServer.close();
    }
  });

  it("EADDRINUSE 後もメトリクスコールバックが動作する", async () => {
    const otherServer = await new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(port, () => resolve(s));
    });

    try {
      const collector = new MetricsCollector(registry);
      const serverOnPort = new MetricsHttpServer(registry);
      await serverOnPort.start(port);

      collector.onChunksIndexed(5);
      const metrics = await registry.metrics();
      expect(metrics).toContain("nexus_indexing_chunks_total 5");
    } finally {
      otherServer.close();
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
