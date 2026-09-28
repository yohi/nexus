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
