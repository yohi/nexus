import { describe, it, expect } from "vitest";
import type { DashboardIndexStatusResult, DashboardProviderStatus } from "../../../src/types/dashboard-index-status.js";

describe("dashboard-index-status types", () => {
  it("accepts a minimal dashboard result", () => {
    const providerStatus: DashboardProviderStatus = { providerName: null, health: "unknown", lastError: null };
    const result: DashboardIndexStatusResult = {
      indexStats: { id: "primary", totalFiles: 0, totalChunks: 0, lastIndexedAt: null, lastFullScanAt: null, overflowCount: 0, lastError: null },
      vectorStats: { totalChunks: 0, totalFiles: 0, dimensions: 0, fragmentationRatio: 0 },
      skippedFiles: 0,
      pipelineProgress: { totalFiles: 0, processedFiles: 0, status: "idle" },
      providerStatus,
    };
    expect(result.providerStatus.health).toBe("unknown");
  });
});
