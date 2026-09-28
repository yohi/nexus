import { describe, it, expect } from "vitest";
import { formatIndexingProgress } from "../../src/utils/metrics.js";

describe("formatIndexingProgress", () => {
  it("shows processed / total when total is known and non-zero", () => {
    expect(formatIndexingProgress(42, 100)).toBe("Indexing: 42 / 100 files");
  });

  it("shows only processed count when total is zero", () => {
    expect(formatIndexingProgress(4857, 0)).toBe("Indexing: 4857 files (total unknown)");
  });

  it("shows only processed count when processed exceeds total", () => {
    expect(formatIndexingProgress(10, 5)).toBe("Indexing: 10 files");
  });

  it("handles zero processed with zero total", () => {
    expect(formatIndexingProgress(0, 0)).toBe("Indexing: 0 files");
  });
});
