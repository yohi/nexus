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

import { deriveStructuredReadiness } from "../../../src/utils/readiness.js";

describe("deriveStructuredReadiness", () => {
  it("returns Ready for idle status", () => {
    expect(deriveStructuredReadiness({ status: "idle", lastIndexedAt: "2026-09-24T00:00:00.000Z" } as any)).toBe("Ready");
  });

  it("returns Indexing for building status", () => {
    expect(deriveStructuredReadiness({ status: "building" } as any)).toBe("Indexing");
  });

  it("returns Failed for failed status", () => {
    expect(deriveStructuredReadiness({ status: "failed", error: "crash" } as any)).toBe("Failed");
  });

  it("returns Reindex required for reindex_required status", () => {
    expect(deriveStructuredReadiness({ status: "reindex_required" } as any)).toBe("Reindex required");
  });

  it("returns Unsupported for unsupported status", () => {
    expect(deriveStructuredReadiness({ status: "unsupported", reason: "no tree-sitter" } as any)).toBe("Unsupported");
  });

  it("returns Unavailable when structuredIndex is undefined", () => {
    expect(deriveStructuredReadiness(undefined)).toBe("Unavailable");
  });
});
