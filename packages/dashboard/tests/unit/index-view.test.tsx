import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { IndexView } from "../../src/components/index-view.js";

describe("IndexView", () => {
  afterEach(() => cleanup());

  it("renders vector, active pipeline, and structured-index details", () => {
    const snapshot = {
      indexStats: { totalFiles: 4, totalChunks: 8, lastIndexedAt: "2026-09-28T00:00:00.000Z", lastError: null },
      vectorStats: { totalChunks: 7, totalFiles: 3, dimensions: 1024, fragmentationRatio: 0.25 },
      skippedFiles: 1,
      pipelineProgress: { totalFiles: 4, processedFiles: 2, status: "running", currentFile: "src/main.ts", lastError: null },
      structuredIndex: { status: "building", totalSymbols: 6, exactFiles: 3, pendingFiles: 1, schemaVersion: 2, targetSchemaVersion: 3, rebuildState: "staging", totalFiles: 4, degradedFiles: 0, lastErrorCode: null, reindexRequired: false },
      providerStatus: { providerName: "bedrock", health: "unknown" },
    };

    const { container } = render(<IndexView snapshot={snapshot as never} />);

    expect(container.textContent).toContain("Vector chunks: 7");
    expect(container.textContent).toContain("Current file: src/main.ts");
    expect(container.textContent).toContain("Structured symbols: 6");
    expect(container.textContent).toContain("Pending files: 1");
    expect(container.textContent).toContain("Schema: 2 / 3");
    expect(container.textContent).toContain("Rebuild state: staging");
  });
});
