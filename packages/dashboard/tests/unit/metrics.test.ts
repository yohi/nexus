import { describe, it, expect } from "vitest";
import { getValue } from "../../src/utils/metrics.js";
import type { MetricsJSON } from "../../src/hooks/use-metrics.js";

describe("getValue", () => {
  const mockData: MetricsJSON[] = [
    {
      name: "nexus_queue_size",
      type: "gauge",
      help: "Queue size",
      values: [{ value: 42, labels: {} }],
    },
    {
      name: "nexus_queue_state",
      type: "gauge",
      help: "Queue state",
      values: [
        { value: 1, labels: { state: "normal" } },
        { value: 0, labels: { state: "overflow" } },
      ],
    },
  ];

  it("returns 0 if data is null", () => {
    expect(getValue(null, "any")).toBe(0);
  });

  it("returns the value of a simple metric", () => {
    expect(getValue(mockData, "nexus_queue_size")).toBe(42);
  });

  it("returns the value of a metric with matching labels", () => {
    expect(getValue(mockData, "nexus_queue_state", "state", "normal")).toBe(1);
    expect(getValue(mockData, "nexus_queue_state", "state", "overflow")).toBe(0);
  });

  it("returns 0 if metric name is not found", () => {
    expect(getValue(mockData, "non_existent")).toBe(0);
  });

  it("returns 0 if label does not match", () => {
    expect(getValue(mockData, "nexus_queue_state", "state", "unknown")).toBe(0);
  });

  it("returns first value if label is not provided but metric has labels", () => {
    // Current implementation: return metric?.values?.[0]?.value ?? 0;
    // If name matches but no labels provided, it returns the first value.
    expect(getValue(mockData, "nexus_queue_state")).toBe(1);
  });
});
