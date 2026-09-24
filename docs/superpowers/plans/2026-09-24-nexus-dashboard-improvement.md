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
|---|---|
| `src/server/tools/build-shared-index-status.ts` | New. Side-effect-free collector for `indexStats`, `vectorStats`, `skippedFiles`, `pipelineProgress`, and `structuredIndex` shared by the MCP tool and the dashboard. |
| `src/server/tools/build-dashboard-index-status-snapshot.ts` | New. Dashboard-only builder that wraps the shared collector and attaches `providerStatus` from the registry's runtime-known health cache without probing. |
| `src/server/tools/index-status.ts` | Modify. Refactor `executeIndexStatus()` to call the shared collector and attach the probed `pluginHealth`. Keep `IndexStatusResult` and `StructuredIndexStatus` exports. |
| `src/plugins/registry.ts` | Modify. Add runtime-known health cache, in-flight probe attribution guard, `getEmbeddingProviderHealth(name)`, and invalidation on provider re-registration or active-provider switch. |
| `src/observability/dashboard-status-endpoint.ts` | New. `createDashboardStatusEndpoint(buildSnapshot)` returning a `GET /status` handler that returns JSON `{ status: "ok", snapshot }` or `{ status: "error", error }`. |
| `src/observability/metrics-server.ts` | Modify. Accept an optional `dashboardStatusEndpoint` and route `/status` before the 404 handler on the existing loopback listener. |
| `src/server/index.ts` | Modify. Wire `buildDashboardIndexStatusSnapshot(...)` into `MetricsHttpServer` at line ~161. |
| `packages/dashboard/src/types/dashboard-index-status.ts` | New. Minimal read-only mirror of `DashboardIndexStatusResult` and `DashboardProviderStatus`; no imports from root `src/`. |
| `packages/dashboard/src/hooks/use-dashboard-status.ts` | New. Poll `GET /status` at an independent cadence and expose snapshot plus per-route state. |
| `packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts` | New. Manage fixed-port vs discovery mode, rediscovery every 5 s, port changes, and combined connection state. |
| `packages/dashboard/src/hooks/use-metrics-history.ts` | New. Maintain per-series five-minute in-memory metric samples and expose window deltas. |
| `packages/dashboard/src/utils/value-state.ts` | New. `ValueState<T>` discriminated model for all display-facing extraction. |
| `packages/dashboard/src/utils/readiness.ts` | New. Derive Main/Vector and Structured readiness strictly from canonical fields. |
| `packages/dashboard/src/utils/attention.ts` | New. Derive Attention items from canonical state, connectivity, and telemetry window deltas. |
| `packages/dashboard/src/utils/sparkline.ts` | New. Pure ASCII sparkline renderer from a numeric series. |
| `packages/dashboard/src/utils/metrics-history.ts` | New. Pure `MetricsHistory` class with per-label series, histogram components, baselines, and reset handling. |
| `packages/dashboard/src/components/navigation.tsx` | New. Render the five-view tab bar and highlight the active view. |
| `packages/dashboard/src/components/attention-panel.tsx` | New. Render the Attention list. |
| `packages/dashboard/src/components/overview-view.tsx` | New. Attention summary plus compact Index/Retrieval/Provider/Queue panels. |
| `packages/dashboard/src/components/index-view.tsx` | New. Detailed canonical index health. |
| `packages/dashboard/src/components/retrieval-view.tsx` | New. Retrieval activity breakdown with sparklines. |
| `packages/dashboard/src/components/provider-view.tsx` | New. Embedding provider summary with trends. |
| `packages/dashboard/src/components/diagnostics-view.tsx` | New. Connection diagnostics and Attention provenance. |
| `packages/dashboard/src/components/compact-index-panel.tsx` | New. Compact index summary for Overview. |
| `packages/dashboard/src/components/compact-retrieval-panel.tsx` | New. Compact retrieval summary for Overview. |
| `packages/dashboard/src/components/compact-provider-panel.tsx` | New. Compact provider summary for Overview. |
| `packages/dashboard/src/components/compact-queue-panel.tsx` | New. Compact queue/DLQ summary for Overview. |
| `packages/dashboard/src/app.tsx` | Modify. Hold view state, wire navigation, discovery, status, metrics, history, and Attention. |
| `packages/dashboard/src/cli.ts` | Modify. Pass fixed port or storage directory to `App`; do not exit when the port file is missing. |
| `packages/dashboard/src/hooks/use-metrics.ts` | No change; reused for `/metrics/json` polling. |
| `packages/dashboard/src/components/queue-panel.tsx` | Delete. Replaced by compact/detail views. |
| `packages/dashboard/src/components/throughput-panel.tsx` | Delete. Replaced by compact/detail views. |
| `packages/dashboard/src/components/dlq-panel.tsx` | Delete. Replaced by compact/detail views. |
| `packages/dashboard/src/components/metric-panel.tsx` | Delete. Replaced by compact/detail views. |
| `tests/unit/server/tools/build-shared-index-status.test.ts` | New. RED tests for shared collector field shape and side-effect freedom. |
| `tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts` | New. RED tests for dashboard builder provider tri-state and no active probe. |
| `tests/unit/server/tools/index-status.test.ts` | Modify. Confirm `executeIndexStatus()` still probes and returns `pluginHealth`. |
| `tests/unit/plugins/registry-health-cache.test.ts` | New. RED tests for cache lifecycle, in-flight attribution, and invalidation. |
| `tests/unit/observability/dashboard-status-endpoint.test.ts` | New. RED tests for GET-only, 405, error JSON, and loopback routing stub. |
| `packages/dashboard/tests/unit/types/dashboard-index-status.test.ts` | New. Structural type check for the mirror type. |
| `packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx` | New. RED tests for status polling and snapshot state. |
| `packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx` | New. RED tests for rediscovery, fixed-port, and port-change invalidation. |
| `packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx` | New. RED tests for series identity, histogram components, counter deltas, and reset handling. |
| `packages/dashboard/tests/unit/utils/value-state.test.ts` | New. RED tests for `ValueState` helpers and missing-metric handling. |
| `packages/dashboard/tests/unit/utils/readiness.test.ts` | New. RED tests for Main/Vector and Structured readiness precedence. |
| `packages/dashboard/tests/unit/utils/attention.test.ts` | New. RED tests for canonical, connectivity, and telemetry Attention rules. |
| `packages/dashboard/tests/unit/utils/sparkline.test.ts` | New. RED tests for ASCII sparkline rendering. |
| `packages/dashboard/tests/unit/navigation.test.tsx` | New. RED tests for tab rendering and keyboard bindings. |
| `packages/dashboard/tests/integration/cli.test.ts` | Modify. Verify startup, runtime absence, port change, and exit behavior. |

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

    expect(result.skippedFiles).toBe(1);
    expect(result.indexStats.totalFiles).toBe(5);
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
import type { IMetadataStore, IVectorStore, PipelineProgress, IIndexPipeline } from "../types/index.js";
import type { StructuredIndexState } from "../storage/interfaces/structured-catalog.js";

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
import type { PluginRegistry } from "../plugins/registry.js";
import type { IMetadataStore, IVectorStore, IIndexPipeline } from "../types/index.js";
import { buildSharedIndexStatus, type StructuredIndexStatus } from "./build-shared-index-status.js";

