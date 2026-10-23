import { describe, expect, it } from "vitest";
import { createEmbeddingCacheIdentity } from "../../../src/indexer/embedding-cache-identity.js";
import type { EmbeddingConfig } from "../../../src/types/index.js";

const config: EmbeddingConfig = {
  provider: "openai-compat",
  model: "model-a",
  dimensions: 2,
  maxConcurrency: 1,
  batchSize: 16,
  retryCount: 0,
  retryBaseDelayMs: 0,
};

describe("embedding cache identity", () => {
  it("preserves compatibility for equivalent header casing", () => {
    const first = createEmbeddingCacheIdentity({
      ...config,
      headers: { "X-Model-Revision": "1" },
    });
    const second = createEmbeddingCacheIdentity({
      ...config,
      headers: { "x-model-revision": "1" },
    });
    expect(second.keyFor("same-content")).toBe(first.keyFor("same-content"));
  });

  it("separates case-colliding headers when insertion order changes the effective model revision", () => {
    const first = createEmbeddingCacheIdentity({
      ...config,
      headers: { "X-Model-Revision": "1", "x-model-revision": "2" },
    });
    const second = createEmbeddingCacheIdentity({
      ...config,
      headers: { "x-model-revision": "2", "X-Model-Revision": "1" },
    });
    expect(second.keyFor("same-content")).not.toBe(
      first.keyFor("same-content"),
    );
  });

  it("produces the same key for equivalent reordered configuration and headers", () => {
    const first = createEmbeddingCacheIdentity({
      ...config,
      headers: { z: "last", a: "first" },
    });
    const second = createEmbeddingCacheIdentity({
      headers: { a: "first", z: "last" },
      ...config,
    });
    expect(second.keyFor("content-hash")).toBe(first.keyFor("content-hash"));
  });

  it.each([
    { provider: "ollama" },
    { model: "model-b" },
    { dimensions: 3 },
    { baseUrl: "https://another.invalid/v1/embeddings" },
    { region: "eu-west-1" },
    { profile: "different-profile" },
    { apiKey: "fixture-credential" },
    { headers: { "x-model-revision": "different" } },
    { ollamaNumThread: 4 },
  ] satisfies ReadonlyArray<Partial<EmbeddingConfig>>)(
    "separates compatibility change %j",
    (change) => {
      const original =
        createEmbeddingCacheIdentity(config).keyFor("same-content");
      const changed = createEmbeddingCacheIdentity({
        ...config,
        ...change,
      }).keyFor("same-content");
      expect(changed).not.toBe(original);
    },
  );

  it("separates changes to the embedded-text normalization version", () => {
    const first = createEmbeddingCacheIdentity(config, "chunk-content-v1");
    const second = createEmbeddingCacheIdentity(config, "chunk-content-v2");
    expect(second.keyFor("same-content")).not.toBe(
      first.keyFor("same-content"),
    );
  });

  it("separates different input hashes without exposing input or credentials", () => {
    const identity = createEmbeddingCacheIdentity({
      ...config,
      apiKey: "fixture-credential",
      headers: { authorization: "fixture-header" },
    });
    const key = identity.keyFor("source-like-input");
    expect(key).toMatch(/^embedding:v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(key).not.toContain("source-like-input");
    expect(key).not.toContain("fixture-credential");
    expect(key).not.toContain("fixture-header");
    expect(key).not.toBe(identity.keyFor("different-input"));
  });

  it("keeps the construction-time configuration snapshot after caller mutation", () => {
    const mutable = { ...config, headers: { revision: "1" } };
    const identity = createEmbeddingCacheIdentity(mutable);
    const original = identity.keyFor("same-content");
    mutable.model = "model-b";
    mutable.headers.revision = "2";
    expect(identity.keyFor("same-content")).toBe(original);
  });

  it("preserves compatibility when only retry and scheduling settings change", () => {
    const original = createEmbeddingCacheIdentity(config);
    const tuned = createEmbeddingCacheIdentity({
      ...config,
      maxConcurrency: 8,
      batchSize: 32,
      retryCount: 3,
      retryBaseDelayMs: 250,
      timeoutMs: 10000,
      ollamaLockTimeoutMs: 5000,
    });
    expect(tuned.keyFor("same-content")).toBe(original.keyFor("same-content"));
  });
});
