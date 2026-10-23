import { createHash } from "node:crypto";
import type { EmbeddingConfig } from "../types/index.js";

export interface EmbeddingCacheIdentity {
  readonly keyFor: (contentHash: string) => string;
}

export function createEmbeddingCacheIdentity(
  config: Readonly<EmbeddingConfig>,
  textVersion = "chunk-content-v1",
): EmbeddingCacheIdentity {
  const effectiveHeaders = new Map<string, string>();
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    effectiveHeaders.set(name.toLowerCase(), value);
  }
  const headers = [...effectiveHeaders].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        schema: "embedding-compatibility-v1",
        textVersion,
        provider: config.provider,
        model: config.model,
        dimensions: config.dimensions,
        baseUrl: config.baseUrl ?? null,
        region: config.region ?? null,
        profile: config.profile ?? null,
        apiKey: config.apiKey ?? null,
        headers,
        ollamaNumThread: config.ollamaNumThread ?? null,
        requestSemanticsVersion: 1,
      }),
    )
    .digest("hex");

  return Object.freeze({
    keyFor: (contentHash: string) =>
      `embedding:v1:${fingerprint}:${createHash("sha256").update(contentHash).digest("hex")}`,
  });
}