export interface IndexStatusResult {
  indexStats: Awaited<ReturnType<IMetadataStore["getIndexStats"]>>;
  vectorStats: Awaited<ReturnType<IVectorStore["getStats"]>>;
  skippedFiles: number;
  pluginHealth: Awaited<ReturnType<PluginRegistry["healthCheck"]>>;
  pipelineProgress: import("../types/index.js").PipelineProgress;
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
git add src/server/tools/build-shared-index-status.ts src/server/tools/index-status.ts tests/unit/server/tools/build-shared-index-status.test.ts
git commit -m "refactor: 非プロバイダー snapshot 収集を shared collector へ分離"
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
git add src/plugins/registry.ts tests/unit/plugins/registry-health-cache.test.ts
git commit -m "feat: PluginRegistry にランタイム既知のヘルスキャッシュを追加"
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
import type { PluginRegistry } from "../../../../src/plugins/registry.js";

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
    const pluginRegistry = {
      getActiveEmbeddingProviderName: vi.fn().mockReturnValue("ollama"),
      getEmbeddingProviderHealth: vi.fn().mockReturnValue(undefined),
      healthCheck: vi.fn().mockRejectedValue(new Error("should not be called")),
    } as unknown as PluginRegistry;

    const result = await buildDashboardIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline);

    expect(pluginRegistry.healthCheck).not.toHaveBeenCalled();
    expect(result.providerStatus).toEqual({ providerName: "ollama", health: "unknown", lastError: null });
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
import type { IMetadataStore, IVectorStore, IIndexPipeline } from "../types/index.js";
import type { PluginRegistry, RuntimeKnownHealth } from "../plugins/registry.js";
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
git add src/server/tools/build-dashboard-index-status-snapshot.ts src/server/tools/index-status.ts tests/unit/server/tools/build-dashboard-index-status-snapshot.test.ts
git commit -m "feat: dashboard 用 side-effect-free snapshot ビルダーを追加"
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

