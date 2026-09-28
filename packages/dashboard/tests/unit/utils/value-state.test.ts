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
