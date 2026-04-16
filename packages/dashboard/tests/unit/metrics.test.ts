import { describe, it, expect } from "vitest";
import { getValue, calculateAvgDuration } from "../../src/utils/metrics.js";
import type { MetricsJSON, MetricValue } from "../../src/hooks/use-metrics.js";

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
    expect(getValue(mockData, "nexus_queue_state")).toBe(1);
  });
});

describe("calculateAvgDuration", () => {
  const baseName = "test_duration_seconds";
  
  it("returns N/A if samples is empty", () => {
    expect(calculateAvgDuration([], baseName)).toBe("N/A");
  });

  it("returns 0s if totalCount is 0", () => {
    const samples: (MetricValue & { metricName?: string })[] = [
      { value: 10, metricName: "test_duration_seconds_sum" },
      { value: 0, metricName: "test_duration_seconds_count" },
    ];
    expect(calculateAvgDuration(samples, baseName)).toBe("0s");
  });

  it("calculates average and formats as ms for < 1s", () => {
    const samples: (MetricValue & { metricName?: string })[] = [
      { value: 0.5, metricName: "test_duration_seconds_sum" },
      { value: 2, metricName: "test_duration_seconds_count" },
    ];
    // 0.5 / 2 = 0.25s = 250ms
    expect(calculateAvgDuration(samples, baseName)).toBe("250ms");
  });

  it("calculates average and formats as s for >= 1s", () => {
    const samples: (MetricValue & { metricName?: string })[] = [
      { value: 5.5, metricName: "test_duration_seconds_sum" },
      { value: 2, metricName: "test_duration_seconds_count" },
    ];
    // 5.5 / 2 = 2.75s -> 2.8s
    expect(calculateAvgDuration(samples, baseName)).toBe("2.8s");
  });

  it("sums multiple series correctly", () => {
    const samples: (MetricValue & { metricName?: string })[] = [
      { value: 1, metricName: "test_duration_seconds_sum", labels: { series: "a" } },
      { value: 2, metricName: "test_duration_seconds_sum", labels: { series: "b" } },
      { value: 10, metricName: "test_duration_seconds_count", labels: { series: "a" } },
      { value: 20, metricName: "test_duration_seconds_count", labels: { series: "b" } },
    ];
    // (1 + 2) / (10 + 20) = 3 / 30 = 0.1s = 100ms
    expect(calculateAvgDuration(samples, baseName)).toBe("100ms");
  });
});
