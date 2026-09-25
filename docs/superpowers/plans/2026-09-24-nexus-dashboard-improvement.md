# Nexus Dashboard Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the built-in, single-project Ink dashboard into a read-only Live Operations Dashboard that answers what needs attention now and what Nexus is doing now, using a side-effect-free `/status` snapshot and a five-minute in-memory metrics history.

**Architecture:** The runtime exposes `GET /status` on the existing loopback metrics server. The endpoint is built from a shared non-provider collector that both the MCP `index_status` tool and the dashboard consume, but the dashboard path reads only a cached runtime-known provider health and never probes the active provider. The dashboard package mirrors the status type locally and manages its own endpoint discovery, status polling, metrics history, views, and keyboard navigation. Prometheus/Grafana remain responsible for long-term observability.

**Tech Stack:** Node.js ESM, TypeScript, Ink 5.x + React 18.3.1, Vitest, `@testing-library/react`, prom-client.

## Global Constraints

- Preserve Node.js `>=24.0.0` from `package.json`.
- Use the repository's npm/package-lock dependency set; do not add UI routing libraries.
- The dashboard must not auto-start a missing Nexus runtime; it waits with `Runtime unavailable`.
- The dashboard must not trigger active embedding provider probes or billable provider requests for refreshes.
- `index_status` remains the canonical public interface; the dashboard endpoint is an internal/local transport sharing the non-provider snapshot fields.
- No duplicate readiness logic is implemented for the dashboard.
- No dashboard-specific aggregate health score (`Healthy`/`Degraded`/`Critical`) is introduced.
- No project-level agent configuration files are created.
- No absolute paths, credentials, or generated local state are committed.
- All commits follow Conventional Commits in Japanese.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/server/tools/build-shared-index-status.ts` | New. Side-effect-free collector for `indexStats`, `vectorStats`, `skippedFiles`, `pipelineProgress`, and `structuredIndex` shared by the MCP tool and the dashboard. |
| `src/server/tools/build-dashboard-index-status-snapshot.ts` | New. Dashboard-only builder that wraps the shared collector and attaches `providerStatus` from the registry's runtime-known health cache without probing. |
| `src/server/tools/index-status.ts` | Modify. Refactor `executeIndexStatus()` to call the shared collector and attach the probed `pluginHealth`. Keep `IndexStatusResult` and `StructuredIndexStatus` exports. |
| `src/plugins/registry.ts` | Modify. Add runtime-known health cache, in-flight probe attribution guard, `getEmbeddingProviderHealth(name)`, and invalidation on provider re-registration or active-provider switch. |
| `src/observability/dashboard-status-endpoint.ts` | New. `createDashboardStatusEndpoint(buildSnapshot)` returning a `GET /status` handler that returns JSON `{ status: "ok", snapshot }` or `{ status: "error", error }`. |
| `src/observability/metrics-server.ts` | Modify. Accept an optional `dashboardStatusEndpoint` and route `/status` before the 404 handler on the existing loopback listener. |
| `src/server/index.ts` | Modify. Wire `buildDashboardIndexStatusSnapshot(...)` into `MetricsHttpServer` at line ~161. |
| `packages/dashboard/src/types/dashboard-index-status.ts` | New. Minimal read-only mirror of `DashboardIndexStatusResult` and `DashboardProviderStatus`; no imports from root `src/`. |
| `packages/dashboard/src/hooks/use-metrics.ts` | Modify. Accept `port: number | null` and `enabled: boolean`; emit uniform `PollResult<MetricsJSON[]>` with `generation`. |
| `packages/dashboard/src/hooks/use-dashboard-status.ts` | New. Poll `GET /status` at an independent cadence and expose `PollResult<DashboardIndexStatusResult>`. |
| `packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts` | New. Manage fixed-port vs discovery mode, rediscovery every 5 s, port changes, and combined connection state. |
| `packages/dashboard/src/hooks/use-metrics-history.ts` | New. Maintain per-series five-minute in-memory metric samples and expose window deltas. |
| `packages/dashboard/src/utils/value-state.ts` | New. `ValueState<T>` discriminated model for all display-facing extraction. |
| `packages/dashboard/src/utils/readiness.ts` | New. Derive Main/Vector and Structured readiness strictly from canonical fields. |
| `packages/dashboard/src/utils/attention.ts` | New. Derive Attention items from canonical state, connectivity, and telemetry window deltas. |
| `packages/dashboard/src/utils/sparkline.ts` | New. Pure ASCII sparkline renderer from a numeric series. |
| `packages/dashboard/src/utils/metrics-history.ts` | New. Pure `MetricsHistory` class with per-label series, histogram components, baselines, reset handling, and `observePoll` generation gaps. |
| `eslint.config.mjs` | Modify. Dashboard-specific lint block before first dashboard lint. |
| `packages/dashboard/tests/integration/helpers.ts` | New. ESM-safe integration test helper for spawning the root Nexus CLI and reading `metrics.port`. |
| `packages/dashboard/src/components/navigation.tsx` | New. Keyboard navigation. |
| `packages/dashboard/src/components/attention-panel.tsx` | New. Attention rendering. |
| `packages/dashboard/src/components/overview-view.tsx` | New. Overview view and `LayoutPolicy` type. |
| `packages/dashboard/src/components/index-view.tsx` | New. Index view. |
| `packages/dashboard/src/components/retrieval-view.tsx` | New. Retrieval view. |
| `packages/dashboard/src/components/provider-view.tsx` | New. Provider view. |
| `packages/dashboard/src/components/diagnostics-view.tsx` | New. Diagnostics view. |
| `packages/dashboard/src/components/compact-index-panel.tsx` | New. Compact index panel. |
| `packages/dashboard/src/components/compact-retrieval-panel.tsx` | New. Compact retrieval panel. |
| `packages/dashboard/src/components/compact-provider-panel.tsx` | New. Compact provider panel. |
| `packages/dashboard/src/components/compact-queue-panel.tsx` | New. Compact queue/DLQ panel. |
| `packages/dashboard/src/app.tsx`, `packages/dashboard/src/cli.ts` | Modify. Wire discovery, polling, history, views, navigation, and CLI startup behavior. |
| `packages/dashboard/src/components/queue-panel.tsx` | Delete. Superseded queue panel. |
| `packages/dashboard/src/components/throughput-panel.tsx` | Delete. Superseded throughput panel. |
| `packages/dashboard/src/components/dlq-panel.tsx` | Delete. Superseded DLQ panel. |
| `packages/dashboard/src/components/metric-panel.tsx` | Delete. Superseded metric panel. |
| `packages/dashboard/src/utils/metrics.ts` | Modify; delete if empty. Remove helpers made unused by the new views. |
| `tests/unit/server/tools/build-shared-index-status.test.ts` | New shared snapshot collector test. |
| `tests/unit/plugins/registry-health-cache.test.ts` | New provider health cache test. |
| `tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts` | New snapshot builder and no-probe regression test. |
| `tests/unit/observability/dashboard-status-endpoint.test.ts` | New endpoint semantics test. |
| `packages/dashboard/tests/unit/types/dashboard-index-status.test.ts` | New Dashboard status type test. |
| `packages/dashboard/tests/unit/use-metrics.test.tsx` | Modify polling contract regression tests. |
| `packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx` | New status polling contract tests. |
| `packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx` | New discovery and fixed-port tests. |
| `packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx` | New bounded history and port-isolation tests. |
| `packages/dashboard/tests/unit/utils/sparkline.test.ts` | New sparkline tests. |
| `packages/dashboard/tests/unit/utils/value-state.test.ts` | New missing-metric extraction tests. |
| `packages/dashboard/tests/unit/utils/readiness.test.ts` | New canonical readiness tests. |
| `packages/dashboard/tests/unit/utils/attention.test.ts` | New Attention derivation tests. |
| `packages/dashboard/tests/unit/navigation.test.tsx` | New keyboard navigation tests. |
| `packages/dashboard/tests/unit/overview-view.test.tsx` | New overview and layout degradation tests. |
| `packages/dashboard/tests/unit/throughput-panel.test.tsx` | Delete if present; Task 9 records whether it exists before removal. |
| `packages/dashboard/tests/integration/cli.test.ts` | Modify. Cover no-runtime startup and reconnect after a runtime restart on a changed port. |

---

### Task 1: Extract The Shared Non-Provider Snapshot Collector

**Files:**

- Create: `src/server/tools/build-shared-index-status.ts`
- Modify: `src/server/tools/index-status.ts`
- Test: `tests/unit/server/tools/build-shared-index-status.test.ts`

**Interfaces:**

- Consumes: `IMetadataStore`, `IVectorStore`, `IIndexPipeline`, and the existing `StructuredIndexState` type.
- Produces: `buildSharedIndexStatus(metadataStore, vectorStore, pipeline): Promise<SharedIndexStatus>` where `SharedIndexStatus` contains `indexStats`, `vectorStats`, `skippedFiles`, `pipelineProgress`, and `structuredIndex`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/server/tools/build-shared-index-status.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the shared collector**

`src/server/tools/build-shared-index-status.ts`:

```ts
import type { IMetadataStore, IVectorStore, PipelineProgress, IIndexPipeline } from "../../types/index.js";
import type { StructuredIndexState } from "../../storage/interfaces/structured-catalog.js";

export interface StructuredIndexStatus {
  schemaVersion: number | null;
  targetSchemaVersion: number;
  status: "idle" | "building" | "failed" | "reindex_required" | "unsupported";
  rebuildState: string | null;
  lastErrorCode: string | null;
  totalFiles: number;
  totalSymbols: number;
  exactFiles: number;
  degradedFiles: number;
  pendingFiles: number;
  reindexRequired: boolean;
}

export interface SharedIndexStatus {
  indexStats: Awaited<ReturnType<IMetadataStore["getIndexStats"]>>;
  vectorStats: Awaited<ReturnType<IVectorStore["getStats"]>>;
  skippedFiles: number;
  pipelineProgress: PipelineProgress;
  structuredIndex?: StructuredIndexStatus;
}

const deriveStructuredStatus = (state: StructuredIndexState): StructuredIndexStatus["status"] => {
  if (state.schemaVersion === null) return "reindex_required";
  if (state.schemaVersion !== 1) return "unsupported";
  if (state.rebuildState === "building") return "building";
  if (state.rebuildState === "failed") return "failed";
  return "idle";
};

export const buildSharedIndexStatus = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pipeline: IIndexPipeline,
): Promise<SharedIndexStatus> => {
  const structuredStatePromise =
    metadataStore.getStructuredIndexState === undefined
      ? Promise.resolve(undefined)
      : metadataStore.getStructuredIndexState();

  const [indexStats, vectorStats, deadLetterEntries, structuredState] = await Promise.all([
    metadataStore.getIndexStats(),
    vectorStore.getStats(),
    metadataStore.getDeadLetterEntries(),
    structuredStatePromise.catch(() => undefined),
  ]);

  const structuredIndex: StructuredIndexStatus | undefined =
    structuredState === undefined
      ? undefined
      : {
          schemaVersion: structuredState.schemaVersion,
          targetSchemaVersion: 1,
          status: deriveStructuredStatus(structuredState),
          rebuildState: structuredState.rebuildState,
          lastErrorCode: structuredState.lastErrorCode,
          totalFiles: structuredState.counts.activeFiles,
          totalSymbols: structuredState.counts.activeSymbols,
          exactFiles: structuredState.counts.activeFiles,
          degradedFiles: 0,
          pendingFiles: structuredState.counts.pendingFiles,
          reindexRequired: structuredState.reindexRequired,
        };

  return {
    indexStats,
    vectorStats,
    skippedFiles: deadLetterEntries.length,
    pipelineProgress: pipeline.getProgress(),
    structuredIndex,
  };
};
```

- [ ] **Step 4: Refactor `index-status.ts` to use the shared collector**

`src/server/tools/index-status.ts` becomes:

```ts
import type { PluginRegistry } from "../../plugins/registry.js";
import type { IMetadataStore, IVectorStore, IIndexPipeline, PipelineProgress } from "../../types/index.js";
import { buildSharedIndexStatus } from "./build-shared-index-status.js";
import type { StructuredIndexStatus } from "./build-shared-index-status.js";

