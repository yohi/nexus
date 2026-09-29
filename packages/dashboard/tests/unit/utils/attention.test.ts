import { describe, it, expect } from "vitest";
import { deriveAttention } from "../../../src/utils/attention.js";
import type { DashboardIndexStatusResult } from "../../../src/types/dashboard-index-status.js";
import { MetricsHistory } from "../../../src/utils/metrics-history.js";

describe("deriveAttention", () => {
  it("reports index build failed from canonical snapshot", () => {
    const snapshot = { indexStats: { lastError: "disk full" }, pipelineProgress: { status: "idle" }, providerStatus: { providerName: null, health: "unknown" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history: new MetricsHistory() });
    expect(items.some((i) => i.reason.includes("Index build failed"))).toBe(true);
  });

  it("reports connectivity item with actual endpoint URL on metrics_unavailable", () => {
    const items = deriveAttention({ snapshot: null, connectionState: "metrics_unavailable", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: null, metrics: null, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "connectivity");
    expect(item?.endpointUrl).toBe("http://127.0.0.1:9464/metrics/json");
  });

  it("reports embedding error delta from history", () => {
    const history = new MetricsHistory({ windowMs: 5000 });
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [{ name: "nexus_embedding_requests_total", values: [{ value: 1, labels: { provider: "bedrock", status: "error" } }] }],
      timestamp: t0,
    });
    history.observePoll({
      generation: 2,
      data: [{ name: "nexus_embedding_requests_total", values: [{ value: 4, labels: { provider: "bedrock", status: "error" } }] }],
      timestamp: t0 + 1000,
    });
    const items = deriveAttention({ snapshot: null, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history });
    expect(items.some((i) => i.reason.includes("Embedding errors"))).toBe(true);
  });
});
  it("reports pipeline failure from canonical snapshot", () => {
    const snapshot = { indexStats: { lastError: null }, pipelineProgress: { lastError: "pipeline crash" }, providerStatus: { providerName: null, health: "unknown" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "canonical" && i.fieldPath === "pipelineProgress.lastError");
    expect(item?.reason).toBe("Indexing pipeline failed");
    expect(item?.detail).toBe("pipeline crash");
  });

  it("reports structured index failure", () => {
    const snapshot = { indexStats: { lastError: null }, pipelineProgress: { status: "idle" }, structuredIndex: { status: "failed" }, providerStatus: { providerName: null, health: "unknown" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metricsEndpointUrl: null, statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "canonical" && i.fieldPath === "structuredIndex.status");
    expect(item?.reason).toBe("Structured index build failed");
  });

  it("reports structured index rebuild required", () => {
    const snapshot = { indexStats: { lastError: null }, pipelineProgress: { status: "idle" }, structuredIndex: { reindexRequired: true }, providerStatus: { providerName: null, health: "unknown" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metricsEndpointUrl: null, statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "canonical" && i.fieldPath === "structuredIndex.reindexRequired");
    expect(item?.reason).toBe("Structured index requires rebuild");
  });

  it("reports unhealthy provider", () => {
    const snapshot = { indexStats: { lastError: null }, pipelineProgress: { status: "idle" }, providerStatus: { providerName: "bedrock", health: "unhealthy", lastError: "rate limited" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metricsEndpointUrl: null, statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "canonical" && i.fieldPath === "providerStatus.health");
    expect(item?.reason).toBe("Embedding provider unhealthy");
    expect(item?.detail).toBe("rate limited");
  });

  it("reports queue overflow from metrics telemetry", () => {
    const metrics = [{ name: "nexus_event_queue_state", values: [{ value: 1, labels: { state: "overflow" } }] }];
    const items = deriveAttention({ snapshot: null, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "telemetry" && i.metricSeries === 'nexus_event_queue_state{state="overflow"}');
    expect(item?.reason).toBe("Queue overflow");
  });

  it("reports DLQ entries from metrics telemetry", () => {
    const metrics = [{ name: "nexus_dlq_size", values: [{ value: 3, labels: {} }] }];
    const items = deriveAttention({ snapshot: null, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "telemetry" && i.metricSeries === "nexus_dlq_size");
    expect(item?.reason).toBe("DLQ entries detected");
    expect(item?.detail).toBe("3");
  });

  it("reports dropped events from history telemetry", () => {
    const history = new MetricsHistory({ windowMs: 5000 });
    const t0 = Date.now();
    history.observePoll({ generation: 1, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 2, labels: { queue_id: "q1" } }] }], timestamp: t0 });
    history.observePoll({ generation: 2, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 5, labels: { queue_id: "q1" } }] }], timestamp: t0 + 1000 });
    const items = deriveAttention({ snapshot: null, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history });
    const item = items.find((i) => i.source === "telemetry" && i.metricSeries === "nexus_event_queue_dropped_total");
    expect(item?.reason).toBe("Dropped events observed");
  });
