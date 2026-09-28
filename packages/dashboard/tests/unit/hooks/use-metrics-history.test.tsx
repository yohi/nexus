import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMetricsHistory } from "../../../src/hooks/use-metrics-history.js";
import type { MetricsJSON } from "../../../src/hooks/use-metrics.js";
import { MetricsHistory } from "../../../src/utils/metrics-history.js";

describe("useMetricsHistory", () => {
  it("evicts expired samples but retains the preceding delta baseline", () => {
    const history = new MetricsHistory({ windowMs: 5000 });
    const now = Date.now();
    const data = (value: number): MetricsJSON[] => [
      { name: "nexus_event_queue_dropped_total", values: [{ value, labels: { queue_id: "q1" } }] },
    ];
    history.observePoll({ generation: 1, data: data(1), timestamp: now - 7000 });
    history.observePoll({ generation: 2, data: data(2), timestamp: now - 6000 });
    history.observePoll({ generation: 3, data: data(5), timestamp: now });

    expect(history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toEqual([2, 5]);
    expect(history.getDeltaExact("nexus_event_queue_dropped_total", { queue_id: "q1" }, 5000)).toBe(3);
  });

  it("sums deltas across matching labels", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({ generation: 1, data: [
      { name: "nexus_embedding_requests_total", values: [
        { value: 10, labels: { provider: "ollama", status: "error" } },
        { value: 5, labels: { provider: "bedrock", status: "error" } },
      ] },
    ], timestamp: t0 });
    history.observePoll({ generation: 2, data: [
      { name: "nexus_embedding_requests_total", values: [
        { value: 12, labels: { provider: "ollama", status: "error" } },
        { value: 6, labels: { provider: "bedrock", status: "error" } },
      ] },
    ], timestamp: t0 + 1000 });
    expect(history.sumDeltaMatching("nexus_embedding_requests_total", { status: "error" }, 5000)).toBe(3);
  });

  it("ignores default project and pid labels for identity", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    history.observePoll({ generation: 1, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 1, labels: { queue_id: "q1", project: "foo", pid: "123" } }] }], timestamp: Date.now() });
    expect(history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toHaveLength(1);
  });

  it("does not count a missing poll as a counter interval", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({ generation: 1, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 10, labels: { queue_id: "q1" } }] }], timestamp: t0 });
    history.observePoll({ generation: 2, data: null, timestamp: t0 + 1000 });
    history.observePoll({ generation: 3, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 15, labels: { queue_id: "q1" } }] }], timestamp: t0 + 2000 });
    history.observePoll({ generation: 4, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 16, labels: { queue_id: "q1" } }] }], timestamp: t0 + 3000 });
    expect(history.getDeltaExact("nexus_event_queue_dropped_total", { queue_id: "q1" }, 5000)).toBe(1);
  });

  it("resets baseline on counter reset", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({ generation: 1, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 10, labels: { queue_id: "q1" } }] }], timestamp: t0 });
    history.observePoll({ generation: 2, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 2, labels: { queue_id: "q1" } }] }], timestamp: t0 + 1000 });
    history.observePoll({ generation: 3, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 3, labels: { queue_id: "q1" } }] }], timestamp: t0 + 2000 });
    expect(history.getDeltaExact("nexus_event_queue_dropped_total", { queue_id: "q1" }, 5000)).toBe(1);
  });

  it("preserves histogram components", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    history.observePoll({ generation: 1, data: [
      { name: "nexus_tool_duration_seconds_sum", values: [{ value: 1.2, labels: { tool_name: "grep" } }] },
      { name: "nexus_tool_duration_seconds_count", values: [{ value: 5, labels: { tool_name: "grep" } }] },
      { name: "nexus_tool_duration_seconds_bucket", values: [{ value: 5, labels: { tool_name: "grep", le: "+Inf" } }] },
    ], timestamp: Date.now() });
    expect(history.getSeriesExact("nexus_tool_duration_seconds_sum", { tool_name: "grep" })).toHaveLength(1);
    expect(history.getSeriesExact("nexus_tool_duration_seconds_count", { tool_name: "grep" })).toHaveLength(1);
    expect(history.getSeriesExact("nexus_tool_duration_seconds_bucket", { tool_name: "grep", le: "+Inf" })).toHaveLength(1);
  });

  it("computes histogram mean from sum and count deltas", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({ generation: 1, data: [
      { name: "nexus_tool_duration_seconds_sum", values: [{ value: 1.0, labels: { tool_name: "grep" } }] },
      { name: "nexus_tool_duration_seconds_count", values: [{ value: 2, labels: { tool_name: "grep" } }] },
    ], timestamp: t0 });
    history.observePoll({ generation: 2, data: [
      { name: "nexus_tool_duration_seconds_sum", values: [{ value: 2.5, labels: { tool_name: "grep" } }] },
      { name: "nexus_tool_duration_seconds_count", values: [{ value: 5, labels: { tool_name: "grep" } }] },
    ], timestamp: t0 + 1000 });
    expect(history.getHistogramMean("nexus_tool_duration_seconds", { tool_name: "grep" }, 5000)).toBe(0.5);
  });

  it("discards old port data and accepts generation one on the new port", () => {
    const { result, rerender } = renderHook(
      ({ port, data, generation }) => useMetricsHistory({ data, port, generation, windowMs: 5000 }),
      { initialProps: { port: 9464, generation: 0, data: null as MetricsJSON[] | null } },
    );
    result.current.history.observePoll({ generation: 7, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 70, labels: { queue_id: "q1" } }] }], timestamp: Date.now() });
    rerender({ port: 9465, generation: 7, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 70, labels: { queue_id: "q1" } }] }] });
    expect(result.current.history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toHaveLength(0);
    rerender({ port: 9465, generation: 0, data: null });
    rerender({ port: 9465, generation: 1, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 2, labels: { queue_id: "q1" } }] }] });
    expect(result.current.history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toEqual([2]);
  });
});