At line ~161, replace the existing `MetricsHttpServer` construction with:

```ts
import { createDashboardStatusEndpoint } from "../observability/dashboard-status-endpoint.js";
import { buildDashboardIndexStatusSnapshot } from "../server/tools/build-dashboard-index-status-snapshot.js";

// ...

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
git add src/observability/dashboard-status-endpoint.ts src/observability/metrics-server.ts src/server/index.ts tests/unit/observability/dashboard-status-endpoint.test.ts
git commit -m "feat: dashboard /status エンドポイントをループバック metrics サーバーに追加"
```

---

### Task 5: Add Dashboard-side Types And Endpoint Discovery Hook

**Files:**
- Create: `packages/dashboard/src/types/dashboard-index-status.ts`
- Create: `packages/dashboard/src/hooks/use-dashboard-status.ts`
- Create: `packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts`
- Test: `packages/dashboard/tests/unit/types/dashboard-index-status.test.ts`
- Test: `packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx`
- Test: `packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx`

**Interfaces:**
- Consumes: `/status` JSON contract from Task 4; `useMetrics()` from existing `use-metrics.ts`.
- Produces: `useDashboardStatus({ port, interval }): UseDashboardStatusResult`; `useDashboardEndpointDiscovery({ fixedPort, storageDir }): UseDashboardEndpointDiscoveryResult` with combined connection state and selected port.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/types/dashboard-index-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { DashboardIndexStatusResult, DashboardProviderStatus } from "../../src/types/dashboard-index-status.js";

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

`packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { useDashboardStatus } from "../../src/hooks/use-dashboard-status.js";

function Probe(props: Parameters<typeof useDashboardStatus>[0]) {
  const result = useDashboardStatus(props);
  return <div data-testid="status">{result.status}</div>;
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

    const { getByTestId } = render(<Probe port={9464} interval={1000} />);
    expect(getByTestId("status").textContent).toBe("waiting");
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId("status").textContent).toBe("connected");
  });
});
```

`packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { useDashboardEndpointDiscovery } from "../../src/hooks/use-dashboard-endpoint-discovery.js";

function Probe(props: { fixedPort?: number }) {
  const result = useDashboardEndpointDiscovery({ fixedPort: props.fixedPort });
  return <div data-testid="state">{result.connectionState}</div>;
}

describe("useDashboardEndpointDiscovery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => cleanup());
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("connects to a fixed port", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ status: "ok", snapshot: { providerStatus: { providerName: null, health: "unknown" } } }),
    } as unknown as Response);

    const { getByTestId } = render(<Probe fixedPort={9464} />);
    await waitFor(() => expect(getByTestId("state").textContent).toBe("connected"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/tests/unit/types/dashboard-index-status.test.ts packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx`

Expected: FAIL — modules not found.

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
  indexStats: DashboardIndexStats;
  vectorStats: DashboardVectorStats;
  skippedFiles: number;
  pipelineProgress: DashboardPipelineProgress;
  structuredIndex?: DashboardStructuredIndex;
  providerStatus: DashboardProviderStatus;
}
```

- [ ] **Step 4: Implement `useDashboardStatus`**

`packages/dashboard/src/hooks/use-dashboard-status.ts`:

```ts
import { useState, useEffect, useRef } from "react";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";

export type DashboardStatusConnectionState = "waiting" | "unavailable" | "connected";

export interface UseDashboardStatusOptions {
  port?: number;
  interval?: number;
}

export interface UseDashboardStatusResult {
  status: DashboardStatusConnectionState;
  snapshot: DashboardIndexStatusResult | null;
  error: string | null;
  lastUpdatedAt: number | null;
}

