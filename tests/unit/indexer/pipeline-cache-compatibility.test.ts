import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Chunker } from "../../../src/indexer/chunker.js";
import { IndexPipeline } from "../../../src/indexer/pipeline.js";
import { PluginRegistry } from "../../../src/plugins/registry.js";
import { SqliteMetadataStore } from "../../../src/storage/metadata-store.js";
import type {
  EmbeddingConfig,
  EmbeddingProvider,
} from "../../../src/types/index.js";
import { InMemoryVectorStore } from "../storage/in-memory-vector-store.js";

const config: EmbeddingConfig = {
  provider: "test",
  model: "model-a",
  dimensions: 2,
  maxConcurrency: 1,
  batchSize: 16,
  retryCount: 0,
  retryBaseDelayMs: 0,
};
const content = "identical embedded text";

class FixedVectorProvider implements EmbeddingProvider {
  readonly dimensions = 2;
  calls = 0;

  constructor(private readonly vector: readonly number[]) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map(() => [...this.vector]);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe("pipeline embedding compatibility with real SQLite", () => {
  let directory: string;
  let metadataStore: SqliteMetadataStore;
  const registry = new PluginRegistry();
  const chunker = new Chunker(registry);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-cache-identity-"));
    metadataStore = new SqliteMetadataStore({
      databasePath: join(directory, "metadata.db"),
    });
    await metadataStore.initialize();
  });

  afterEach(async () => {
    await metadataStore.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function create(
    configured: EmbeddingConfig | undefined,
    vector: readonly number[],
    cacheSize = 10_000,
  ) {
    const vectorStore = new InMemoryVectorStore({ dimensions: 2 });
    await vectorStore.initialize();
    const provider = new FixedVectorProvider(vector);
    const options = {
      metadataStore,
      vectorStore,
      chunker,
      pluginRegistry: registry,
      embeddingProvider: provider,
      embeddingConfig: configured,
      embeddingCacheSize: cacheSize,
    };
    return { pipeline: new IndexPipeline(options), provider, vectorStore };
  }

  async function index(pipeline: IndexPipeline, filePath: string) {
    await pipeline.processEvents(
      [
        {
          type: "added",
          filePath,
          contentHash: filePath,
          detectedAt: "2026-10-23T00:00:00.000Z",
        },
      ],
      async () => content,
    );
  }

  it.each([
    ["model", { model: "model-b" }],
    ["provider", { provider: "openai-compat" }],
    ["endpoint", { baseUrl: "https://different.invalid/embeddings" }],
    ["output-affecting header", { headers: { "x-model-revision": "2" } }],
  ] satisfies ReadonlyArray<readonly [string, Partial<EmbeddingConfig>]>)(
    "does not reuse the first vector after changing %s",
    async (_name, change) => {
      // Given identical text embedded by the first configuration.
      const first = await create(config, [1, 0]);
      await index(first.pipeline, "first.txt");
      const second = await create({ ...config, ...change }, [0, 1]);
      // When the same text is indexed with a different same-dimension configuration.
      await index(second.pipeline, "second.txt");
      // Then the new model runs and its actual vector reaches storage.
      expect(second.provider.calls).toBe(1);
      expect((await second.vectorStore.search([0, 1], 1))[0]?.score).toBe(1);
    },
  );

  it("continues to hit L2 after reopening SQLite with unchanged configuration", async () => {
    // Given a persisted vector and a restarted pipeline with empty L1.
    const first = await create(config, [1, 0]);
    await index(first.pipeline, "first.txt");
    await metadataStore.close();
    metadataStore = new SqliteMetadataStore({
      databasePath: join(directory, "metadata.db"),
    });
    await metadataStore.initialize();
    const second = await create({ ...config }, [0, 1]);
    // When another file supplies exactly the same embedding input.
    await index(second.pipeline, "second.txt");
    // Then the persisted vector is reused, not recomputed.
    expect(second.provider.calls).toBe(0);
    expect((await second.vectorStore.search([1, 0], 1))[0]?.score).toBe(1);
  });

  it("continues to hit L1 when the persistent cache has been emptied", async () => {
    // Given a warm L1 and no remaining L2 entries.
    const current = await create(config, [1, 0]);
    await index(current.pipeline, "first.txt");
    await metadataStore.clearEmbeddings();
    // When another file has the same input and compatibility configuration.
    await index(current.pipeline, "second.txt");
    // Then no second embedding request is needed.
    expect(current.provider.calls).toBe(1);
  });

  it("safely misses legacy rows keyed only by chunk content hash", async () => {
    // Given a pre-fingerprint cache row from an unknown model.
    const chunks = await chunker.chunkFiles([
      { filePath: "first.txt", language: "text", content },
    ]);
    await metadataStore.setEmbeddings(
      chunks.map((chunk) => ({ hash: chunk.hash, vector: [1, 0] })),
    );
    const current = await create(config, [0, 1]);
    // When the configured model indexes that text.
    await index(current.pipeline, "second.txt");
    // Then legacy provenance is not assumed compatible.
    expect(current.provider.calls).toBe(1);
    expect((await current.vectorStore.search([0, 1], 1))[0]?.score).toBe(1);
  });

  it("does not share persistent vectors when compatibility configuration is unavailable", async () => {
    // Given a pipeline without a trustworthy embedding identity.
    const first = await create(undefined, [1, 0]);
    await index(first.pipeline, "first.txt");
    const second = await create(undefined, [0, 1]);
    // When a different provider instance indexes identical text.
    await index(second.pipeline, "second.txt");
    // Then dimensions alone cannot authorize a cache hit.
    expect(second.provider.calls).toBe(1);
    expect((await second.vectorStore.search([0, 1], 1))[0]?.score).toBe(1);
  });
});
