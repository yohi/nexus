import { describe, it, expect } from "vitest";
import { valueFromMetric } from "../../../src/utils/value-state.js";

describe("valueFromMetric", () => {
  it("returns unavailable when metric is absent", () => {
    const result = valueFromMetric("nexus_event_queue_size", [], "queue_id", "default");
    expect(result).toEqual({ kind: "unavailable", reason: "Metric nexus_event_queue_size not found" });
  });

  it("returns waiting when metrics array is null", () => {
    const result = valueFromMetric("nexus_event_queue_size", null, "queue_id", "default");
    expect(result).toEqual({ kind: "waiting" });
  });
});
  it("returns available with matched label", () => {
    const metrics = [{ name: "nexus_event_queue_size", values: [{ value: 7, labels: { queue_id: "default" } }] }];
    const result = valueFromMetric("nexus_event_queue_size", metrics, "queue_id", "default");
    expect(result).toEqual({ kind: "available", value: 7 });
  });

  it("returns unavailable when label value does not match", () => {
    const metrics = [{ name: "nexus_event_queue_size", values: [{ value: 7, labels: { queue_id: "other" } }] }];
    const result = valueFromMetric("nexus_event_queue_size", metrics, "queue_id", "default");
    expect(result).toEqual({ kind: "unavailable", reason: "Metric nexus_event_queue_size value not found" });
  });

  it("returns first value when no label filter is provided", () => {
    const metrics = [{ name: "nexus_event_queue_size", values: [{ value: 5, labels: {} }] }];
    const result = valueFromMetric("nexus_event_queue_size", metrics);
    expect(result).toEqual({ kind: "available", value: 5 });
  });