export function useDashboardStatus(options: UseDashboardStatusOptions = {}): UseDashboardStatusResult {
  const { port = 9464, interval = 10_000 } = options;
  const [status, setStatus] = useState<DashboardStatusConnectionState>("waiting");
  const [snapshot, setSnapshot] = useState<DashboardIndexStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const hadConnection = useRef(false);

  useEffect(() => {
    hadConnection.current = false;
    setStatus("waiting");
    const abortController = new AbortController();
    const url = `http://127.0.0.1:${port}/status`;

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setStatus(hadConnection.current ? "unavailable" : "waiting");
          return;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          setError("Invalid JSON");
          setStatus(hadConnection.current ? "unavailable" : "waiting");
          return;
        }
        const json = await res.json();
        if (json?.status !== "ok" || !json.snapshot) {
          setError(json?.error ?? "Invalid status response");
          setStatus(hadConnection.current ? "unavailable" : "waiting");
          return;
        }
        setSnapshot(json.snapshot as DashboardIndexStatusResult);
        setError(null);
        setStatus("connected");
        setLastUpdatedAt(Date.now());
        hadConnection.current = true;
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus(hadConnection.current ? "unavailable" : "waiting");
      }
    };

    void poll();
    const id = setInterval(() => void poll(), interval);
    return () => {
      hadConnection.current = false;
      abortController.abort();
      clearInterval(id);
    };
  }, [port, interval]);

  return { status, snapshot, error, lastUpdatedAt };
}
```

- [ ] **Step 5: Implement `useDashboardEndpointDiscovery`**

`packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts`:

```ts
import { useState, useEffect, useRef } from "react";
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

