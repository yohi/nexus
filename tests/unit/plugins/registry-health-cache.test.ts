import { describe, it, expect, vi } from "vitest";
import { PluginRegistry } from "../../../src/plugins/registry.js";

describe("PluginRegistry runtime-known health cache", () => {
  it("returns undefined for an unobserved provider", () => {
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider("ollama", { dimensions: 384, embed: vi.fn(), healthCheck: vi.fn() });
    expect(registry.getEmbeddingProviderHealth("ollama")).toBeUndefined();
  });

  it("caches healthy after a successful probe", async () => {
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider("ollama", {
      dimensions: 384,
      embed: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    });
    await registry.healthCheck();
    const health = registry.getEmbeddingProviderHealth("ollama");
    expect(health?.health).toBe("healthy");
    expect(health?.lastError).toBeNull();
  });

  it("invalidates cache when the active provider is switched", async () => {
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider("ollama", {
      dimensions: 384,
      embed: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    });
    registry.registerEmbeddingProvider("bedrock", {
      dimensions: 1024,
      embed: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    });
    await registry.healthCheck();
    expect(registry.getEmbeddingProviderHealth("ollama")).toBeDefined();
    registry.setActiveEmbeddingProvider("bedrock");
    expect(registry.getEmbeddingProviderHealth("ollama")).toBeUndefined();
  });

  it("does not restore provider A health when A completes after a concurrent B probe starts", async () => {
    let resolveA: ((healthy: boolean) => void) | undefined;
    const providerA = {
      dimensions: 384,
      embed: vi.fn(),
      healthCheck: vi.fn(() => new Promise<boolean>((resolve) => { resolveA = resolve; })),
    };
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider("A", providerA);
    registry.registerEmbeddingProvider("B", {
      dimensions: 1024,
      embed: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    });

    const probeA = registry.healthCheck();
    registry.setActiveEmbeddingProvider("B");
    const probeB = registry.healthCheck();
    await probeB;
    resolveA?.(false);
    await probeA;

    expect(registry.getEmbeddingProviderHealth("A")).toBeUndefined();
    expect(registry.getEmbeddingProviderHealth("B")).toEqual({ health: "healthy", lastError: null });
  });

  it("does not cache an old provider object's result after same-name re-registration", async () => {
    let resolveOld: ((healthy: boolean) => void) | undefined;
    const oldProvider = {
      dimensions: 384,
      embed: vi.fn(),
      healthCheck: vi.fn(() => new Promise<boolean>((resolve) => { resolveOld = resolve; })),
    };
    const newProvider = {
      dimensions: 384,
      embed: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider("A", oldProvider);

    const oldProbe = registry.healthCheck();
    registry.registerEmbeddingProvider("A", newProvider);
    resolveOld?.(true);
    await oldProbe;

    expect(registry.getEmbeddingProviderHealth("A")).toBeUndefined();
    await registry.healthCheck();
    expect(registry.getEmbeddingProviderHealth("A")).toEqual({ health: "healthy", lastError: null });
  });
});