export interface IndexStatusResult {
  indexStats: Awaited<ReturnType<IMetadataStore["getIndexStats"]>>;
  vectorStats: Awaited<ReturnType<IVectorStore["getStats"]>>;
  skippedFiles: number;
  pluginHealth: Awaited<ReturnType<PluginRegistry["healthCheck"]>>;
  pipelineProgress: PipelineProgress;
  structuredIndex?: StructuredIndexStatus;
}

export const executeIndexStatus = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pluginRegistry: PluginRegistry,
  pipeline: IIndexPipeline,
): Promise<IndexStatusResult> => {
  const shared = await buildSharedIndexStatus(metadataStore, vectorStore, pipeline);
  const pluginHealth = await pluginRegistry.healthCheck();
  return { ...shared, pluginHealth };
};

export type { StructuredIndexStatus };
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/server/tools/build-shared-index-status.test.ts tests/unit/server/tools/index-status.test.ts`

Expected: PASS.

- [ ] **Step 6: Run static checks**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add src/server/tools/build-shared-index-status.ts src/server/tools/index-status.ts tests/unit/server/tools/build-shared-index-status.test.ts
GIT_MASTER=1 git commit -m "refactor: 非プロバイダー snapshot 収集を shared collector へ分離"
```

---

### Task 2: Add Runtime-Known Provider Health Cache To PluginRegistry

**Files:**

- Modify: `src/plugins/registry.ts`
- Test: `tests/unit/plugins/registry-health-cache.test.ts`

**Interfaces:**

- Consumes: Existing `PluginRegistry.healthCheck()` and `EmbeddingProviderRegistry`.
- Produces: `getEmbeddingProviderHealth(name: string): KnownHealthEntry | undefined`; internal cache updated only by `healthCheck()` with in-flight attribution guard.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { PluginRegistry } from "../../../../src/plugins/registry.js";

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/plugins/registry-health-cache.test.ts`

Expected: FAIL — `getEmbeddingProviderHealth` not found.

- [ ] **Step 3: Implement the cache and attribution guard**

Replace the `PluginRegistry` class in `src/plugins/registry.ts` with:

```ts
export type RuntimeKnownHealth = "healthy" | "unhealthy" | "unknown";

export interface KnownHealthEntry {
  health: RuntimeKnownHealth;
  lastError: string | null;
}

export class PluginRegistry {
  private readonly languages = new LanguageRegistry();
  private readonly embeddings = new EmbeddingProviderRegistry();
  private readonly knownHealth = new Map<string, KnownHealthEntry>();
  private activeProbeName: string | null = null;

  registerLanguage(plugin: LanguagePlugin): void {
    this.languages.register(plugin);
  }

  getLanguagePlugin(filePath: string): LanguagePlugin | undefined {
    return this.languages.findForFile(filePath);
  }

  registerEmbeddingProvider(name: string, provider: EmbeddingProvider): void {
    this.embeddings.register(name, provider);
    this.knownHealth.delete(name);
  }

  getEmbeddingProvider(): EmbeddingProvider | undefined {
    return this.embeddings.getActive();
  }

  setActiveEmbeddingProvider(name: string): void {
    this.embeddings.setActive(name);
    this.knownHealth.clear();
  }

  getActiveEmbeddingProviderName(): string | undefined {
    return this.embeddings.getActiveName();
  }

  getRegisteredEmbeddingProviderNames(): string[] {
    return this.embeddings.getRegisteredProviderNames();
  }

  getEmbeddingProviderHealth(name: string): KnownHealthEntry | undefined {
    return this.knownHealth.get(name);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const activeProvider = this.embeddings.getActive();
    const activeProviderName = this.embeddings.getActiveName();
    this.activeProbeName = activeProviderName ?? null;
    let embeddingHealthy = false;
    let probeError: string | null = null;

    if (activeProvider) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        embeddingHealthy = await Promise.race([
          activeProvider.healthCheck(),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              resolve(false);
            }, REGISTRY_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        embeddingHealthy = false;
        probeError = err instanceof Error ? err.message : String(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (this.embeddings.getActiveName() === this.activeProbeName) {
      if (activeProviderName !== undefined) {
        if (embeddingHealthy) {
          this.knownHealth.set(activeProviderName, { health: "healthy", lastError: null });
        } else {
          this.knownHealth.set(activeProviderName, { health: "unhealthy", lastError: probeError });
        }
      }
    }

    const registeredLanguages = this.languages.list().map((plugin) => plugin.languageId);
    const languagesHealthy = registeredLanguages.length > 0;

    return {
      languages: {
        registered: registeredLanguages,
        healthy: languagesHealthy,
      },
      embeddings: {
        provider: activeProviderName,
        healthy: embeddingHealthy,
      },
      healthy: languagesHealthy && embeddingHealthy,
      isOperational: languagesHealthy,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/plugins/registry-health-cache.test.ts`

Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add src/plugins/registry.ts tests/unit/plugins/registry-health-cache.test.ts
GIT_MASTER=1 git commit -m "feat: PluginRegistry にランタイム既知のヘルスキャッシュを追加"
```

---

### Task 3: Build The Dashboard Snapshot And Refactor MCP `index_status`

**Files:**

- Create: `src/server/tools/build-dashboard-index-status-snapshot.ts`
- Modify: `src/server/tools/index-status.ts` (add re-export of dashboard types)
- Test: `tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts`

**Interfaces:**

- Consumes: `buildSharedIndexStatus` from Task 1; `PluginRegistry.getActiveEmbeddingProviderName()` and `getEmbeddingProviderHealth(name)` from Task 2.
- Produces: `buildDashboardIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline): Promise<DashboardIndexStatusResult>`; `DashboardIndexStatusResult = Omit<IndexStatusResult, "pluginHealth"> & { providerStatus: DashboardProviderStatus }`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dashboard builder**

`src/server/tools/build-dashboard-index-status-snapshot.ts`:

```ts
import type { IMetadataStore, IVectorStore, IIndexPipeline } from "../../types/index.js";
import type { PluginRegistry, RuntimeKnownHealth } from "../../plugins/registry.js";
import { buildSharedIndexStatus, type SharedIndexStatus } from "./build-shared-index-status.js";

export type { RuntimeKnownHealth };

export interface DashboardProviderStatus {
  providerName: string | null;
  health: RuntimeKnownHealth;
  lastError?: string | null;
}

export type DashboardIndexStatusResult = Omit<import("./index-status.js").IndexStatusResult, "pluginHealth"> & {
  providerStatus: DashboardProviderStatus;
};

export const buildDashboardIndexStatusSnapshot = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pluginRegistry: PluginRegistry,
  pipeline: IIndexPipeline,
): Promise<DashboardIndexStatusResult> => {
  const shared: SharedIndexStatus = await buildSharedIndexStatus(metadataStore, vectorStore, pipeline);
  const activeName: string | null = pluginRegistry.getActiveEmbeddingProviderName() ?? null;
  let providerStatus: DashboardProviderStatus;

  if (activeName === null) {
    providerStatus = { providerName: null, health: "unknown", lastError: null };
  } else {
    const known = pluginRegistry.getEmbeddingProviderHealth(activeName);
    if (known === undefined) {
      providerStatus = { providerName: activeName, health: "unknown", lastError: null };
    } else {
      providerStatus = { providerName: activeName, health: known.health, lastError: known.lastError ?? null };
    }
  }

  return { ...shared, providerStatus } as DashboardIndexStatusResult;
};
```

- [ ] **Step 4: Re-export dashboard types from `index-status.ts`**

Append to `src/server/tools/index-status.ts`:

```ts
export type { DashboardIndexStatusResult, DashboardProviderStatus } from "./build-dashboard-index-status-snapshot.js";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts`

Expected: PASS.

- [ ] **Step 6: Run static checks**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add src/server/tools/build-dashboard-index-status-snapshot.ts src/server/tools/index-status.ts tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts
GIT_MASTER=1 git commit -m "feat: dashboard 用 side-effect-free snapshot ビルダーを追加"
```

---

### Task 4: Add The Dashboard `/status` Endpoint And Wire It

**Files:**

- Create: `src/observability/dashboard-status-endpoint.ts`
- Modify: `src/observability/metrics-server.ts`
- Modify: `src/server/index.ts`
- Test: `tests/unit/observability/dashboard-status-endpoint.test.ts`

**Interfaces:**

- Consumes: `buildDashboardIndexStatusSnapshot()` from Task 3; existing `MetricsHttpServer` loopback server.
- Produces: `createDashboardStatusEndpoint(buildSnapshot): { handler(req, res): Promise<void> }`; `MetricsHttpServer` constructor accepts optional `dashboardStatusEndpoint` and routes `/status` before 404.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDashboardStatusEndpoint } from "../../../src/observability/dashboard-status-endpoint.js";
import type { DashboardIndexStatusResult } from "../../../src/server/tools/build-dashboard-index-status-snapshot.js";

const createStubRes = () => {
  let statusCode = 0;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    writeHead(code: number, h: Record<string, string>) { statusCode = code; Object.assign(headers, h); },
    write(chunk: string) { if (chunk) chunks.push(chunk); },
    end(body?: string) { if (body) chunks.push(body); },
  } as unknown as ServerResponse;
  return { res, get statusCode() { return statusCode; }, get headers() { return headers; }, get body() { return chunks.join(""); } };
};

describe("createDashboardStatusEndpoint", () => {
  it("returns 405 for non-GET requests", async () => {
    const builder = vi.fn();
    const endpoint = createDashboardStatusEndpoint(builder);
    const stub = createStubRes();

    await endpoint.handler({ method: "POST", url: "/status" } as IncomingMessage, stub.res);

    expect(stub.statusCode).toBe(405);
    expect(JSON.parse(stub.body)).toEqual({ status: "error", error: "Method not allowed" });
  });

  it("returns snapshot JSON on GET /status", async () => {
    const snapshot: DashboardIndexStatusResult = {
      indexStats: { id: "primary", totalFiles: 0, totalChunks: 0, lastIndexedAt: null, lastFullScanAt: null, overflowCount: 0, lastError: null },
      vectorStats: { totalChunks: 0, totalFiles: 0, dimensions: 0, fragmentationRatio: 0 },
      skippedFiles: 0,
      pipelineProgress: { totalFiles: 0, processedFiles: 0, status: "idle" },
      providerStatus: { providerName: null, health: "unknown", lastError: null },
    };
    const builder = vi.fn().mockResolvedValue(snapshot);
    const endpoint = createDashboardStatusEndpoint(builder);
    const stub = createStubRes();

    await endpoint.handler({ method: "GET", url: "/status" } as IncomingMessage, stub.res);

    expect(stub.statusCode).toBe(200);
    expect(stub.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(stub.body)).toEqual({ status: "ok", snapshot });
  });

});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/observability/dashboard-status-endpoint.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the endpoint**

`src/observability/dashboard-status-endpoint.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardIndexStatusResult } from "../server/tools/build-dashboard-index-status-snapshot.js";

export interface DashboardStatusEndpoint {
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createDashboardStatusEndpoint(
  buildSnapshot: () => Promise<DashboardIndexStatusResult>,
): DashboardStatusEndpoint {
  return {
    async handler(req, res) {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: "Method not allowed" }));
        return;
      }
      if (req.url !== "/status") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: "Not found" }));
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", snapshot }, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: msg }));
      }
    },
  };
}
```

- [ ] **Step 4: Mount the endpoint in `MetricsHttpServer`**

Modify `src/observability/metrics-server.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { Registry } from "prom-client";
import type { DashboardStatusEndpoint } from "./dashboard-status-endpoint.js";