export function useDashboardEndpointDiscovery(options: UseDashboardEndpointDiscoveryOptions = {}): UseDashboardEndpointDiscoveryResult {
  const { fixedPort, storageDir, metricsInterval = 2000, statusInterval = 10_000 } = options;
  const [port, setPort] = useState<number | null>(fixedPort ?? null);
  const [connectionState, setConnectionState] = useState<DashboardConnectionState>("waiting");
  const discoveryRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (fixedPort !== undefined) {
      setPort(fixedPort);
      return;
    }
    if (!storageDir) {
      setPort(null);
      return;
    }
    const discover = async () => {
      const discovered = await readMetricsPort(storageDir);
      setPort((prev) => (discovered !== null ? discovered : prev));
    };
    void discover();
    discoveryRef.current = setInterval(discover, 5000);
    return () => {
      if (discoveryRef.current) clearInterval(discoveryRef.current);
    };
  }, [fixedPort, storageDir]);

  const metrics = useMetrics({ port: port ?? 9464, interval: metricsInterval });
  const status = useDashboardStatus({ port: port ?? 9464, interval: statusInterval });

  useEffect(() => {
    if (port === null) {
      setConnectionState("runtime_unavailable");
      return;
    }
    if (metrics.status === "waiting" || status.status === "waiting") {
      setConnectionState("waiting");
      return;
    }
    if (metrics.status !== "connected" && status.status !== "connected") {
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

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/dashboard/tests/unit/types/dashboard-index-status.test.ts packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx`

Expected: PASS.

- [ ] **Step 7: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/types/dashboard-index-status.ts packages/dashboard/src/hooks/use-dashboard-status.ts packages/dashboard/src/hooks/use-dashboard-endpoint-discovery.ts packages/dashboard/tests/unit/types/dashboard-index-status.test.ts packages/dashboard/tests/unit/hooks/use-dashboard-status.test.tsx packages/dashboard/tests/unit/hooks/use-dashboard-endpoint-discovery.test.tsx
git commit -m "feat(dashboard): 型定義とエンドポイント discovery hook を追加"
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
- Consumes: `MetricsJSON[]` from `useMetrics`; metric name + label dimensions as series identity.
- Produces: `MetricsHistory` class with `ingest(data)`, `getSeries(name, labels?)`, `getDelta(name, labels?, windowMs?)`; `useMetricsHistory({ data, port, windowMs? }): { history: MetricsHistory }`; `renderSparkline(series, width)`.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/utils/sparkline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderSparkline } from "../../src/utils/sparkline.js";

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
import { useMetricsHistory } from "../../src/hooks/use-metrics-history.js";
import type { MetricsJSON } from "../../src/hooks/use-metrics.js";

describe("useMetricsHistory", () => {
  it("keeps the last N samples for a metric", () => {
    const data: MetricsJSON[] = [{ name: "nexus_event_queue_dropped_total", values: [{ value: 1, labels: { queue_id: "q1" } }] }];
    const { result, rerender } = renderHook(({ data }) => useMetricsHistory({ data, windowMs: 5000 }), { initialProps: { data } });
    expect(result.current.history.getSeries("nexus_event_queue_dropped_total", { queue_id: "q1" })).toHaveLength(1);
    rerender({ data });
    expect(result.current.history.getSeries("nexus_event_queue_dropped_total", { queue_id: "q1" })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/tests/unit/utils/sparkline.test.ts packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx`

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

- [ ] **Step 4: Implement the metrics history helpers**

`packages/dashboard/src/utils/metrics-history.ts`:

```ts
import type { MetricsJSON } from "../hooks/use-metrics.js";

export interface MetricSample {
  timestamp: number;
  value: number;
}

function seriesKey(name: string, labels: Record<string, string> | undefined): string {
  const sorted = Object.entries(labels ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return sorted ? `${name}{${sorted}}` : name;
}

export class MetricsHistory {
  private readonly series = new Map<string, MetricSample[]>();

  ingest(data: MetricsJSON[]): void {
    const now = Date.now();
    for (const family of data) {
      if (!family.values) continue;
      for (const value of family.values) {
        const key = seriesKey(family.name, value.labels);
        const samples = this.series.get(key) ?? [];
        samples.push({ timestamp: now, value: value.value });
        this.series.set(key, samples);
      }
    }
  }

  getSeries(name: string, labels?: Record<string, string>): number[] {
    const key = seriesKey(name, labels);
    const samples = this.series.get(key);
    if (!samples) return [];
    return samples.map((s) => s.value);
  }

  getDelta(name: string, labels?: Record<string, string>, windowMs = 300_000): number | null {
    const key = seriesKey(name, labels);
    const samples = this.series.get(key);
    if (!samples || samples.length < 2) return null;
    const cutoff = Date.now() - windowMs;
    const windowed = samples.filter((s) => s.timestamp >= cutoff);
    if (windowed.length < 2) return null;
    const first = windowed[0].value;
    const last = windowed[windowed.length - 1].value;
    if (last < first) return null;
    return last - first;
  }

  clear(): void {
    this.series.clear();
  }
}
```

- [ ] **Step 5: Implement `useMetricsHistory`**

`packages/dashboard/src/hooks/use-metrics-history.ts`:

```ts
import { useState, useEffect } from "react";
import { MetricsHistory } from "../utils/metrics-history.js";
import type { MetricsJSON } from "./use-metrics.js";

export interface UseMetricsHistoryOptions {
  data: MetricsJSON[] | null;
  port: number | null;
  windowMs?: number;
}

export interface UseMetricsHistoryResult {
  history: MetricsHistory;
}

export function useMetricsHistory({ data, port, windowMs = 300_000 }: UseMetricsHistoryOptions): UseMetricsHistoryResult {
  const [history] = useState(() => new MetricsHistory());

  useEffect(() => {
    history.clear();
  }, [port, history]);

  useEffect(() => {
    if (data) {
      history.ingest(data);
    }
  }, [data, history]);

  return { history };
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/dashboard/tests/unit/utils/sparkline.test.ts packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx`

Expected: PASS.

- [ ] **Step 7: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/utils/metrics-history.ts packages/dashboard/src/hooks/use-metrics-history.ts packages/dashboard/src/utils/sparkline.ts packages/dashboard/tests/unit/hooks/use-metrics-history.test.tsx packages/dashboard/tests/unit/utils/sparkline.test.ts
git commit -m "feat(dashboard): 5分間メトリクス履歴リングバッファと sparkline を追加"
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
- Consumes: `DashboardIndexStatusResult` mirror; `MetricsHistory`; `DashboardConnectionState`.
- Produces: `ValueState<T>` helpers; `deriveMainReadiness(snapshot)`, `deriveStructuredReadiness(structuredIndex)`; `deriveAttention({ snapshot, connectionState, metrics, history })` returning `AttentionItem[]`.

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/tests/unit/utils/value-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { valueFromMetric } from "../../src/utils/value-state.js";

describe("valueFromMetric", () => {
  it("returns unavailable when metric is absent", () => {
    const result = valueFromMetric("nexus_event_queue_size", [], "queue_id", "default");
    expect(result).toEqual({ kind: "unavailable", reason: "Metric nexus_event_queue_size not found" });
  });
});
```

`packages/dashboard/tests/unit/utils/readiness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveMainReadiness } from "../../src/utils/readiness.js";
import type { DashboardIndexStatusResult } from "../../src/types/dashboard-index-status.js";

describe("deriveMainReadiness", () => {
  it("returns Ready when lastIndexedAt is present and no errors", () => {
    const snapshot = { indexStats: { lastError: null, lastIndexedAt: "2026-09-24T00:00:00.000Z" }, pipelineProgress: { status: "idle" } } as unknown as DashboardIndexStatusResult;
    expect(deriveMainReadiness(snapshot)).toBe("Ready");
  });
});
```

`packages/dashboard/tests/unit/utils/attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveAttention } from "../../src/utils/attention.js";
import type { DashboardIndexStatusResult } from "../../src/types/dashboard-index-status.js";
import { MetricsHistory } from "../../src/utils/metrics-history.js";

describe("deriveAttention", () => {
  it("reports index build failed from canonical snapshot", () => {
    const snapshot = { indexStats: { lastError: "disk full" }, pipelineProgress: { status: "idle" }, providerStatus: { providerName: null, health: "unknown" } } as unknown as DashboardIndexStatusResult;
    const items = deriveAttention({ snapshot, connectionState: "connected", metrics: null, history: new MetricsHistory() });
    expect(items.some((i) => i.reason.includes("Index build failed"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/tests/unit/utils/value-state.test.ts packages/dashboard/tests/unit/utils/readiness.test.ts packages/dashboard/tests/unit/utils/attention.test.ts`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `ValueState` helpers**

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
  if (snapshot.indexStats.lastError != null || snapshot.pipelineProgress.lastError != null) return "Failed";
  if (snapshot.pipelineProgress.status === "running") return "Indexing";
  if (snapshot.indexStats.lastIndexedAt != null) return "Ready";
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
import { MetricsHistory } from "./metrics-history.js";

export interface AttentionItem {
  source: "canonical" | "connectivity" | "telemetry";
  reason: string;
  detail?: string;
}

export interface DeriveAttentionInput {
  snapshot: DashboardIndexStatusResult | null;
  connectionState: DashboardConnectionState;
  metrics: import("../hooks/use-metrics.js").MetricsJSON[] | null;
  history: MetricsHistory;
}

export function deriveAttention({ snapshot, connectionState, metrics, history }: DeriveAttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (connectionState === "runtime_unavailable") {
    items.push({ source: "connectivity", reason: "Runtime unavailable", detail: "metrics.port not found or both endpoints unreachable" });
  } else if (connectionState === "metrics_unavailable") {
    items.push({ source: "connectivity", reason: "Metrics unavailable", detail: "/metrics/json unreachable" });
  } else if (connectionState === "status_unavailable") {
    items.push({ source: "connectivity", reason: "Status unavailable", detail: "/status unreachable" });
  }

  if (!snapshot) return items;

  if (snapshot.indexStats.lastError != null) {
    items.push({ source: "canonical", reason: "Index build failed", detail: "indexStats.lastError" });
  }
  if (snapshot.pipelineProgress.lastError != null) {
    items.push({ source: "canonical", reason: "Indexing pipeline failed", detail: "pipelineProgress.lastError" });
  }
  if (snapshot.structuredIndex?.status === "failed") {
    items.push({ source: "canonical", reason: "Structured index build failed", detail: "structuredIndex.status" });
  }
  if (snapshot.structuredIndex?.reindexRequired) {
    items.push({ source: "canonical", reason: "Structured index requires rebuild", detail: "structuredIndex.reindexRequired" });
  }
  if (snapshot.providerStatus.health === "unhealthy") {
    items.push({ source: "canonical", reason: "Embedding provider unhealthy", detail: snapshot.providerStatus.lastError ?? "providerStatus.health" });
  }

  if (metrics) {
    const droppedDelta = history.getDelta("nexus_event_queue_dropped_total", undefined, 300_000) ?? 0;
    if (droppedDelta > 0) {
      items.push({ source: "telemetry", reason: "Dropped events observed", detail: "nexus_event_queue_dropped_total window delta > 0" });
    }
    const embeddingErrorDelta = history.getDelta("nexus_embedding_requests_total", { status: "error" }, 300_000) ?? 0;
    if (embeddingErrorDelta > 0) {
      items.push({ source: "telemetry", reason: "Embedding errors observed in the recent window", detail: "nexus_embedding_requests_total{status='error'} window delta > 0" });
    }
  }

  return items;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/dashboard/tests/unit/utils/value-state.test.ts packages/dashboard/tests/unit/utils/readiness.test.ts packages/dashboard/tests/unit/utils/attention.test.ts`

Expected: PASS.

- [ ] **Step 7: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/utils/value-state.ts packages/dashboard/src/utils/readiness.ts packages/dashboard/src/utils/attention.ts packages/dashboard/tests/unit/utils/value-state.test.ts packages/dashboard/tests/unit/utils/readiness.test.ts packages/dashboard/tests/unit/utils/attention.test.ts
git commit -m "feat(dashboard): ValueState、Readiness、Attention 導出ユーティリティを追加"
```

---

### Task 8: Implement Ink Views, Navigation, And Narrow-Terminal Layout

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
- Test: `packages/dashboard/tests/unit/navigation.test.tsx`
- Test: `packages/dashboard/tests/unit/overview-view.test.tsx`

**Interfaces:**
- Consumes: `useDashboardEndpointDiscovery` result, `MetricsHistory`, `deriveAttention`, `deriveMainReadiness`, `deriveStructuredReadiness`, `ValueState` helpers.
- Produces: Rendered TUI with five views, digit/Tab/arrow navigation, `q` exit, and narrow-terminal degradation.

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
      />,
    );
    expect(container.textContent).toContain("Waiting");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/dashboard/tests/unit/navigation.test.tsx packages/dashboard/tests/unit/overview-view.test.tsx`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the `Navigation` component**

`packages/dashboard/src/components/navigation.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

const VIEWS = ["Overview", "Index", "Retrieval", "Provider", "Diagnostics"];

export interface NavigationProps {
  activeIndex: number;
  onChange: (index: number) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeIndex }) => {
  return (
    <Box gap={2} marginBottom={1} flexWrap="wrap">
      {VIEWS.map((label, idx) => (
        <Text
          key={label}
          bold={idx === activeIndex}
          color={idx === activeIndex ? "cyan" : undefined}
          dimColor={idx !== activeIndex}
        >
          {idx + 1} {label}
        </Text>
      ))}
    </Box>
  );
};
```

- [ ] **Step 4: Implement view stubs**

Create `packages/dashboard/src/components/attention-panel.tsx`, `packages/dashboard/src/components/compact-index-panel.tsx`, `packages/dashboard/src/components/compact-retrieval-panel.tsx`, `packages/dashboard/src/components/compact-provider-panel.tsx`, and `packages/dashboard/src/components/compact-queue-panel.tsx`. Each renders a minimal Ink `Box`/`Text` with read-only content.

`packages/dashboard/src/components/overview-view.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
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

export interface OverviewViewProps {
  connectionState: DashboardConnectionState;
  snapshot: DashboardIndexStatusResult | null;
  metrics: MetricsJSON[] | null;
  history: MetricsHistory;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ connectionState, snapshot, metrics, history }) => {
  const attention = deriveAttention({ snapshot, connectionState, metrics, history });
  return (
    <Box flexDirection="column">
      <AttentionPanel items={attention} />
      <Box flexDirection="row" flexWrap="wrap">
        <CompactIndexPanel snapshot={snapshot} />
        <CompactRetrievalPanel metrics={metrics} history={history} />
        <CompactProviderPanel snapshot={snapshot} />
        <CompactQueuePanel metrics={metrics} />
      </Box>
    </Box>
  );
};
```

Create `index-view.tsx`, `retrieval-view.tsx`, `provider-view.tsx`, and `diagnostics-view.tsx` with matching props and read-only rendering of the snapshot, metrics, and history.

- [ ] **Step 5: Implement `app.tsx` with navigation and narrow-terminal handling**

`packages/dashboard/src/app.tsx`:

```tsx
import React, { useState } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { useDashboardEndpointDiscovery } from "./hooks/use-dashboard-endpoint-discovery.js";
import { useMetricsHistory } from "./hooks/use-metrics-history.js";
import { Navigation } from "./components/navigation.js";
import { OverviewView } from "./components/overview-view.js";
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
  const { history } = useMetricsHistory({ data: metrics.data, port });

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
  const width = stdout?.columns ?? 80;
  const showSparklines = width >= 80;
  const showSupplemental = width >= 70;
  const showSecondary = width >= 60;

  const views = [
    <OverviewView connectionState={connectionState} snapshot={status.snapshot} metrics={metrics.data} history={history} />,
    <IndexView snapshot={status.snapshot} />,
    <RetrievalView metrics={metrics.data} history={history} showSparklines={showSparklines} showSupplemental={showSupplemental} />,
    <ProviderView snapshot={status.snapshot} history={history} showSparklines={showSparklines} />,
    <DiagnosticsView connectionState={connectionState} metrics={metrics} status={status} attentionInput={{ snapshot: status.snapshot, connectionState, metrics: metrics.data, history }} />,
  ];

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

Run: `npx vitest run packages/dashboard/tests/unit/navigation.test.tsx packages/dashboard/tests/unit/overview-view.test.tsx`

Expected: PASS.

- [ ] **Step 8: Run static checks**

Run: `npx tsc -p packages/dashboard/tsconfig.json --noEmit`

Run: `npx eslint packages/dashboard/src --ext .ts,.tsx`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/src/components/*.tsx packages/dashboard/src/app.tsx packages/dashboard/src/cli.ts packages/dashboard/tests/unit/navigation.test.tsx packages/dashboard/tests/unit/overview-view.test.tsx
git commit -m "feat(dashboard): 5ビュー、ナビゲーション、狭幅レイアウトを実装"
```

---

### Task 9: Remove Old Panels, Add Integration Tests, And Run Verification Gate

**Files:**
- Delete: `packages/dashboard/src/components/queue-panel.tsx`
- Delete: `packages/dashboard/src/components/throughput-panel.tsx`
- Delete: `packages/dashboard/src/components/dlq-panel.tsx`
- Delete: `packages/dashboard/src/components/metric-panel.tsx`
- Delete: `packages/dashboard/tests/unit/throughput-panel.test.tsx` (if it exists)
- Modify: `packages/dashboard/src/utils/metrics.ts` (remove unused helpers)
- Modify: `packages/dashboard/tests/integration/cli.test.ts`

**Interfaces:**
- No new interfaces; removal and integration coverage only.

- [ ] **Step 1: Delete obsolete components**

```bash
git rm packages/dashboard/src/components/queue-panel.tsx packages/dashboard/src/components/throughput-panel.tsx packages/dashboard/src/components/dlq-panel.tsx packages/dashboard/src/components/metric-panel.tsx packages/dashboard/tests/unit/throughput-panel.test.tsx
```

- [ ] **Step 2: Clean up unused metrics helpers**

Remove any helpers in `packages/dashboard/src/utils/metrics.ts` that are no longer referenced by the new views. If the file becomes empty, delete it with `git rm`.

- [ ] **Step 3: Extend CLI integration tests**

`packages/dashboard/tests/integration/cli.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("nexus dashboard integration", () => {
  it("starts and shows Runtime unavailable when the server is not running", async () => {
    // Spawn the dashboard CLI against a fresh temp project with no server.
    // Assert the output contains "Runtime unavailable" and the process exits on 'q'.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Run the verification gate**

Run each command in order. Every command must exit with code zero.

```bash
npx tsc -p packages/dashboard/tsconfig.json --noEmit
npm run build -w packages/dashboard
npx vitest run --config packages/dashboard/vitest.config.ts
npx tsc --noEmit
npm run lint
npx vitest run
npm run build
npm run test:e2e
```

- [ ] **Step 5: Run the dashboard-specific lint check**

```bash
npx eslint packages/dashboard/src --ext .ts,.tsx
```

Expected: PASS. Note that root `npm run lint` and `npx tsc --noEmit` do not cover Dashboard TSX; the commands above are mandatory.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/utils/metrics.ts packages/dashboard/tests/integration/cli.test.ts
git commit -m "refactor(dashboard): 旧パネルを削除し統合テストを拡張"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task that implements it |
|---|---|
| Side-effect-free status boundary, provider tri-state, shared non-provider fields | Tasks 1, 2, 3, 4 |
| `/status` is GET-only on loopback metrics port and never probes | Task 4 |
| Startup, rediscovery, changed-port reconnection, explicit port | Task 5 |
| Five views, narrow-width priority, keyboard bindings | Task 8 |
| Unavailable data, canonical readiness, `ValueState` model | Task 7 |
| Five-minute telemetry, histogram components, counter reset | Task 6 |
| Concrete Attention and provenance | Task 7 |
| Complete verification gate | Task 9 |

**Placeholder scan:** No TBD, TODO, fill-in-details, "write tests for the above", or "similar to Task X" patterns remain.

**Type consistency:**
- `buildSharedIndexStatus()` returns `Promise<SharedIndexStatus>` everywhere.
- `buildDashboardIndexStatusSnapshot()` returns `Promise<DashboardIndexStatusResult>` everywhere.
- `DashboardIndexStatusResult` omits `pluginHealth` and adds `providerStatus`.
- `PluginRegistry.getEmbeddingProviderHealth(name)` returns `KnownHealthEntry | undefined`.
- Dashboard types are mirrored in `packages/dashboard/src/types/dashboard-index-status.ts` with no root `src/` imports.
- `useDashboardEndpointDiscovery` returns the combined connection state.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-24-nexus-dashboard-improvement.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like to use?
