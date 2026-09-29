import { describe, it, expect, vi } from "vitest";
import { buildDashboardIndexStatusSnapshot } from "../../../../src/server/tools/build-dashboard-index-status-snapshot.js";
import type { IMetadataStore, IVectorStore, IIndexPipeline } from "../../../../src/types/index.js";
import { PluginRegistry } from "../../../../src/plugins/registry.js";
import { BedrockEmbeddingProvider } from "../../../../src/plugins/embeddings/bedrock.js";

describe("buildDashboardIndexStatusSnapshot", () => {
  it("does not call pluginRegistry.healthCheck and returns unknown when no observation exists", async () => {
    const metadataStore = {
      getIndexStats: vi.fn().mockResolvedValue({
        id: "primary", totalFiles: 0, totalChunks: 0, lastIndexedAt: null, lastFullScanAt: null, overflowCount: 0, lastError: null,
      }),
      getDeadLetterEntries: vi.fn().mockResolvedValue([]),
      getStructuredIndexState: undefined,
    } as unknown as IMetadataStore;
    const vectorStore = { getStats: vi.fn().mockResolvedValue({ totalChunks: 0, totalFiles: 0, dimensions: 0, fragmentationRatio: 0 }) } as unknown as IVectorStore;
    const pipeline = { getProgress: vi.fn().mockReturnValue({ totalFiles: 0, processedFiles: 0, status: "idle" }) } as unknown as IIndexPipeline;
    const pluginRegistry = new PluginRegistry();
    const bedrockSend = vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [0], inputTextTokenCount: 1 })),
    });
    const provider = new BedrockEmbeddingProvider(
      {
        model: "amazon.titan-embed-text-v2:0",
        dimensions: 1,
        maxConcurrency: 1,
        retryCount: 0,
        retryBaseDelayMs: 0,
      },
      { client: { send: bedrockSend }, sleep: vi.fn().mockResolvedValue(undefined) },
    );
    const providerHealthCheck = vi.spyOn(provider, "healthCheck");
    pluginRegistry.registerEmbeddingProvider("bedrock", provider);
    pluginRegistry.setActiveEmbeddingProvider("bedrock");
    const registryHealthCheck = vi.spyOn(pluginRegistry, "healthCheck");

    const result = await buildDashboardIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline);

    expect(registryHealthCheck).not.toHaveBeenCalled();
    expect(providerHealthCheck).not.toHaveBeenCalled();
    expect(bedrockSend).not.toHaveBeenCalled();
    expect(result.providerStatus).toEqual({ providerName: "bedrock", health: "unknown", lastError: null });
    expect(result).not.toHaveProperty("pluginHealth");
  });
});
