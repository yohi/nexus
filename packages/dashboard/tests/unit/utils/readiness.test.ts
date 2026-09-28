import { describe, it, expect } from "vitest";
import { deriveMainReadiness } from "../../../src/utils/readiness.js";
import type { DashboardIndexStatusResult } from "../../../src/types/dashboard-index-status.js";

describe("deriveMainReadiness", () => {
  it("returns Ready when lastIndexedAt is present and no errors", () => {
    const snapshot = { indexStats: { lastError: null, lastIndexedAt: "2026-09-24T00:00:00.000Z" }, pipelineProgress: { status: "idle" } } as unknown as DashboardIndexStatusResult;
    expect(deriveMainReadiness(snapshot)).toBe("Ready");
  });

  it("returns Failed when indexStats has lastError", () => {
    const snapshot = { indexStats: { lastError: "disk full", lastIndexedAt: null }, pipelineProgress: { status: "idle" } } as unknown as DashboardIndexStatusResult;
    expect(deriveMainReadiness(snapshot)).toBe("Failed");
  });

  it("returns Unavailable when snapshot is null", () => {
    expect(deriveMainReadiness(null)).toBe("Unavailable");
  });
});