export class MetricsHttpServer {
  private server: Server | undefined;
  private listening = false;

  constructor(
    private readonly registry: Registry,
    private readonly dashboardStatusEndpoint?: DashboardStatusEndpoint,
  ) {}

  async start(port: number, host = "127.0.0.1"): Promise<void> {
    if (this.listening || this.server) {
      return;
    }

    const reg = this.registry;
    const statusEndpoint = this.dashboardStatusEndpoint;
    const server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.url === "/status" && statusEndpoint) {
            await statusEndpoint.handler(req, res);
            return;
          }
          if (req.url === "/metrics") {
            const metrics = await reg.metrics();
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end(metrics);
          } else if (req.url === "/metrics/json") {
            const json = await reg.getMetricsAsJSON();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(json));
          } else if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", error: "Not found" }));
          }
        } catch (err) {
          console.error("[Nexus Metrics] Request failed:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ status: "error", error: "Internal server error" }));
        }
      })().catch((err) => {
        console.error("[Nexus Metrics] Unhandled request error:", err);
      });
    });

    return new Promise<void>((resolve, reject) => {
      const portNum = port;
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[Nexus] Metrics port ${portNum} already in use. Metrics HTTP server disabled.`);
          this.listening = false;
          resolve();
        } else {
          reject(err);
        }
      });

      server.listen(portNum, host, () => {
        this.server = server;
        this.listening = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const currentServer = this.server;
    if (!currentServer || !this.listening) {
      this.server = undefined;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      currentServer.close((err) => {
        this.server = undefined;
        this.listening = false;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  isListening(): boolean {
    return this.listening;
  }

  getPort(): number | undefined {
    if (!this.server || !this.listening) {
      return undefined;
    }
    const address = this.server.address();
    if (!address || typeof address === "string") {
      return undefined;
    }
    return address.port;
  }
}
```

- [ ] **Step 5: Wire the builder in `src/server/index.ts`**

Add the imports to the module's top-level import block. At the existing metrics-server initialization near line 161, replace the `MetricsHttpServer` construction with the following runtime code:

```ts
import { createDashboardStatusEndpoint } from "../observability/dashboard-status-endpoint.js";
import { buildDashboardIndexStatusSnapshot } from "../server/tools/build-dashboard-index-status-snapshot.js";

const preferredPort = options.metricsPort ?? 0;
const dashboardStatusEndpoint = createDashboardStatusEndpoint(() =>
  buildDashboardIndexStatusSnapshot(
    options.metadataStore,
    options.vectorStore,
    options.pluginRegistry,
    options.pipeline,
  ),
);
metricsServer = options.metricsCollectorRegistry
  ? new MetricsHttpServer(options.metricsCollectorRegistry, dashboardStatusEndpoint)
  : null;
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/observability/dashboard-status-endpoint.test.ts`

Expected: PASS.

- [ ] **Step 7: Run static checks**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
GIT_MASTER=1 git add src/observability/dashboard-status-endpoint.ts src/observability/metrics-server.ts src/server/index.ts tests/unit/observability/dashboard-status-endpoint.test.ts
GIT_MASTER=1 git commit -m "feat: dashboard /status エンドポイントをループバック metrics サーバーに追加"
```

---

### Task 5: Add Dashboard-side Types

**Files:**

- Create: `packages/dashboard/src/types/dashboard-index-status.ts`
- Test: `packages/dashboard/tests/unit/types/dashboard-index-status.test.ts`

**Interfaces:**

- Consumes: `/status` JSON contract from Task 4.
- Produces: minimal read-only mirror of `DashboardIndexStatusResult` and `DashboardProviderStatus` with no imports from root `src/`.

- [ ] **Step 1: Write the failing test**

`packages/dashboard/tests/unit/types/dashboard-index-status.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/types/dashboard-index-status.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the types**

`packages/dashboard/src/types/dashboard-index-status.ts`:

```ts
export type RuntimeKnownHealth = "healthy" | "unhealthy" | "unknown";

export interface DashboardProviderStatus {
  providerName: string | null;
  health: RuntimeKnownHealth;
  lastError?: string | null;
}

export interface DashboardIndexStats {
  id: string;
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: string | null;
  lastFullScanAt: string | null;
  overflowCount: number;
  lastError: string | null;
}

export interface DashboardVectorStats {
  totalChunks: number;
  totalFiles: number;
  dimensions: number;
  fragmentationRatio: number;
}

export interface DashboardPipelineProgress {
  totalFiles: number;
  processedFiles: number;
  status: string;
  currentFile?: string | null;
  lastError?: string | null;
}

export interface DashboardStructuredIndex {
  schemaVersion: number | null;
  targetSchemaVersion: number;
  status: "idle" | "building" | "failed" | "reindex_required" | "unsupported";
  rebuildState: string | null;
  lastErrorCode: string | null;
  totalFiles: number;
  totalSymbols: number;
  exactFiles: number;
  degradedFiles: number;
  pendingFiles: number;
  reindexRequired: boolean;
}

export interface DashboardIndexStatusResult {
  indexStats: DashboardIndexStats | null;
  vectorStats: DashboardVectorStats;
  skippedFiles: number;
  pipelineProgress: DashboardPipelineProgress;
  structuredIndex?: DashboardStructuredIndex;
  providerStatus: DashboardProviderStatus;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/types/dashboard-index-status.test.ts`

Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/types/dashboard-index-status.ts packages/dashboard/tests/unit/types/dashboard-index-status.test.ts
GIT_MASTER=1 git commit -m "feat(dashboard): dashboard 用 status 型定義を追加"
```

---

### Task 5a: Add Dashboard ESLint Configuration Before First Dashboard Lint

**Files:**

- Modify: `eslint.config.mjs`

**Interfaces:**

- No new interfaces.

- [ ] **Step 1: Add dashboard block to `eslint.config.mjs`**

Keep the existing root block unchanged and append a dashboard-specific block **after** it. The merged config must remain a valid flat config with exact `files`, `parserOptions.project`, `tsconfigRootDir`, and `rules`. No `...` placeholders.

```js
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.worktrees/**', '.nexus/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['packages/dashboard/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './packages/dashboard/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: [
      'src/server/factory.ts',
      'src/storage/metadata-store.ts',
      'src/plugins/registry.ts',
      'src/storage/vector-store.ts',
    ],
    rules: {
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  }
);
```

- [ ] **Step 2: Commit the config**

```bash
GIT_MASTER=1 git add eslint.config.mjs
GIT_MASTER=1 git commit -m "chore(dashboard): ESLint config を dashboard package に拡張"
```

---

### Task 5b: Add Polling Hooks And Endpoint Discovery

**Files:**

- Modify: `packages/dashboard/src/hooks/use-metrics.ts`
- Create: `packages/dashboard/src/hooks/use-dashboard-status.ts`
- Create: `packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts`
- Modify: `packages/dashboard/tests/unit/use-metrics.test.tsx`
- Create: `packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx`
- Create: `packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx`

**Interfaces:**

- Consumes: `/status` JSON contract from Task 4; `useMetrics()` after modifying it to accept `port: number | null` and `enabled: boolean`.
- Produces: `useDashboardStatus({ port, enabled, interval }): PollResult<DashboardIndexStatusResult>`; `useDashboardEndpointDiscovery({ fixedPort, storageDir }): UseDashboardEndpointDiscoveryResult` with combined connection state and selected port.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { useDashboardStatus } from "../../../src/hooks/use-dashboard-status.js";

function Probe(props: Parameters<typeof useDashboardStatus>[0]) {
  const result = useDashboardStatus(props);
  return <div data-testid="status" data-stale={result.stale ? "yes" : "no"}>{result.status}</div>;
}

describe("useDashboardStatus", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => cleanup());
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("starts waiting and becomes connected on valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ status: "ok", snapshot: { skippedFiles: 0, providerStatus: { providerName: null, health: "unknown" } } }),
    } as unknown as Response);

    const { getByTestId } = render(<Probe port={9464} enabled={true} interval={1000} />);
    expect(getByTestId("status").textContent).toBe("waiting");
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId("status").textContent).toBe("connected");
  });

  it("keeps the last successful snapshot stale through consecutive failures", async () => {
    const snapshot = { skippedFiles: 0, providerStatus: { providerName: null, health: "unknown" } };
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ status: "ok", snapshot }),
        } as unknown as Response);
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    });

    const { getByTestId } = render(<Probe port={9464} enabled={true} interval={25} />);
    await waitFor(() => {
      expect(call).toBeGreaterThanOrEqual(3);
      expect(getByTestId("status").textContent).toBe("unavailable");
    });
    expect(getByTestId("status").getAttribute("data-stale")).toBe("yes");
  });
});
```

`packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { useDashboardEndpointDiscovery } from "../../../src/hooks/use-dashboard-endpoint-discovery.js";

function Probe(props: { fixedPort?: number }) {
  const result = useDashboardEndpointDiscovery({ fixedPort: props.fixedPort });
  return <div data-testid="state">{result.connectionState}</div>;
}

describe("useDashboardEndpointDiscovery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => cleanup());
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("connects to a fixed port", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/metrics/json")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => [{ name: "nexus_event_queue_size", values: [{ value: 0 }] }],
        } as unknown as Response;
      }
      if (url.endsWith("/status")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ status: "ok", snapshot: { providerStatus: { providerName: null, health: "unknown" } } }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { getByTestId } = render(<Probe fixedPort={9464} />);
    await waitFor(() => expect(getByTestId("state").textContent).toBe("connected"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx packages/dashboard/tests/unit/use-metrics.test.tsx`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the uniform `PollResult<T>` hook contract**

`packages/dashboard/src/hooks/use-metrics.ts`:

```ts
import { useState, useEffect, useRef } from "react";

export type MetricsStatus = "waiting" | "unavailable" | "connected";

export interface MetricsJSON {
  name: string;
  help?: string;
  type?: string;
  values?: MetricValue[];
  labels?: Record<string, string>;
}

export interface MetricValue {
  metricName?: string;
  labels?: Record<string, string>;
  value: number;
  timestamp?: number;
}

export interface UseMetricsOptions {
  port?: number | null;
  enabled?: boolean;
  interval?: number;
}

export interface PollResult<T> {
  status: "waiting" | "unavailable" | "connected";
  current: T | null;
  stale: T | null;
  error: string | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  generation: number;
}

export type UseMetricsResult = PollResult<MetricsJSON[]>;

export function useMetrics(options: UseMetricsOptions = {}): UseMetricsResult {
  const { port = null, enabled = false, interval = 2000 } = options;
  const [status, setStatus] = useState<MetricsStatus>("waiting");
  const [current, setCurrent] = useState<MetricsJSON[] | null>(null);
  const [stale, setStale] = useState<MetricsJSON[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [lastErrorAt, setLastErrorAt] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const currentRef = useRef<MetricsJSON[] | null>(null);

  useEffect(() => {
    setStatus("waiting");
    setCurrent(null);
    setStale(null);
    setError(null);
    setLastSuccessAt(null);
    setLastErrorAt(null);
    setGeneration(0);
    currentRef.current = null;
    if (!enabled || port === null) {
      return;
    }
    const abortController = new AbortController();
    const url = `http://127.0.0.1:${port}/metrics/json`;

    const markUnavailable = (msg: string) => {
      const now = Date.now();
      const previousCurrent = currentRef.current;
      setStale((previousStale) => previousCurrent ?? previousStale);
      setCurrent(null);
      currentRef.current = null;
      setError(msg);
      setLastErrorAt(now);
      setStatus("unavailable");
    };

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) {
          markUnavailable(`HTTP ${res.status}`);
          setGeneration((g) => g + 1);
          return;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          markUnavailable("Invalid JSON");
          setGeneration((g) => g + 1);
          return;
        }
        const json = await res.json();
        if (!Array.isArray(json)) {
          markUnavailable("Invalid response shape: expected array");
          setGeneration((g) => g + 1);
          return;
        }
        currentRef.current = json as MetricsJSON[];
        setCurrent(json as MetricsJSON[]);
        setStale(null);
        setError(null);
        setLastSuccessAt(Date.now());
        setLastErrorAt(null);
        setStatus("connected");
        setGeneration((g) => g + 1);
      } catch (err) {
        if (abortController.signal.aborted) return;
        markUnavailable(err instanceof Error ? err.message : String(err));
        setGeneration((g) => g + 1);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), interval);
    return () => {
      abortController.abort();
      clearInterval(id);
    };
  }, [port, enabled, interval]);

  return { status, current, stale, error, lastSuccessAt, lastErrorAt, generation };
}
```

`packages/dashboard/src/hooks/use-dashboard-status.ts`:

```ts
import { useState, useEffect, useRef } from "react";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { PollResult } from "./use-metrics.js";

export type DashboardStatusConnectionState = "waiting" | "unavailable" | "connected";

export interface UseDashboardStatusOptions {
  port?: number | null;
  enabled?: boolean;
  interval?: number;
}

export type UseDashboardStatusResult = PollResult<DashboardIndexStatusResult>;

export function useDashboardStatus(options: UseDashboardStatusOptions = {}): UseDashboardStatusResult {
  const { port = null, enabled = false, interval = 10_000 } = options;
  const [status, setStatus] = useState<DashboardStatusConnectionState>("waiting");
  const [current, setCurrent] = useState<DashboardIndexStatusResult | null>(null);
  const [stale, setStale] = useState<DashboardIndexStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [lastErrorAt, setLastErrorAt] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const currentRef = useRef<DashboardIndexStatusResult | null>(null);

  useEffect(() => {
    setStatus("waiting");
    setCurrent(null);
    setStale(null);
    setError(null);
    setLastSuccessAt(null);
    setLastErrorAt(null);
    setGeneration(0);
    currentRef.current = null;
    if (!enabled || port === null) {
      return;
    }
    const abortController = new AbortController();
    const url = `http://127.0.0.1:${port}/status`;

    const markUnavailable = (msg: string) => {
      const now = Date.now();
      const previousCurrent = currentRef.current;
      setStale((previousStale) => previousCurrent ?? previousStale);
      setCurrent(null);
      currentRef.current = null;
      setError(msg);
      setLastErrorAt(now);
      setStatus("unavailable");
    };

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) {
          markUnavailable(`HTTP ${res.status}`);
          setGeneration((g) => g + 1);
          return;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          markUnavailable("Invalid JSON");
          setGeneration((g) => g + 1);
          return;
        }
        const json = await res.json();
        if (json?.status !== "ok" || !json.snapshot) {
          markUnavailable(json?.error ?? "Invalid status response");
          setGeneration((g) => g + 1);
          return;
        }
        currentRef.current = json.snapshot as DashboardIndexStatusResult;
        setCurrent(json.snapshot as DashboardIndexStatusResult);
        setStale(null);
        setError(null);
        setLastSuccessAt(Date.now());
        setLastErrorAt(null);
        setStatus("connected");
        setGeneration((g) => g + 1);
      } catch (err) {
        if (abortController.signal.aborted) return;
        markUnavailable(err instanceof Error ? err.message : String(err));
        setGeneration((g) => g + 1);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), interval);
    return () => {
      abortController.abort();
      clearInterval(id);
    };
  }, [port, enabled, interval]);

  return { status, current, stale, error, lastSuccessAt, lastErrorAt, generation };
}
```

`packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts`:

```ts
import { useState, useEffect, useRef, useCallback } from "react";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { useMetrics } from "./use-metrics.js";
import { useDashboardStatus } from "./use-dashboard-status.js";

export type DashboardConnectionState =
  | "waiting"
  | "runtime_unavailable"
  | "metrics_unavailable"
  | "status_unavailable"
  | "connected";

export interface UseDashboardEndpointDiscoveryOptions {
  fixedPort?: number;
  storageDir?: string;
  metricsInterval?: number;
  statusInterval?: number;
}

export interface UseDashboardEndpointDiscoveryResult {
  port: number | null;
  connectionState: DashboardConnectionState;
  metrics: ReturnType<typeof useMetrics>;
  status: ReturnType<typeof useDashboardStatus>;
}

async function readMetricsPort(storageDir: string): Promise<number | null> {
  try {
    const content = await fsPromises.readFile(path.join(storageDir, "metrics.port"), "utf8");
    const port = Number.parseInt(content.trim(), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    // ignore
  }
  return null;
}

export function useDashboardEndpointDiscovery(
  options: UseDashboardEndpointDiscoveryOptions = {},
): UseDashboardEndpointDiscoveryResult {
  const { fixedPort, storageDir, metricsInterval = 2000, statusInterval = 10_000 } = options;
  const isDiscovery = fixedPort === undefined;
  const [port, setPort] = useState<number | null>(fixedPort ?? null);
  const [connectionState, setConnectionState] = useState<DashboardConnectionState>("waiting");
  const discoveryRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const discover = useCallback(async () => {
    if (!isDiscovery || !storageDir) return;
    const discovered = await readMetricsPort(storageDir);
    setPort((prev) => (discovered !== null ? discovered : prev));
  }, [isDiscovery, storageDir]);

  useEffect(() => {
    if (!isDiscovery) {
      setPort(fixedPort ?? null);
      return;
    }
    if (!storageDir) {
      setPort(null);
      return;
    }
    void discover();
    discoveryRef.current = setInterval(discover, 5000);
    return () => {
      if (discoveryRef.current) clearInterval(discoveryRef.current);
    };
  }, [isDiscovery, fixedPort, storageDir, discover]);

  const metrics = useMetrics({ port, enabled: port !== null, interval: metricsInterval });
  const status = useDashboardStatus({ port, enabled: port !== null, interval: statusInterval });

  useEffect(() => {
    if (!isDiscovery || port === null) return;
    if (metrics.status === "unavailable" && status.status === "unavailable") {
      void discover();
      if (discoveryRef.current) {
        clearInterval(discoveryRef.current);
        discoveryRef.current = setInterval(discover, 5000);
      }
    }
  }, [isDiscovery, port, metrics.status, status.status, discover]);

  useEffect(() => {
    if (port === null) {
      setConnectionState("runtime_unavailable");
      return;
    }
    if (metrics.status === "waiting" || status.status === "waiting") {
      setConnectionState("waiting");
      return;
    }
    if (metrics.status === "unavailable" && status.status === "unavailable") {
      setConnectionState("runtime_unavailable");
      return;
    }
    if (status.status !== "connected") {
      setConnectionState("status_unavailable");
      return;
    }
    if (metrics.status !== "connected") {
      setConnectionState("metrics_unavailable");
      return;
    }
    setConnectionState("connected");
  }, [port, metrics.status, status.status]);

  return { port, connectionState, metrics, status };
}
```

- [ ] **Step 4: Update `useMetrics` tests**

`packages/dashboard/tests/unit/use-metrics.test.tsx`:

```tsx
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMetrics } from "../../src/hooks/use-metrics.js";

describe("useMetrics", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = originalFetch; });
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("starts waiting when disabled", () => {
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: false }));
    expect(result.current.status).toBe("waiting");
    expect(result.current.current).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("moves to unavailable on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: true }));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.current).toBeNull();
    expect(result.current.lastErrorAt).not.toBeNull();
  });

  it("becomes connected on valid response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [{ name: "nexus_event_queue_size", values: [{ value: 0 }] }],
    } as unknown as Response);
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: true }));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.current).toHaveLength(1);
    expect(result.current.stale).toBeNull();
    expect(result.current.lastSuccessAt).not.toBeNull();
  });

  it("keeps the last successful value stale through consecutive failures", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => [{ name: "nexus_event_queue_size", values: [{ value: 0 }] }],
        } as unknown as Response);
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    });
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: true, interval: 25 }));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    await waitFor(() => expect(call).toBeGreaterThanOrEqual(3));
    expect(result.current.current).toBeNull();
    expect(result.current.stale).toHaveLength(1);
  });

  it("does not fetch when port is null", () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("should not call"));
    const { result } = renderHook(() => useMetrics({ port: null, enabled: true }));
    expect(result.current.status).toBe("waiting");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx packages/dashboard/tests/unit/use-metrics.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Run: `npx eslint packages/dashboard/src --ext .ts,.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/hooks/use-metrics.ts packages/dashboard/src/hooks/use-dashboard-status.ts packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts packages/dashboard/tests/unit/use-metrics.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx
GIT_MASTER=1 git commit -m "feat(dashboard): ポーリング hook とエンドポイント discovery を追加"
```

---

### Task 6: Add The Five-Minute Metrics History Ring Buffer

**Files:**

- Create: `packages/dashboard/src/utils/metrics-history.ts`
- Create: `packages/dashboard/src/hooks/use-metrics-history.ts`
- Create: `packages/dashboard/src/utils/sparkline.ts`
- Test: `packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx`
- Test: `packages/dashboard/tests/unit/utils/sparkline.test.ts`

**Interfaces:**

- Produces: `MetricsHistory` class with bounded retention, `observePoll({ generation, data, timestamp })`, `getSeriesExact(name, labels?)`, `getDeltaExact(name, labels?, windowMs?)`, `sumDeltaMatching(name, partialLabels?, windowMs?)`, `getHistogramMean(baseName, labels?, windowMs?)`; `useMetricsHistory({ data, port, generation, windowMs? }): { history: MetricsHistory }`; `renderSparkline(series, width)`.

Series identity is **metric family name plus the relevant label dimensions** listed in the design; prom-client default labels `project` and `pid` are ignored for dashboard series identity. Counter/histogram deltas respect missing polls (generation gaps), counter resets, and bounded retention. Histogram `_sum` and `_count` are stored independently so `getHistogramMean` can compute `_sum / _count` window deltas when the count delta is positive.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/utils/sparkline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderSparkline } from "../../../src/utils/sparkline.js";

describe("renderSparkline", () => {
  it("renders a flat line for an empty series", () => {
    expect(renderSparkline([], 10)).toBe("▁".repeat(10));
  });

  it("renders a rising series", () => {
    const line = renderSparkline([1, 2, 3, 4, 5], 5);
    expect(line.length).toBe(5);
    expect(line).not.toBe("▁".repeat(5));
  });
});
```

`packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMetricsHistory } from "../../../src/hooks/use-metrics-history.js";
import type { MetricsJSON } from "../../../src/hooks/use-metrics.js";
import { MetricsHistory } from "../../../src/utils/metrics-history.js";

describe("useMetricsHistory", () => {
  it("evicts expired samples but retains the preceding delta baseline", () => {
    const history = new MetricsHistory({ windowMs: 5000 });
    const now = Date.now();
    const data = (value: number): MetricsJSON[] => [
      { name: "nexus_event_queue_dropped_total", values: [{ value, labels: { queue_id: "q1" } }] },
    ];
    history.observePoll({ generation: 1, data: data(1), timestamp: now - 7000 });
    history.observePoll({ generation: 2, data: data(2), timestamp: now - 6000 });
    history.observePoll({ generation: 3, data: data(5), timestamp: now });

    expect(history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toEqual([2, 5]);
    expect(history.getDeltaExact("nexus_event_queue_dropped_total", { queue_id: "q1" }, 5000)).toBe(3);
  });

  it("sums deltas across matching labels", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [
        { name: "nexus_embedding_requests_total", values: [
          { value: 10, labels: { provider: "ollama", status: "error" } },
          { value: 5, labels: { provider: "bedrock", status: "error" } },
        ] },
      ],
      timestamp: t0,
    });
    history.observePoll({
      generation: 2,
      data: [
        { name: "nexus_embedding_requests_total", values: [
          { value: 12, labels: { provider: "ollama", status: "error" } },
          { value: 6, labels: { provider: "bedrock", status: "error" } },
        ] },
      ],
      timestamp: t0 + 1000,
    });
    expect(history.sumDeltaMatching("nexus_embedding_requests_total", { status: "error" }, 5000)).toBe(3);
  });

  it("ignores default project and pid labels for identity", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 1, labels: { queue_id: "q1", project: "foo", pid: "123" } }] }],
      timestamp: t0,
    });
    expect(history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toHaveLength(1);
  });

  it("does not count a missing poll as a counter interval", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 10, labels: { queue_id: "q1" } }] }],
      timestamp: t0,
    });
    history.observePoll({
      generation: 2,
      data: null,
      timestamp: t0 + 1000,
    });
    history.observePoll({
      generation: 3,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 15, labels: { queue_id: "q1" } }] }],
      timestamp: t0 + 2000,
    });
    history.observePoll({
      generation: 4,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 16, labels: { queue_id: "q1" } }] }],
      timestamp: t0 + 3000,
    });
    expect(history.getDeltaExact("nexus_event_queue_dropped_total", { queue_id: "q1" }, 5000)).toBe(1);
  });

  it("resets baseline on counter reset", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 10, labels: { queue_id: "q1" } }] }],
      timestamp: t0,
    });
    history.observePoll({
      generation: 2,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 2, labels: { queue_id: "q1" } }] }],
      timestamp: t0 + 1000,
    });
    history.observePoll({
      generation: 3,
      data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 3, labels: { queue_id: "q1" } }] }],
      timestamp: t0 + 2000,
    });
    expect(history.getDeltaExact("nexus_event_queue_dropped_total", { queue_id: "q1" }, 5000)).toBe(1);
  });

  it("preserves histogram _sum and _count components", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [
        { name: "nexus_tool_duration_seconds_sum", values: [{ value: 1.2, labels: { tool_name: "grep" } }] },
        { name: "nexus_tool_duration_seconds_count", values: [{ value: 5, labels: { tool_name: "grep" } }] },
        { name: "nexus_tool_duration_seconds_bucket", values: [{ value: 5, labels: { tool_name: "grep", le: "+Inf" } }] },
      ],
      timestamp: t0,
    });
    expect(history.getSeriesExact("nexus_tool_duration_seconds_sum", { tool_name: "grep" })).toHaveLength(1);
    expect(history.getSeriesExact("nexus_tool_duration_seconds_count", { tool_name: "grep" })).toHaveLength(1);
    expect(history.getSeriesExact("nexus_tool_duration_seconds_bucket", { tool_name: "grep", le: "+Inf" })).toHaveLength(1);
  });

  it("computes histogram mean from _sum/_count deltas", () => {
    const history = renderHook(() => useMetricsHistory({ data: null, port: null, generation: 0, windowMs: 5000 })).result.current.history;
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [
        { name: "nexus_tool_duration_seconds_sum", values: [{ value: 1.0, labels: { tool_name: "grep" } }] },
        { name: "nexus_tool_duration_seconds_count", values: [{ value: 2, labels: { tool_name: "grep" } }] },
      ],
      timestamp: t0,
    });
    history.observePoll({
      generation: 2,
      data: [
        { name: "nexus_tool_duration_seconds_sum", values: [{ value: 2.5, labels: { tool_name: "grep" } }] },
        { name: "nexus_tool_duration_seconds_count", values: [{ value: 5, labels: { tool_name: "grep" } }] },
      ],
      timestamp: t0 + 1000,
    });
    expect(history.getHistogramMean("nexus_tool_duration_seconds", { tool_name: "grep" }, 5000)).toBe(0.5);
  });

  it("discards the old port payload and accepts generation one on the new port", () => {
    const { result, rerender } = renderHook(
      ({ port, data, generation }) => useMetricsHistory({ data, port, generation, windowMs: 5000 }),
      { initialProps: { port: 9464, generation: 0, data: null } },
    );
    result.current.history.observePoll({ generation: 7, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 70, labels: { queue_id: "q1" } }] }], timestamp: Date.now() });
    rerender({ port: 9465, generation: 7, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 70, labels: { queue_id: "q1" } }] }] });
    expect(result.current.history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toHaveLength(0);
    rerender({ port: 9465, generation: 0, data: null });
    rerender({ port: 9465, generation: 1, data: [{ name: "nexus_event_queue_dropped_total", values: [{ value: 2, labels: { queue_id: "q1" } }] }] });
    expect(result.current.history.getSeriesExact("nexus_event_queue_dropped_total", { queue_id: "q1" })).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/utils/sparkline.test.ts packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `renderSparkline`**

`packages/dashboard/src/utils/sparkline.ts`:

```ts
export function renderSparkline(series: number[], width = 10): string {
  if (series.length === 0) return "▁".repeat(width);
  const values = series.slice(-width);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const bars = "▁▂▃▄▅▆▇█";
  return values
    .map((v) => {
      const ratio = (v - min) / range;
      const index = Math.min(bars.length - 1, Math.max(0, Math.floor(ratio * (bars.length - 1))));
      return bars[index];
    })
    .join("");
}
```

- [ ] **Step 4: Implement `MetricsHistory` and `useMetricsHistory`**

`packages/dashboard/src/utils/metrics-history.ts`:

```ts
import type { MetricsJSON } from "../hooks/use-metrics.js";

export interface MetricSample {
  timestamp: number;
  value: number;
  generation: number;
}

export interface MetricsHistoryOptions {
  windowMs?: number;
}

const SERIES_DIMENSIONS: Record<string, string[]> = {
  nexus_tool_calls_total: ["tool_name", "status"],
  nexus_tool_duration_seconds: ["tool_name"],
  nexus_search_results_hits: ["search_type"],
  nexus_embedding_requests_total: ["provider", "status"],
  nexus_embedding_duration_seconds: ["provider"],
  nexus_embedding_batch_size: ["provider"],
  nexus_event_queue_dropped_total: ["queue_id"],
  nexus_event_queue_size: ["queue_id"],
};

const IGNORED_LABELS = new Set(["project", "pid"]);

function seriesKey(name: string, labels?: Record<string, string>): string {
  const relevant = SERIES_DIMENSIONS[name];
  const source = relevant != null ? Object.fromEntries(relevant.map((k) => [k, labels?.[k]])) : (labels ?? {});
  const sorted = Object.entries(source)
    .filter(([k]) => !IGNORED_LABELS.has(k))
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return sorted ? `${name}{${sorted}}` : name;
}

function matchesPartial(
  labels: Record<string, string> | undefined,
  partial: Record<string, string> | undefined,
): boolean {
  if (!partial) return true;
  return Object.entries(partial).every(([k, v]) => labels?.[k] === v);
}

export interface PollObservation {
  generation: number;
  data: MetricsJSON[] | null;
  timestamp: number;
}

export class MetricsHistory {
  private readonly series = new Map<string, MetricSample[]>();
  private readonly windowMs: number;
  private generation = 0;

  constructor(options: MetricsHistoryOptions = {}) {
    this.windowMs = options.windowMs ?? 300_000;
  }

  observePoll(observation: PollObservation): void {
    this.generation = observation.generation;
    if (observation.data) {
      this.ingest(observation.data, observation.timestamp);
    }
  }

  ingest(data: MetricsJSON[], now = Date.now()): void {
    for (const family of data) {
      if (!family.values) continue;
      for (const value of family.values) {
        const name = value.metricName ?? family.name;
        const key = seriesKey(name, value.labels);
        const samples = this.series.get(key) ?? [];
        samples.push({ timestamp: now, value: value.value, generation: this.generation });
        this.series.set(key, samples);
      }
    }
    this.evictOldSamples(now);
  }

  private evictOldSamples(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, samples] of this.series) {
      let baselineIndex = -1;
      for (let i = 0; i < samples.length; i++) {
        if (samples[i].timestamp <= cutoff) baselineIndex = i;
        else break;
      }
      const start = baselineIndex > 0 ? baselineIndex : 0;
      if (start > 0) {
        const trimmed = samples.slice(start);
        if (trimmed.length === 0) {
          this.series.delete(key);
        } else {
          this.series.set(key, trimmed);
        }
      }
    }
  }

  getSeriesExact(name: string, labels?: Record<string, string>): number[] {
    const key = seriesKey(name, labels);
    const samples = this.series.get(key);
    if (!samples) return [];
    return samples.map((s) => s.value);
  }

  getDeltaExact(name: string, labels?: Record<string, string>, windowMs?: number): number | null {
    const key = seriesKey(name, labels);
    const samples = this.series.get(key);
    if (!samples || samples.length < 2) return null;
    return this.computeDelta(samples, windowMs ?? this.windowMs);
  }

  sumDeltaMatching(name: string, partialLabels?: Record<string, string>, windowMs?: number): number | null {
    let total: number | null = null;
    const ms = windowMs ?? this.windowMs;
    for (const [key, samples] of this.series) {
      if (!key.startsWith(name)) continue;
      const labels = this.parseLabels(key, name);
      if (!matchesPartial(labels, partialLabels)) continue;
      const delta = this.computeDelta(samples, ms);
      if (delta !== null) {
        total = total === null ? delta : total + delta;
      }
    }
    return total;
  }

  getHistogramMean(baseName: string, labels?: Record<string, string>, windowMs?: number): number | null {
    const sumDelta = this.getDeltaExact(`${baseName}_sum`, labels, windowMs);
    const countDelta = this.getDeltaExact(`${baseName}_count`, labels, windowMs);
    if (sumDelta === null || countDelta === null || countDelta <= 0) return null;
    return sumDelta / countDelta;
  }

  private parseLabels(key: string, name: string): Record<string, string> | undefined {
    const labelPart = key.slice(name.length);
    if (!labelPart.startsWith("{") || !labelPart.endsWith("}")) return undefined;
    const inner = labelPart.slice(1, -1);
    if (!inner) return undefined;
    const labels: Record<string, string> = {};
    for (const pair of inner.split(",")) {
      const [k, v] = pair.split("=");
      labels[k] = v;
    }
    return labels;
  }

  private computeDelta(samples: MetricSample[], windowMs: number): number | null {
    const cutoff = Date.now() - windowMs;
    let baselineIndex = -1;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].timestamp <= cutoff) baselineIndex = i;
      else break;
    }
    let total = 0;
    let hasDelta = false;
    let prev: MetricSample | null = baselineIndex >= 0 ? samples[baselineIndex] : null;

    for (let i = Math.max(0, baselineIndex + 1); i < samples.length; i++) {
      const curr = samples[i];
      if (prev === null) {
        prev = curr;
        continue;
      }
      if (curr.generation !== prev.generation + 1) {
        prev = curr;
        continue;
      }
      if (curr.value >= prev.value) {
        total += curr.value - prev.value;
        hasDelta = true;
      }
      // Reset: start a fresh baseline at curr; do not count the drop as a delta.
      prev = curr;
    }
    return hasDelta ? total : null;
  }

  clear(): void {
    this.series.clear();
    this.generation = 0;
  }
}
```

`packages/dashboard/src/hooks/use-metrics-history.ts`:

```ts
import { useState, useEffect, useRef } from "react";
import { MetricsHistory } from "../utils/metrics-history.js";
import type { MetricsJSON } from "./use-metrics.js";

export interface UseMetricsHistoryOptions {
  data: MetricsJSON[] | null;
  port: number | null;
  generation: number;
  windowMs?: number;
}

export interface UseMetricsHistoryResult {
  history: MetricsHistory;
}

export function useMetricsHistory({ data, port, generation, windowMs = 300_000 }: UseMetricsHistoryOptions): UseMetricsHistoryResult {
  const [history] = useState(() => new MetricsHistory({ windowMs }));
  const lastPortRef = useRef<number | null>(port);
  const lastGenerationRef = useRef<number>(0);

  useEffect(() => {
    if (port !== lastPortRef.current) {
      history.clear();
      lastGenerationRef.current = 0;
      lastPortRef.current = port;
      return;
    }
    if (generation > lastGenerationRef.current) {
      lastGenerationRef.current = generation;
      history.observePoll({ generation, data, timestamp: Date.now() });
    }
  }, [port, data, generation, history]);

  return { history };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/utils/sparkline.test.ts packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Run: `npx eslint packages/dashboard/src --ext .ts,.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/utils/metrics-history.ts packages/dashboard/src/hooks/use-metrics-history.ts packages/dashboard/src/utils/sparkline.ts packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx packages/dashboard/tests/unit/utils/sparkline.test.ts
GIT_MASTER=1 git commit -m "feat(dashboard): 5分間メトリクス履歴リングバッファと sparkline を追加"
```

---

### Task 7: Add ValueState, Readiness, And Attention Utilities

**Files:**

- Create: `packages/dashboard/src/utils/value-state.ts`
- Create: `packages/dashboard/src/utils/readiness.ts`
- Create: `packages/dashboard/src/utils/attention.ts`
- Test: `packages/dashboard/tests/unit/utils/value-state.test.ts`
- Test: `packages/dashboard/tests/unit/utils/readiness.test.ts`
- Test: `packages/dashboard/tests/unit/utils/attention.test.ts`

**Interfaces:**

- Consumes: `DashboardIndexStatusResult` mirror; `MetricsHistory`; `DashboardConnectionState`; selected endpoint URLs.
- Produces: `ValueState<T>` helpers; `deriveMainReadiness(snapshot)`, `deriveStructuredReadiness(structuredIndex)`; `deriveAttention({ snapshot, connectionState, metricsEndpointUrl, statusEndpointUrl, metrics, history })` returning a discriminated `AttentionItem` union with `fieldPath`, `endpointUrl`, or `metricSeries` provenance.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/utils/value-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { valueFromMetric } from "../../../src/utils/value-state.js";

describe("valueFromMetric", () => {
  it("returns unavailable when metric is absent", () => {
    const result = valueFromMetric("nexus_event_queue_size", [], "queue_id", "default");
    expect(result).toEqual({ kind: "unavailable", reason: "Metric nexus_event_queue_size not found" });
  });

  it("returns waiting when metrics array is null", () => {
    const result = valueFromMetric("nexus_event_queue_size", null, "queue_id", "default");
    expect(result).toEqual({ kind: "waiting" });
  });
});
```

`packages/dashboard/tests/unit/utils/readiness.test.ts`:

```ts
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
```

`packages/dashboard/tests/unit/utils/attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveAttention } from "../../../src/utils/attention.js";
import type { DashboardIndexStatusResult } from "../../../src/types/dashboard-index-status.js";
import { MetricsHistory } from "../../../src/utils/metrics-history.js";

describe("deriveAttention", () => {
  it("reports index build failed from canonical snapshot", () => {
    const snapshot = { indexStats: { lastError: "disk full" }, pipelineProgress: { status: "idle" }, providerStatus: { providerName: null, health: "unknown" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history: new MetricsHistory() });
    expect(items.some((i) => i.reason.includes("Index build failed"))).toBe(true);
  });

  it("reports connectivity item with actual endpoint URL on metrics_unavailable", () => {
    const items = deriveAttention({ snapshot: null, connectionState: "metrics_unavailable", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: null, metrics: null, history: new MetricsHistory() });
    const item = items.find((i) => i.source === "connectivity");
    expect(item?.endpointUrl).toBe("http://127.0.0.1:9464/metrics/json");
  });

  it("reports embedding error delta from history", () => {
    const history = new MetricsHistory({ windowMs: 5000 });
    const t0 = Date.now();
    history.observePoll({
      generation: 1,
      data: [{ name: "nexus_embedding_requests_total", values: [{ value: 1, labels: { provider: "bedrock", status: "error" } }] }],
      timestamp: t0,
    });
    history.observePoll({
      generation: 2,
      data: [{ name: "nexus_embedding_requests_total", values: [{ value: 4, labels: { provider: "bedrock", status: "error" } }] }],
      timestamp: t0 + 1000,
    });
    const items = deriveAttention({ snapshot: null, connectionState: "connected", metricsEndpointUrl: "http://127.0.0.1:9464/metrics/json", statusEndpointUrl: "http://127.0.0.1:9464/status", metrics: null, history });
    expect(items.some((i) => i.reason.includes("Embedding errors"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/utils/value-state.test.ts packages/dashboard/tests/unit/utils/readiness.test.ts packages/dashboard/tests/unit/utils/attention.test.ts`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `valueFromMetric` helper**

`packages/dashboard/src/utils/value-state.ts`:

```ts
export type ValueState<T> =
  | { kind: "available"; value: T }
  | { kind: "waiting" }
  | { kind: "unavailable"; reason: string }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export function available<T>(value: T): ValueState<T> {
  return { kind: "available", value };
}

export function waiting<T>(): ValueState<T> {
  return { kind: "waiting" };
}

export function unavailable<T>(reason: string): ValueState<T> {
  return { kind: "unavailable", reason };
}

export function unsupported<T>(): ValueState<T> {
  return { kind: "unsupported" };
}

export function error<T>(message: string): ValueState<T> {
  return { kind: "error", message };
}

export function valueFromMetric(
  name: string,
  metrics: import("../hooks/use-metrics.js").MetricsJSON[] | null,
  labelKey?: string,
  labelValue?: string,
): ValueState<number> {
  if (!metrics) return waiting();
  const family = metrics.find((m) => m.name === name);
  if (!family || !family.values) return unavailable(`Metric ${name} not found`);
  const value = labelKey
    ? family.values.find((v) => v.labels?.[labelKey] === labelValue)
    : family.values[0];
  if (!value) return unavailable(`Metric ${name} value not found`);
  return available(value.value);
}
```

- [ ] **Step 4: Implement readiness helpers**

`packages/dashboard/src/utils/readiness.ts`:

```ts
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";

export type MainReadiness = "Failed" | "Indexing" | "Ready" | "Not ready" | "Unavailable";
export type StructuredReadiness = "Ready" | "Indexing" | "Failed" | "Reindex required" | "Unsupported" | "Unavailable";

export function deriveMainReadiness(snapshot: DashboardIndexStatusResult | null): MainReadiness {
  if (!snapshot) return "Unavailable";
  if (snapshot.indexStats?.lastError != null || snapshot.pipelineProgress.lastError != null) return "Failed";
  if (snapshot.pipelineProgress.status === "running") return "Indexing";
  if (snapshot.indexStats?.lastIndexedAt != null) return "Ready";
  return "Not ready";
}

export function deriveStructuredReadiness(structuredIndex: DashboardIndexStatusResult["structuredIndex"]): StructuredReadiness {
  if (!structuredIndex) return "Unavailable";
  switch (structuredIndex.status) {
    case "idle": return "Ready";
    case "building": return "Indexing";
    case "failed": return "Failed";
    case "reindex_required": return "Reindex required";
    case "unsupported": return "Unsupported";
    default: return "Unavailable";
  }
}
```

- [ ] **Step 5: Implement Attention derivation**

`packages/dashboard/src/utils/attention.ts`:

```ts
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { DashboardConnectionState } from "../hooks/use-dashboard-endpoint-discovery.js";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { MetricsHistory } from "./metrics-history.js";
import { valueFromMetric } from "./value-state.js";

export type AttentionItem =
  | { source: "canonical"; reason: string; fieldPath: string; detail?: string }
  | { source: "connectivity"; reason: string; endpointUrl: string | null; detail?: string }
  | { source: "telemetry"; reason: string; metricSeries: string; detail?: string };

export interface DeriveAttentionInput {
  snapshot: DashboardIndexStatusResult | null;
  connectionState: DashboardConnectionState;
  metricsEndpointUrl: string | null;
  statusEndpointUrl: string | null;
  metrics: MetricsJSON[] | null;
  history: MetricsHistory;
}

export function deriveAttention({ snapshot, connectionState, metricsEndpointUrl, statusEndpointUrl, metrics, history }: DeriveAttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (connectionState === "runtime_unavailable") {
    items.push({ source: "connectivity", reason: "Runtime unavailable", endpointUrl: null, detail: "metrics.port not found or both endpoints unreachable" });
  } else if (connectionState === "metrics_unavailable") {
    items.push({ source: "connectivity", reason: "Metrics unavailable", endpointUrl: metricsEndpointUrl, detail: "unreachable" });
  } else if (connectionState === "status_unavailable") {
    items.push({ source: "connectivity", reason: "Status unavailable", endpointUrl: statusEndpointUrl, detail: "unreachable" });
  }

  if (snapshot) {
    if (snapshot.indexStats?.lastError != null) {
      items.push({ source: "canonical", reason: "Index build failed", fieldPath: "indexStats.lastError", detail: snapshot.indexStats.lastError });
    }
    if (snapshot.pipelineProgress.lastError != null) {
      items.push({ source: "canonical", reason: "Indexing pipeline failed", fieldPath: "pipelineProgress.lastError", detail: snapshot.pipelineProgress.lastError });
    }
    if (snapshot.structuredIndex?.status === "failed") {
      items.push({ source: "canonical", reason: "Structured index build failed", fieldPath: "structuredIndex.status" });
    }
    if (snapshot.structuredIndex?.reindexRequired) {
      items.push({ source: "canonical", reason: "Structured index requires rebuild", fieldPath: "structuredIndex.reindexRequired" });
    }
    if (snapshot.providerStatus.health === "unhealthy") {
      items.push({ source: "canonical", reason: "Embedding provider unhealthy", fieldPath: "providerStatus.health", detail: snapshot.providerStatus.lastError ?? undefined });
    }
  }

  if (metrics) {
    const overflow = valueFromMetric("nexus_event_queue_state", metrics, "state", "overflow");
    if (overflow.kind === "available" && overflow.value === 1) {
      items.push({ source: "telemetry", reason: "Queue overflow", metricSeries: "nexus_event_queue_state{state=\"overflow\"}" });
    }
    const dlq = valueFromMetric("nexus_dlq_size", metrics);
    if (dlq.kind === "available" && dlq.value > 0) {
      items.push({ source: "telemetry", reason: "DLQ entries detected", metricSeries: "nexus_dlq_size", detail: String(dlq.value) });
    }
    const droppedDelta = history.sumDeltaMatching("nexus_event_queue_dropped_total", undefined, 300_000);
    if (droppedDelta !== null && droppedDelta > 0) {
      items.push({ source: "telemetry", reason: "Dropped events observed", metricSeries: "nexus_event_queue_dropped_total", detail: "window delta > 0" });
    }
    const embeddingErrorDelta = history.sumDeltaMatching("nexus_embedding_requests_total", { status: "error" }, 300_000);
    if (embeddingErrorDelta !== null && embeddingErrorDelta > 0) {
      items.push({ source: "telemetry", reason: "Embedding errors observed in the recent window", metricSeries: "nexus_embedding_requests_total{status=\"error\"}", detail: "window delta > 0" });
    }
  }

  return items;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/utils/value-state.test.ts packages/dashboard/tests/unit/utils/readiness.test.ts packages/dashboard/tests/unit/utils/attention.test.ts`

Expected: PASS.

- [ ] **Step 7: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Run: `npx eslint packages/dashboard/src --ext .ts,.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/utils/value-state.ts packages/dashboard/src/utils/readiness.ts packages/dashboard/src/utils/attention.ts packages/dashboard/tests/unit/utils/value-state.test.ts packages/dashboard/tests/unit/utils/readiness.test.ts packages/dashboard/tests/unit/utils/attention.test.ts
GIT_MASTER=1 git commit -m "feat(dashboard): ValueState, readiness, Attention ユーティリティを追加"
```

---

### Task 8: Implement Five Views, Navigation, And Narrow Layout

**Files:**

- Create: `packages/dashboard/src/components/navigation.tsx`
- Create: `packages/dashboard/src/components/attention-panel.tsx`
- Create: `packages/dashboard/src/components/overview-view.tsx`
- Create: `packages/dashboard/src/components/index-view.tsx`
- Create: `packages/dashboard/src/components/retrieval-view.tsx`
- Create: `packages/dashboard/src/components/provider-view.tsx`
- Create: `packages/dashboard/src/components/diagnostics-view.tsx`
- Create: `packages/dashboard/src/components/compact-index-panel.tsx`
- Create: `packages/dashboard/src/components/compact-retrieval-panel.tsx`
- Create: `packages/dashboard/src/components/compact-provider-panel.tsx`
- Create: `packages/dashboard/src/components/compact-queue-panel.tsx`
- Modify: `packages/dashboard/src/app.tsx`
- Modify: `packages/dashboard/src/cli.ts`
- Test: `packages/dashboard/tests/unit/navigation.test.tsx`
- Test: `packages/dashboard/tests/unit/overview-view.test.tsx`

**Interfaces:**

- Consumes: `useDashboardEndpointDiscovery` result, `MetricsHistory`, `deriveAttention`, `deriveMainReadiness`, `deriveStructuredReadiness`, `ValueState` helpers.
- Produces: five view components plus compact panels, all accepting `LayoutPolicy`; `Navigation` accepts `activeIndex` and `onChange`.

`OverviewView` props include `connectionState`, `snapshot`, `metrics`, `history`, `layout`, and `port`. It renders `AttentionPanel`, then a row of compact panels guarded by `layout.showProviderPanel` and `layout.showQueuePanel`. `IndexView` props: `{ snapshot: DashboardIndexStatusResult | null; }`. `RetrievalView` props: `{ metrics: MetricsJSON[] | null; history: MetricsHistory; layout: LayoutPolicy; }`. `ProviderView` props: `{ snapshot: DashboardIndexStatusResult | null; history: MetricsHistory; layout: LayoutPolicy; }`. `DiagnosticsView` props: `{ connectionState; metrics: UseMetricsResult; status: UseDashboardStatusResult; metricsEndpointUrl; statusEndpointUrl; attentionInput: DeriveAttentionInput; layout: LayoutPolicy; }`.

Layout priority follows the design: Attention > Index > Retrieval > Provider > Queue/DLQ. Degradation order is: remove sparklines first (`width < 80`), then supplemental trend values (`width < 70`), then secondary statistics (`width < 60`), then decorative borders (`width < 50`), then Overview collapses Provider panel (`width < 35`) before Queue panel (`width < 45`). Queue/DLQ must hide before Provider.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/navigation.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { Navigation } from "../../src/components/navigation.js";

describe("Navigation", () => {
  afterEach(() => cleanup());

  it("renders five tabs and highlights the active one", () => {
    const { getByText } = render(<Navigation activeIndex={0} onChange={vi.fn()} />);
    expect(getByText("1 Overview")).toBeDefined();
    expect(getByText("5 Diagnostics")).toBeDefined();
  });
});
```

`packages/dashboard/tests/unit/overview-view.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { OverviewView } from "../../src/components/overview-view.js";
import { MetricsHistory } from "../../src/utils/metrics-history.js";

describe("OverviewView", () => {
  afterEach(() => cleanup());

  it("renders without crashing when no snapshot is available", () => {
    const { container } = render(
      <OverviewView
        connectionState="waiting"
        snapshot={null}
        metrics={null}
        history={new MetricsHistory()}
        layout={{ showSparklines: true, showSupplemental: true, showSecondary: true, showDecorations: true, showProviderPanel: true, showQueuePanel: true }}
        port={null}
      />
    );
    expect(container.textContent).toContain("Waiting");
  });

  it("hides sparklines first on narrow widths", () => {
    const { container: wide } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={[{ name: "nexus_search_results_hits", values: [{ value: 1 }, { value: 2 }, { value: 3 }] }]} history={new MetricsHistory()} layout={{ showSparklines: true, showSupplemental: true, showSecondary: true, showDecorations: true, showProviderPanel: true, showQueuePanel: true }} port={null} />
    );
    const { container: narrow } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={[{ name: "nexus_search_results_hits", values: [{ value: 1 }, { value: 2 }, { value: 3 }] }]} history={new MetricsHistory()} layout={{ showSparklines: false, showSupplemental: true, showSecondary: true, showDecorations: true, showProviderPanel: true, showQueuePanel: true }} port={null} />
    );
    expect(wide.textContent).toContain("▁");
    expect(narrow.textContent).not.toContain("▁");
    expect(wide.textContent).toContain("Retrieval");
    expect(narrow.textContent).toContain("Retrieval");
  });

  it("hides Queue panel before Provider panel on narrow widths", () => {
    const { container: providerOnly } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={null} history={new MetricsHistory()} layout={{ showSparklines: false, showSupplemental: false, showSecondary: false, showDecorations: false, showProviderPanel: true, showQueuePanel: false }} port={null} />
    );
    const { container: neither } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={null} history={new MetricsHistory()} layout={{ showSparklines: false, showSupplemental: false, showSecondary: false, showDecorations: false, showProviderPanel: false, showQueuePanel: false }} port={null} />
    );
    expect(providerOnly.textContent).toContain("Provider");
    expect(neither.textContent).not.toContain("Provider");
    expect(providerOnly.textContent).not.toContain("Queue");
    expect(neither.textContent).not.toContain("Queue");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/navigation.test.tsx packages/dashboard/tests/unit/overview-view.test.tsx`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the `Navigation` component**

```tsx
import React from "react";
import { Box, Text } from "ink";

const VIEWS = ["1 Overview", "2 Index", "3 Retrieval", "4 Provider", "5 Diagnostics"];

export interface NavigationProps {
  activeIndex: number;
  onChange: (index: number) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeIndex }) => {
  return (
    <Box justifyContent="space-around" marginBottom={1}>
      {VIEWS.map((label, i) => (
        <Text key={label} bold={i === activeIndex} color={i === activeIndex ? "cyan" : undefined}>
          {label}
        </Text>
      ))}
    </Box>
  );
};
```

- [ ] **Step 4: Implement view components**

Compact panels accept the same `LayoutPolicy` as the views and omit sparklines or supplemental values when the corresponding flag is `false`.

`packages/dashboard/src/components/overview-view.tsx`:

```tsx
import React from "react";
import { Box } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { DashboardConnectionState } from "../hooks/use-dashboard-endpoint-discovery.js";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { MetricsHistory } from "../utils/metrics-history.js";
import { deriveAttention } from "../utils/attention.js";
import { AttentionPanel } from "./attention-panel.js";
import { CompactIndexPanel } from "./compact-index-panel.js";
import { CompactRetrievalPanel } from "./compact-retrieval-panel.js";
import { CompactProviderPanel } from "./compact-provider-panel.js";
import { CompactQueuePanel } from "./compact-queue-panel.js";

export interface LayoutPolicy {
  showSparklines: boolean;
  showSupplemental: boolean;
  showSecondary: boolean;
  showDecorations: boolean;
  showProviderPanel: boolean;
  showQueuePanel: boolean;
}

export interface OverviewViewProps {
  connectionState: DashboardConnectionState;
  snapshot: DashboardIndexStatusResult | null;
  metrics: MetricsJSON[] | null;
  history: MetricsHistory;
  layout: LayoutPolicy;
  port: number | null;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ connectionState, snapshot, metrics, history, layout, port }) => {
  const metricsEndpointUrl = port != null ? `http://127.0.0.1:${port}/metrics/json` : null;
  const statusEndpointUrl = port != null ? `http://127.0.0.1:${port}/status` : null;
  const attention = deriveAttention({ snapshot, connectionState, metricsEndpointUrl, statusEndpointUrl, metrics, history });
  return (
    <Box flexDirection="column">
      <AttentionPanel items={attention} />
      <Box flexDirection="row" flexWrap="wrap">
        <CompactIndexPanel snapshot={snapshot} layout={layout} />
        <CompactRetrievalPanel metrics={metrics} history={history} layout={layout} />
        {layout.showProviderPanel && <CompactProviderPanel snapshot={snapshot} layout={layout} />}
        {layout.showQueuePanel && <CompactQueuePanel metrics={metrics} layout={layout} />}
      </Box>
    </Box>
  );
};
```

`IndexView`, `RetrievalView`, `ProviderView`, `DiagnosticsView`, compact panels, and `AttentionPanel` are implemented with the contracts above. `DiagnosticsView` renders connection state, both endpoint URLs, last fetch errors with timestamps (`metrics.lastErrorAt`, `status.lastErrorAt`) and last success timestamps (`metrics.lastSuccessAt`, `status.lastSuccessAt`), the Attention list, `providerStatus.lastError`, `indexStats?.lastError`, `pipelineProgress.lastError`, the current `snapshot` when available, and labeled stale values from `status.stale` when status is unavailable.

- [ ] **Step 5: Update `packages/dashboard/src/app.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useDashboardEndpointDiscovery } from "./hooks/use-dashboard-endpoint-discovery.js";
import { useMetricsHistory } from "./hooks/use-metrics-history.js";
import { Navigation } from "./components/navigation.js";
import { OverviewView } from "./components/overview-view.js";
import type { LayoutPolicy } from "./components/overview-view.js";
import { IndexView } from "./components/index-view.js";
import { RetrievalView } from "./components/retrieval-view.js";
import { ProviderView } from "./components/provider-view.js";
import { DiagnosticsView } from "./components/diagnostics-view.js";

export interface AppProps {
  fixedPort?: number;
  storageDir?: string;
  metricsInterval?: number;
  statusInterval?: number;
}

export const App: React.FC<AppProps> = ({
  fixedPort,
  storageDir,
  metricsInterval = 2000,
  statusInterval = 10_000,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [activeView, setActiveView] = useState(0);
  const { port, connectionState, metrics, status } = useDashboardEndpointDiscovery({
    fixedPort,
    storageDir,
    metricsInterval,
    statusInterval,
  });
  const width = stdout?.columns ?? 80;
  const layout: LayoutPolicy = {
    showSparklines: width >= 80,
    showSupplemental: width >= 70,
    showSecondary: width >= 60,
    showDecorations: width >= 50,
    showProviderPanel: width >= 35,
    showQueuePanel: width >= 45,
  };

  const { history } = useMetricsHistory({ data: metrics.current, port, generation: metrics.generation });
  const metricsEndpointUrl = port != null ? `http://127.0.0.1:${port}/metrics/json` : null;
  const statusEndpointUrl = port != null ? `http://127.0.0.1:${port}/status` : null;

  const views = [
    <OverviewView connectionState={connectionState} snapshot={status.current} metrics={metrics.current} history={history} layout={layout} port={port} />,
    <IndexView snapshot={status.current} />,
    <RetrievalView metrics={metrics.current} history={history} layout={layout} />,
    <ProviderView snapshot={status.current} history={history} layout={layout} />,
    <DiagnosticsView connectionState={connectionState} metrics={metrics} status={status} metricsEndpointUrl={metricsEndpointUrl} statusEndpointUrl={statusEndpointUrl} attentionInput={{ snapshot: status.current, connectionState, metricsEndpointUrl, statusEndpointUrl, metrics: metrics.current, history }} layout={layout} />,
  ];

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === "1") { setActiveView(0); return; }
    if (input === "2") { setActiveView(1); return; }
    if (input === "3") { setActiveView(2); return; }
    if (input === "4") { setActiveView(3); return; }
    if (input === "5") { setActiveView(4); return; }
    if (key.shift && key.tab) { setActiveView((i) => (i + 4) % 5); return; }
    if (key.tab || key.rightArrow) { setActiveView((i) => (i + 1) % 5); return; }
    if (key.leftArrow) { setActiveView((i) => (i + 4) % 5); return; }
  });

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="cyan">Nexus Live Operations Dashboard</Text>
      </Box>
      <Navigation activeIndex={activeView} onChange={setActiveView} />
      {views[activeView]}
    </Box>
  );
};
```

- [ ] **Step 6: Update `packages/dashboard/src/cli.ts`**

Modify the `render` call to pass the storage directory and optional fixed port:

```ts
const { waitUntilExit } = render(React.createElement(App, {
  fixedPort: values.port !== undefined ? port : undefined,
  storageDir: values.port !== undefined ? undefined : storageDir,
  metricsInterval: interval,
  statusInterval: 10_000,
}));
```

Remove the early `process.exit(1)` when no port file is found so the TUI can display `Runtime unavailable`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run --config packages/dashboard/vitest.config.ts packages/dashboard/tests/unit/navigation.test.tsx packages/dashboard/tests/unit/overview-view.test.tsx`

Expected: PASS.

- [ ] **Step 8: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Run: `npx eslint packages/dashboard/src --ext .ts,.tsx`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/components/*.tsx packages/dashboard/src/app.tsx packages/dashboard/src/cli.ts packages/dashboard/tests/unit/navigation.test.tsx packages/dashboard/tests/unit/overview-view.test.tsx
GIT_MASTER=1 git commit -m "feat(dashboard): 5ビュー、ナビゲーション、狭幅レイアウトを実装"
```

---

### Task 9: Remove Old Panels, Add Integration Tests, And Run Verification Gate

**Files:**

- Delete: `packages/dashboard/src/components/queue-panel.tsx`
- Delete: `packages/dashboard/src/components/throughput-panel.tsx`
- Delete: `packages/dashboard/src/components/dlq-panel.tsx`
- Delete: `packages/dashboard/src/components/metric-panel.tsx`
- Delete: `packages/dashboard/tests/unit/throughput-panel.test.tsx` (if it exists)
- Modify: `packages/dashboard/src/utils/metrics.ts` (remove unused helpers; delete if empty)
- Modify: `packages/dashboard/tests/integration/cli.test.ts`
- Create: `packages/dashboard/tests/integration/helpers.ts`

**Interfaces:**

- No new interfaces; removal and integration coverage only.

- [ ] **Step 1: Delete obsolete components**

```bash
GIT_MASTER=1 git rm packages/dashboard/src/components/queue-panel.tsx packages/dashboard/src/components/throughput-panel.tsx packages/dashboard/src/components/dlq-panel.tsx packages/dashboard/src/components/metric-panel.tsx
if [ -e packages/dashboard/tests/unit/throughput-panel.test.tsx ]; then
  GIT_MASTER=1 git rm packages/dashboard/tests/unit/throughput-panel.test.tsx
fi
```

- [ ] **Step 2: Clean up unused metrics helpers**

Remove any helpers in `packages/dashboard/src/utils/metrics.ts` that are no longer referenced by the new views. If the file becomes empty, delete it with `GIT_MASTER=1 git rm`.

- [ ] **Step 3: Create integration test helpers**

`packages/dashboard/tests/integration/helpers.ts`:

```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nexus-dashboard-test-"));
}

export async function cleanupTempProject(projectRoot: string): Promise<void> {
  await rm(projectRoot, { recursive: true, force: true });
}

export interface TestNexusServer {
  metricsPort: number;
  close(): Promise<void>;
}

export async function startNexusServer(
  projectRoot: string,
  options: { preferredPort?: number } = {},
): Promise<TestNexusServer> {
  const proc = spawn("node", [
    join(__dirname, "../../../../dist/bin/nexus.js"),
    "--project-root", projectRoot,
  ], {
    env: {
      ...process.env,
      NEXUS_METRICS_PORT: String(options.preferredPort ?? 0),
    },
  });
  const portFile = join(projectRoot, ".nexus", "metrics.port");
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const content = await readFile(portFile, "utf8");
      const port = Number.parseInt(content.trim(), 10);
      if (Number.isInteger(port) && port > 0) {
        return {
          metricsPort: port,
          close: () =>
            new Promise<void>((resolve, reject) => {
              proc.on("close", resolve);
              proc.on("error", reject);
              proc.kill("SIGTERM");
              setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
            }),
        };
      }
    } catch {
      // wait for port file
    }
    if (!proc.killed && proc.exitCode !== null) {
      throw new Error("Nexus server exited before metrics.port was written");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for metrics.port");
}

export function waitForOutput(
  getOutput: () => string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (getOutput().includes(expected)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout waiting for output: ${expected}`));
      }
    }, 100);
  });
}
```

- [ ] **Step 4: Extend CLI integration tests**

`packages/dashboard/tests/integration/cli.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { makeTempProject, cleanupTempProject, startNexusServer, waitForOutput } from "./helpers.js";

const cliPath = path.resolve("packages/dashboard/dist/cli.js");

describe("nexus dashboard integration", () => {
  it("starts and shows Runtime unavailable when the server is not running", async () => {
    const projectRoot = await makeTempProject();
    const proc = spawn("node", [cliPath, "--project-root", projectRoot], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await waitForOutput(() => output, "Runtime unavailable", 5000);
    proc.stdin.write("q");
    proc.stdin.end();

    const exitCode = await new Promise<number>((resolve) => proc.on("close", resolve));
    expect(output).toContain("Runtime unavailable");
    expect(exitCode).toBe(0);
    await cleanupTempProject(projectRoot);
  });

  it("reconnects after the runtime restarts on a changed port", async () => {
    const projectRoot = await makeTempProject();
    const firstServer = await startNexusServer(projectRoot);
    const firstPort = firstServer.metricsPort;
    await firstServer.close();

    const proc = spawn("node", [cliPath, "--project-root", projectRoot]);
    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await waitForOutput(() => output, "Runtime unavailable", 5000);

    const secondServer = await startNexusServer(projectRoot, { preferredPort: firstPort + 1 });
    await waitForOutput(() => output, "connected", 15000);

    proc.stdin.write("q");
    proc.stdin.end();
    const exitCode = await new Promise<number>((resolve) => proc.on("close", resolve));
    expect(output).toContain("connected");
    expect(exitCode).toBe(0);

    await secondServer.close();
    await cleanupTempProject(projectRoot);
  });
});
```

- [ ] **Step 5: Run the verification gate**

Run each command in order. Every command must exit with code zero.

```bash
npm run build
npx tsc -p packages/dashboard/tsconfig.json --noEmit
npx eslint packages/dashboard/src --ext .ts,.tsx
npm run build -w packages/dashboard
npx vitest run --config packages/dashboard/vitest.config.ts
npx tsc --noEmit
npm run lint
npx vitest run
npm run test:e2e
```

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/utils/metrics.ts packages/dashboard/tests/integration/helpers.ts packages/dashboard/tests/integration/cli.test.ts
GIT_MASTER=1 git commit -m "refactor(dashboard): 旧パネルを削除し統合テストを拡張"
```

## Self-Review

**Spec coverage check:**

| Review Finding | Plan task / test that covers it |
| --- | --- |
| RG-001: side-effect-free status boundary, provider tri-state, MCP compatibility | Tasks 1–4; Task 3 builder regression test uses real `PluginRegistry`, `BedrockEmbeddingProvider`, and injected client spy; Task 4 tests endpoint semantics. |
| RG-002: runtime discovery, route state, current-vs-stale | Task 5b; both hooks preserve stale through consecutive failures and clear on recovery/port change; `PollResult<T>` and CLI integration coverage. |
| RG-003: metrics history, labels, histogram, counter delta | Task 6; atomic port reset/generation observation, stale-port payload discard, new-port generation 1, missing-poll gaps, bounded eviction with preceding baseline, and `getHistogramMean`. |
| RG-004: missing data, readiness, diagnostics, Attention provenance, narrow layout | Task 8; `deriveAttention` endpoint URLs; Queue-before-Provider layout thresholds; direct sparkline-first assertions. |
| RG-005: implementation-plan correctness, types, paths, TDD executability, undefined helpers, placeholder | Tasks 3–9 include connected no-probe/Bedrock seams, `PollResult` and `LayoutPolicy` imports, route-specific fetch fixtures, unused-import removal, required `port` arguments, ESM-safe helper, and complete File Map coverage. |
| RG-006: verification gate, Dashboard lint, typecheck, test config | Task 5a (ESLint config before first dashboard lint), Task 9 verification gate with root build before dashboard integration tests and Dashboard lint in final gate. |
| RG-007: navigation contract | Task 8; digit/Tab/arrow/`q` navigation tests, ignored `h`/`l`. |

**Placeholder scan:** No TBD, TODO, fill-in-details, undefined helpers, or "..." placeholders remain.

**Type consistency:**

- `buildSharedIndexStatus()` returns `Promise<SharedIndexStatus>` everywhere.
- `buildDashboardIndexStatusSnapshot()` returns `Promise<DashboardIndexStatusResult>` everywhere.
- `DashboardIndexStatusResult` omits `pluginHealth` and adds `providerStatus`.
- `PluginRegistry.getEmbeddingProviderHealth(name)` returns `KnownHealthEntry | undefined`.
- `useMetrics` and `useDashboardStatus` expose `PollResult<T>` with `current`/`stale`/`lastSuccessAt`/`lastErrorAt`/`generation`.
- Both polling hooks preserve the last successful `stale` value over repeated failures and clear it only on recovery or port change.
- `MetricsHistory` ignores `project`/`pid` for series identity and uses `observePoll({ generation, data, timestamp })` for gap handling.
- `useMetricsHistory` resets on port change and returns before observing any payload from that render; a subsequent new-port generation 1 is accepted.
- Every `useMetricsHistory` call supplies the required `port`; direct history retention tests use `MetricsHistory` with explicit timestamps.
- Plan File Map enumerates the Create/Modify/Delete/Test paths listed in Tasks 1–9.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-24-nexus-dashboard-improvement.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like to use?
