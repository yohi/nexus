import { describe, it, expect, vi } from "vitest";
import { buildSharedIndexStatus } from "../../../../src/server/tools/build-shared-index-status.js";
import type { IMetadataStore, IVectorStore, IIndexPipeline } from "../../../../src/types/index.js";

describe("buildSharedIndexStatus", () => {
  it("returns shared non-provider fields", async () => {
    const metadataStore = {
      getIndexStats: vi.fn().mockResolvedValue({
        id: "primary",
        totalFiles: 5,
        totalChunks: 10,
        lastIndexedAt: "2026-09-24T00:00:00.000Z",
        lastFullScanAt: null,
        overflowCount: 0,
        lastError: null,
      }),
      getDeadLetterEntries: vi.fn().mockResolvedValue([{ id: "dlq-1" }]),
      getStructuredIndexState: undefined,
    } as unknown as IMetadataStore;

    const vectorStore = {
      getStats: vi.fn().mockResolvedValue({ totalChunks: 10, totalFiles: 5, dimensions: 1024, fragmentationRatio: 0 }),
    } as unknown as IVectorStore;

    const pipeline = {
      getProgress: vi.fn().mockReturnValue({ totalFiles: 5, processedFiles: 5, status: "idle" }),
    } as unknown as IIndexPipeline;

    const result = await buildSharedIndexStatus(metadataStore, vectorStore, pipeline);

    expect(result.indexStats).not.toBeNull();
    expect(result.indexStats?.totalFiles).toBe(5);
    expect(result.pipelineProgress.status).toBe("idle");
  });
});
