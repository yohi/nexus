# Nexus Dashboard Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Nexus TUI Dashboard into a read-only Live Operations Dashboard with Overview, Index, Retrieval, Provider, and Diagnostics views, using `/metrics/json` as a telemetry stream and a side-effect-free canonical status endpoint as the source of truth for index/provider state.

**Architecture:** Keep the dashboard side-effect-free and read-only. The canonical status contract / snapshot builder that already backs the `index_status` MCP tool is extended with a project-local HTTP endpoint that the dashboard polls at a low, independent cadence. The dashboard maintains a five-minute in-memory ring buffer of metric samples for short-term sparklines. Views are Ink/React components driven by internal React state; navigation uses `useInput` with digit keys and Tab/arrow cycling. No aggregate health score is introduced; Attention is derived from canonical state, connectivity, or telemetry window deltas only.

**Tech Stack:** Node.js ESM, TypeScript, Ink 5.x + React 18.3.1, Vitest, `@testing-library/react`, prom-client, existing `MetricsCollector` / `MetricsHttpServer` in `src/observability/`.

## Global Constraints

- Preserve Node.js `>=24.0.0` from `package.json`.
- Use the repository's npm/package-lock dependency set; do not add UI routing libraries.
- Dashboard must not auto-start a missing Nexus runtime; it waits with `Runtime unavailable`.
- Dashboard must not trigger active embedding provider probes or billable provider requests for refreshes.
- `index_status` remains the canonical public interface; the dashboard endpoint is an internal/local transport sharing the same snapshot builder.
- No duplicate readiness logic is implemented for the dashboard.
- No dashboard-specific aggregate health score (`Healthy`/`Degraded`/`Critical`) is introduced.
- No project-level agent configuration files are created.
- No absolute paths, credentials, or generated local state are committed.
- All commits follow Conventional Commits in Japanese.

---

## File Map

| File | Responsibility |
|---|---|
| `src/observability/canonical-status-endpoint.ts` | New. Side-effect-free read-only HTTP endpoint that exposes the same canonical status snapshot used by `index_status`. |
| `src/server/tools/index-status.ts` | Refactor. Extract the snapshot builder so both the MCP tool and the endpoint share it. |
| `src/server/tools/tool-support.ts` | No change expected; continue calling `executeIndexStatus()` through the shared builder. |
| `src/observability/metrics-server.ts` | Modify. Mount the new canonical status endpoint under a read-only, loopback-only path. |
| `packages/dashboard/src/hooks/use-canonical-status.ts` | New. Polls the canonical status endpoint at a low, independent cadence; exposes snapshot + connection state. |
| `packages/dashboard/src/hooks/use-metrics-history.ts` | New. Maintains the five-minute in-memory ring buffer from `useMetrics` data. |
| `packages/dashboard/src/utils/sparkline.ts` | New. Pure ASCII sparkline renderer from a numeric series. |
| `packages/dashboard/src/utils/attention.ts` | New. Pure derivation of Attention items from canonical state, connectivity, and telemetry window. |
| `packages/dashboard/src/utils/retrieval.ts` | New. Pure helpers for aggregating retrieval metrics by search type. |
| `packages/dashboard/src/components/navigation.tsx` | New. Render the tab bar and handle direct/indirect view switching. |
| `packages/dashboard/src/components/overview-view.tsx` | New. Attention Summary + compact Index/Retrieval/Provider/Queue panels. |
| `packages/dashboard/src/components/index-view.tsx` | New. Detailed canonical index health. |
| `packages/dashboard/src/components/retrieval-view.tsx` | New. Retrieval activity breakdown with sparklines. |
| `packages/dashboard/src/components/provider-view.tsx` | New. Embedding provider summary with sparklines. |
| `packages/dashboard/src/components/diagnostics-view.tsx` | New. Dashboard runtime / connection diagnostics. |
| `packages/dashboard/src/components/attention-panel.tsx` | New. Render the Attention list. |
| `packages/dashboard/src/components/compact-*-panel.tsx` | New. Small reusable compact panels for Overview. |
| `packages/dashboard/src/app.tsx` | Refactor. Hold view state, wire navigation, and compose new views. |
| `packages/dashboard/src/cli.ts` | Modify. Pass canonical-status endpoint URL/interval to `App`; keep existing aggregator behavior. |
| `packages/dashboard/tests/unit/` | Add tests for pure helpers and hooks. |
| `packages/dashboard/tests/integration/cli.test.ts` | Extend. Verify startup and connection-state behavior. |
| `docs/superpowers/specs/2026-09-24-nexus-dashboard-improvement-design.md` | Reference. Already committed; update only if the design changes. |

---

### Task 1: Extract The Canonical Status Snapshot Builder

**Files:**
- Modify: `src/server/tools/index-status.ts`
- Create: `src/server/tools/build-index-status-snapshot.ts`
- Test: `tests/unit/server/tools/build-index-status-snapshot.test.ts` (new or extend existing `index-status.test.ts`)

**Interfaces:**
- Consumes: `IMetadataStore`, `IVectorStore`, `PluginRegistry`, `IIndexPipeline` (same as `executeIndexStatus`).
- Produces: `buildIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline): Promise<IndexStatusResult>` — identical return type to current `executeIndexStatus()`.

- [ ] **Step 1: Write the failing test**

Add a unit test that imports `buildIndexStatusSnapshot` from the new file and asserts it returns the same shape as the existing `executeIndexStatus()` test fixtures.

```ts
import { buildIndexStatusSnapshot } from "../../../src/server/tools/build-index-status-snapshot.js";
import { describe, it, expect, vi } from "vitest";

describe("buildIndexStatusSnapshot", () => {
  it("returns IndexStatusResult with skippedFiles equal to dead letter count", async () => {
    const metadataStore = {
      getIndexStats: vi.fn().mockResolvedValue({ id: "primary", totalFiles: 5, totalChunks: 10, lastIndexedAt: new Date().toISOString(), lastFullScanAt: null, overflowCount: 0, lastError: null }),
      getDeadLetterEntries: vi.fn().mockResolvedValue([{ id: "dlq-1" }]),
      getStructuredIndexState: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMetadataStore;
    const vectorStore = { getStats: vi.fn().mockResolvedValue({ totalChunks: 10, totalFiles: 5, dimensions: 1024, fragmentationRatio: 0 }) } as unknown as IVectorStore;
    const pluginRegistry = { healthCheck: vi.fn().mockResolvedValue({ languages: { registered: ["ts"], healthy: true }, embeddings: { provider: "ollama", healthy: true }, healthy: true, isOperational: true }) } as unknown as PluginRegistry;
    const pipeline = { getProgress: vi.fn().mockReturnValue({ totalFiles: 5, processedFiles: 5, status: "idle" }) } as unknown as IIndexPipeline;

    const result = await buildIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline);

    expect(result.skippedFiles).toBe(1);
    expect(result.indexStats.totalFiles).toBe(5);
    expect(result.pipelineProgress.status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/server/tools/build-index-status-snapshot.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Create the snapshot builder**

Move the body of `executeIndexStatus()` into `src/server/tools/build-index-status-snapshot.ts`, exporting `buildIndexStatusSnapshot()` with the same implementation. Keep `IndexStatusResult` and `StructuredIndexStatus` in the original `index-status.ts` and re-export them from the new file, or move types to a shared location and import both places. The simplest first cut: keep types in `index-status.ts`, re-export from `build-index-status-snapshot.ts`.

```ts
export { buildIndexStatusSnapshot, IndexStatusResult, StructuredIndexStatus } from "./build-index-status-snapshot.js";
```

- [ ] **Step 4: Rewrite `executeIndexStatus()` to delegate**

`src/server/tools/index-status.ts:28-68` becomes:

```ts
export const executeIndexStatus = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pluginRegistry: PluginRegistry,
  pipeline: IIndexPipeline,
): Promise<IndexStatusResult> => buildIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/server/tools/build-index-status-snapshot.test.ts tests/unit/server/tools/index-status.test.ts`

Expected: PASS.

- [ ] **Step 6: Run static checks**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add src/server/tools/build-index-status-snapshot.ts src/server/tools/index-status.ts tests/unit/server/tools/build-index-status-snapshot.test.ts
GIT_MASTER=1 git commit -m "refactor: index_status の canonical snapshot builder を分離"
```

---

### Task 2: Add The Side-effect-free Canonical Status HTTP Endpoint

**Files:**
- Create: `src/observability/canonical-status-endpoint.ts`
- Modify: `src/observability/metrics-server.ts`
- Modify: `src/runtime/factory.ts` (or wherever `MetricsHttpServer` is constructed) to pass required stores/pipeline.
- Test: `tests/unit/observability/canonical-status-endpoint.test.ts`

**Interfaces:**
- Consumes: `buildIndexStatusSnapshot()` from Task 1; `NexusServerOptions`-like object containing `metadataStore`, `vectorStore`, `pluginRegistry`, `pipeline`.
- Produces: `CanonicalStatusEndpoint` with `handler(req, res): Promise<void>` returning JSON `{ status: "ok", snapshot: IndexStatusResult }` or `{ status: "error", error: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createCanonicalStatusEndpoint } from "../../src/observability/canonical-status-endpoint.js";

describe("createCanonicalStatusEndpoint", () => {
  it("returns snapshot JSON on GET /status", async () => {
    const snapshot = { indexStats: null, vectorStats: { totalChunks: 0 }, skippedFiles: 0, pluginHealth: { healthy: true }, pipelineProgress: { totalFiles: 0, processedFiles: 0, status: "idle" } };
    const builder = vi.fn().mockResolvedValue(snapshot);
    const endpoint = createCanonicalStatusEndpoint(builder);

    let statusCode = 0;
    const headers: Record<string, string> = {};
    const chunks: string[] = [];
    const res = {
      writeHead(code: number, h: Record<string, string>) { statusCode = code; Object.assign(headers, h); },
      write(chunk: string) { chunks.push(chunk); },
      end() {},
    } as unknown as ServerResponse;

    await endpoint.handler({ url: "/status", method: "GET" } as IncomingMessage, res);

    expect(statusCode).toBe(200);
    expect(headers["content-type"]).toContain("application/json");
    expect(JSON.parse(chunks.join("")).snapshot).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/observability/canonical-status-endpoint.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the endpoint module**

`src/observability/canonical-status-endpoint.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IndexStatusResult } from "../server/tools/index-status.js";

export type BuildIndexStatusSnapshot = () => Promise<IndexStatusResult>;

export interface CanonicalStatusEndpoint {
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createCanonicalStatusEndpoint(buildSnapshot: BuildIndexStatusSnapshot): CanonicalStatusEndpoint {
  return {
    async handler(req, res) {
      if (req.method !== "GET" || req.url !== "/status") {
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

- [ ] **Step 4: Mount the endpoint in MetricsHttpServer**

Modify `src/observability/metrics-server.ts`. Add an optional `statusEndpoint?: CanonicalStatusEndpoint` constructor parameter. In the request router, route `/status` to `statusEndpoint.handler` before the 404 handler. Keep the server loopback-only (`127.0.0.1`).

- [ ] **Step 5: Wire the builder in runtime construction**

Find where `new MetricsHttpServer(registry)` is constructed (likely `src/runtime/factory.ts` around the same place `MetricsCollector` is created). Wrap the required stores/pipeline into a closure and pass `createCanonicalStatusEndpoint(() => buildIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline))`.

Importantly, **this builder must not be a new side-effect-free implementation**; it must reuse `buildIndexStatusSnapshot` from Task 1. The endpoint itself is read-only and loopback-only; it inherits the same active provider probe behavior as the MCP tool unless the builder is later changed. Document this in a code comment: "Shares the same snapshot builder as MCP index_status; provider health reflects runtime-known state."

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/observability/canonical-status-endpoint.test.ts`

Expected: PASS.

- [ ] **Step 7: Run static checks and full tests**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Run: `npm test`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
GIT_MASTER=1 git add src/observability/canonical-status-endpoint.ts src/observability/metrics-server.ts src/runtime/factory.ts tests/unit/observability/canonical-status-endpoint.test.ts
GIT_MASTER=1 git commit -m "feat: canonical status 用の read-only HTTP エンドポイントを追加"
```

---

### Task 3: Add Dashboard-side Status Polling Hook

**Files:**
- Create: `packages/dashboard/src/hooks/use-canonical-status.ts`
- Test: `packages/dashboard/tests/unit/use-canonical-status.test.tsx`

**Interfaces:**
- Consumes: `port` (number) and `interval` (number, default 10_000) of the canonical status endpoint.
- Produces: `{ status: "connecting" | "connected" | "unavailable"; snapshot: IndexStatusResult | null; error: string | null; lastUpdatedAt: number | null; }`.

- [ ] **Step 1: Write the failing test**

Follow the existing `use-metrics.test.tsx` pattern: mock global `fetch`, render a probe component, assert status transitions.

```tsx
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { useCanonicalStatus } from "../src/hooks/use-canonical-status.js";

function Probe(props: Parameters<typeof useCanonicalStatus>[0]) {
  const result = useCanonicalStatus(props);
  return <div data-testid="status">{result.status}</div>;
}

describe("useCanonicalStatus", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => cleanup());
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("starts connecting and becomes connected on valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ status: "ok", snapshot: { skippedFiles: 0, pluginHealth: { healthy: true } } }),
    } as unknown as Response);

    const { getByTestId } = render(<Probe port={9464} interval={1000} />);
    expect(getByTestId("status").textContent).toBe("connecting");
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId("status").textContent).toBe("connected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/dashboard/tests/unit/use-canonical-status.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`packages/dashboard/src/hooks/use-canonical-status.ts`:

```ts
import { useState, useEffect, useRef } from "react";
import type { IndexStatusResult } from "../../../src/server/tools/index-status.js";

export type CanonicalStatusConnectionStatus = "connecting" | "connected" | "unavailable";

export interface UseCanonicalStatusOptions {
  port?: number;
  interval?: number;
}

export interface UseCanonicalStatusResult {
  status: CanonicalStatusConnectionStatus;
  snapshot: IndexStatusResult | null;
  error: string | null;
  lastUpdatedAt: number | null;
}

export function useCanonicalStatus(options: UseCanonicalStatusOptions = {}): UseCanonicalStatusResult {
  const { port = 9464, interval = 10_000 } = options;
  const [status, setStatus] = useState<CanonicalStatusConnectionStatus>("connecting");
  const [snapshot, setSnapshot] = useState<IndexStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const hadConnection = useRef(false);

  useEffect(() => {
    hadConnection.current = false;
    const abortController = new AbortController();
    const url = `http://localhost:${port}/status`;

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setStatus(hadConnection.current ? "unavailable" : "connecting");
          return;
        }
        const json = await res.json();
        if (json?.status !== "ok" || !json.snapshot) {
          setStatus("unavailable");
          setError(json?.error ?? "Invalid status response");
          return;
        }
        setSnapshot(json.snapshot as IndexStatusResult);
        setError(null);
        setStatus("connected");
        setLastUpdatedAt(Date.now());
        hadConnection.current = true;
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus(hadConnection.current ? "unavailable" : "connecting");
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

Note: the import path to `IndexStatusResult` crosses the workspace boundary. Ensure `tsconfig.json` / `tsconfig.build.json` allows it, or copy a minimal read-only type into `packages/dashboard/src/types/canonical-status.ts`. Prefer importing from the source if the build already bundles server types; if not, create a local mirror type.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/dashboard/tests/unit/use-canonical-status.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/hooks/use-canonical-status.ts packages/dashboard/tests/unit/use-canonical-status.test.tsx
GIT_MASTER=1 git commit -m "feat(dashboard): canonical status 取得用 hook を追加"
```

---

### Task 4: Add Metrics History Ring Buffer And Sparkline Utilities

**Files:**
- Create: `packages/dashboard/src/hooks/use-metrics-history.ts`
- Create: `packages/dashboard/src/utils/sparkline.ts`
- Test: `packages/dashboard/tests/unit/use-metrics-history.test.tsx`
- Test: `packages/dashboard/tests/unit/sparkline.test.ts`

**Interfaces:**
- Consumes: `data: MetricsJSON[] | null` and `intervalMs: number`.
- Produces: `{ series: Record<string, number[]> }` for named metrics; `append(name, value)` internal API.
- `renderSparkline(series: number[], width?: number): string` returns an ASCII sparkline string.

- [ ] **Step 1: Write failing tests**

`packages/dashboard/tests/unit/sparkline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderSparkline } from "../src/utils/sparkline.js";

describe("renderSparkline", () => {
  it("renders an empty series as flat line", () => {
    expect(renderSparkline([], 10)).toMatch(/^[\s\u2581-\u2587█]+$/);
  });

  it("renders a rising series", () => {
    const line = renderSparkline([1, 2, 3, 4, 5], 5);
    expect(line.length).toBe(5);
  });
});
```

`packages/dashboard/tests/unit/use-metrics-history.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMetricsHistory } from "../src/hooks/use-metrics-history.js";

describe("useMetricsHistory", () => {
  it("keeps the last N samples for a metric", () => {
    const { result } = renderHook(() => useMetricsHistory({ intervalMs: 1000, maxAgeMs: 5000 }));
    // exercise via exported append helper or by simulating data updates
  });
});
```

- [ ] **Step 2: Implement `renderSparkline()`**

Use Unicode block characters `▁▂▃▄▅▆▇█`. Map `[min, max]` to 8 levels. Empty/all-equal series renders the lowest block.

```ts
export function renderSparkline(series: number[], width = 10): string {
  if (series.length === 0) return "▁".repeat(width);
  const values = series.slice(-width);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const bars = "▁▂▃▄▅▆▇█";
  return values
    .map((v) => bars[Math.min(bars.length - 1, Math.max(0, Math.floor(((v - min) / range) * (bars.length - 1))))])
    .join("");
}
```

- [ ] **Step 3: Implement `useMetricsHistory()`**

Buffer keyed by metric name; each entry stores `{ timestamp, value }`. On every new `data` array, extract values for configured metric names and push into the ring. Evict samples older than `maxAgeMs` (five minutes = 300_000). Expose `getSeries(name): number[]`.

Key metrics to track:
- `nexus_event_queue_size`
- `nexus_tool_duration_seconds` (average per sample using `_sum`/`_count`)
- `nexus_embedding_duration_seconds` (average)
- `nexus_search_results_hits` (average across search types)
- `nexus_embedding_batch_size`

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/dashboard/tests/unit/sparkline.test.ts packages/dashboard/tests/unit/use-metrics-history.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/hooks/use-metrics-history.ts packages/dashboard/src/utils/sparkline.ts packages/dashboard/tests/unit/use-metrics-history.test.tsx packages/dashboard/tests/unit/sparkline.test.ts
GIT_MASTER=1 git commit -m "feat(dashboard): メトリクス履歴リングバッファと ASCII sparkline を追加"
```

---

### Task 5: Add Attention Derivation Utility

**Files:**
- Create: `packages/dashboard/src/utils/attention.ts`
- Test: `packages/dashboard/tests/unit/attention.test.ts`

**Interfaces:**
- Consumes: `snapshot: IndexStatusResult | null`, `metricsStatus: MetricsStatus`, `canonicalStatus: CanonicalStatusConnectionStatus`, `metrics: MetricsJSON[] | null`, `history: MetricsHistory`.
- Produces: `AttentionItem[]` where each item has `{ source: "canonical" | "connectivity" | "telemetry"; severity: "warning" | "critical"; message: string; detail?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { deriveAttention } from "../src/utils/attention.js";

describe("deriveAttention", () => {
  it("reports index build failed from canonical snapshot", () => {
    const snapshot = {
      indexStats: { lastError: "disk full" },
      pipelineProgress: { status: "idle" },
      pluginHealth: { healthy: true },
      skippedFiles: 0,
    } as any;
    const items = deriveAttention({ snapshot, metricsStatus: "connected", canonicalStatus: "connected", metrics: [], history: emptyHistory() });
    expect(items.some((i) => i.message.includes("Index build failed"))).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `deriveAttention()`**

Rules:

**Canonical**
- `indexStats.lastError != null` → `Index build failed: <error>`
- `pipelineProgress.lastError != null` → `Indexing pipeline failed: <error>`
- `structuredIndex.status === "failed"` → `Structured index build failed`
- `structuredIndex.reindexRequired || structuredIndex.status === "reindex_required"` → `Structured index requires rebuild`
- `pluginHealth.embeddings.healthy === false` → `Current embedding provider unhealthy`
- `pluginHealth.isOperational === false` → `Runtime not operational`

**Connectivity**
- `canonicalStatus !== "connected"` → `Canonical status unavailable`
- `metricsStatus === "connecting" || metricsStatus === "reconnecting"` for > threshold → `Metrics unavailable`
- `canonicalStatus === "connecting"` (runtime absent) → `Runtime unavailable`

**Telemetry**
- `nexus_event_queue_state{state="overflow"} === 1` → `Queue overflow`
- `nexus_event_queue_dropped_total` delta > 0 in last window → `Dropped events observed`
- `nexus_dlq_size` > 0 → `DLQ entries detected`
- `nexus_embedding_requests_total{status="error"}` delta > 0 in last window → `Embedding errors observed in the recent window`

No aggregate `Healthy`/`Degraded`/`Critical` score is emitted. When the list is empty, the UI renders a quiet "No issues" equivalent.

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/dashboard/tests/unit/attention.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/utils/attention.ts packages/dashboard/tests/unit/attention.test.ts
GIT_MASTER=1 git commit -m "feat(dashboard): Attention 導出ユーティリティを追加"
```

---

### Task 6: Refactor App With Navigation And New Views

**Files:**
- Modify: `packages/dashboard/src/app.tsx`
- Create: `packages/dashboard/src/components/navigation.tsx`
- Create: `packages/dashboard/src/components/overview-view.tsx`
- Create: `packages/dashboard/src/components/index-view.tsx`
- Create: `packages/dashboard/src/components/retrieval-view.tsx`
- Create: `packages/dashboard/src/components/provider-view.tsx`
- Create: `packages/dashboard/src/components/diagnostics-view.tsx`
- Create: `packages/dashboard/src/components/attention-panel.tsx`
- Test: `packages/dashboard/tests/unit/navigation.test.tsx`

**Interfaces:**
- Consumes: `useMetrics()` result, `useCanonicalStatus()` result, `useMetricsHistory()` series, `deriveAttention()` list.
- Produces: Rendered TUI with tab switching. `AppProps` gains `statusPort`, `metricsPort`, `statusInterval`, `metricsInterval`.

- [ ] **Step 1: Write the failing test for navigation**

```tsx
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { Navigation } from "../src/components/navigation.js";

describe("Navigation", () => {
  afterEach(() => cleanup());

  it("renders five tabs and highlights the active one", () => {
    const { getByText } = render(<Navigation activeIndex={0} onChange={vi.fn()} />);
    expect(getByText("1 Overview")).toBeTruthy();
    expect(getByText("5 Diagnostics")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement `Navigation`**

`packages/dashboard/src/components/navigation.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

const VIEWS = ["Overview", "Index", "Retrieval", "Provider", "Diagnostics"];

interface NavigationProps {
  activeIndex: number;
  onChange: (index: number) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeIndex, onChange }) => {
  return (
    <Box gap={2} marginBottom={1}>
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

- [ ] **Step 3: Implement views (stub first)**

Each view accepts `metrics`, `snapshot`, `history`, and renders read-only content. Start with minimal placeholders so the app compiles, then fill in Task 7.

- [ ] **Step 4: Refactor `app.tsx` to hold view state and wiring**

`packages/dashboard/src/app.tsx`:

```tsx
import React, { useState } from "react";
import { Box, useApp, useInput } from "ink";
import { useMetrics } from "./hooks/use-metrics.js";
import { useCanonicalStatus } from "./hooks/use-canonical-status.js";
import { useMetricsHistory } from "./hooks/use-metrics-history.js";
import { Navigation } from "./components/navigation.js";
import { OverviewView } from "./components/overview-view.js";
import { IndexView } from "./components/index-view.js";
import { RetrievalView } from "./components/retrieval-view.js";
import { ProviderView } from "./components/provider-view.js";
import { DiagnosticsView } from "./components/diagnostics-view.js";

interface AppProps {
  metricsPort?: number;
  metricsInterval?: number;
  statusPort?: number;
  statusInterval?: number;
}

export const App: React.FC<AppProps> = ({
  metricsPort = 9464,
  metricsInterval = 2000,
  statusPort = 9464,
  statusInterval = 10_000,
}) => {
  const { exit } = useApp();
  const [activeView, setActiveView] = useState(0);
  const metrics = useMetrics({ port: metricsPort, interval: metricsInterval });
  const canonical = useCanonicalStatus({ port: statusPort, interval: statusInterval });
  const history = useMetricsHistory({ data: metrics.data, intervalMs: metricsInterval });

  useInput((input, key) => {
    if (input === "q") { exit(); return; }
    if (input === "1") setActiveView(0);
    if (input === "2") setActiveView(1);
    if (input === "3") setActiveView(2);
    if (input === "4") setActiveView(3);
    if (input === "5") setActiveView(4);
    if (key.tab) setActiveView((i) => (i + 1) % 5);
    if (key.shift && key.tab) setActiveView((i) => (i + 4) % 5);
    if (key.leftArrow) setActiveView((i) => (i + 4) % 5);
    if (key.rightArrow) setActiveView((i) => (i + 1) % 5);
  });

  const views = [
    <OverviewView metrics={metrics} canonical={canonical} history={history} />,
    <IndexView snapshot={canonical.snapshot} status={canonical.status} />,
    <RetrievalView metrics={metrics.data} history={history} />,
    <ProviderView metrics={metrics.data} snapshot={canonical.snapshot} history={history} />,
    <DiagnosticsView metrics={metrics} canonical={canonical} />,
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

- [ ] **Step 5: Update `cli.ts` to pass new props**

Change `React.createElement(App, { port, interval })` to:

```tsx
React.createElement(App, {
  metricsPort: port,
  metricsInterval: interval,
  statusPort: port,        // canonical status endpoint runs on the same loopback metrics server
  statusInterval: 10_000,  // independent low-frequency cadence
})
```

- [ ] **Step 6: Run static checks and tests**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Run: `npx vitest run packages/dashboard/tests/unit/navigation.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/app.tsx packages/dashboard/src/cli.ts packages/dashboard/src/components/navigation.tsx packages/dashboard/src/components/*-view.tsx packages/dashboard/tests/unit/navigation.test.tsx
GIT_MASTER=1 git commit -m "feat(dashboard): 新しい App 構造と5ビュー navigation を追加"
```

---

### Task 7: Implement View Content

**Files:**
- Modify: `packages/dashboard/src/components/overview-view.tsx`
- Modify: `packages/dashboard/src/components/index-view.tsx`
- Modify: `packages/dashboard/src/components/retrieval-view.tsx`
- Modify: `packages/dashboard/src/components/provider-view.tsx`
- Modify: `packages/dashboard/src/components/diagnostics-view.tsx`
- Modify: `packages/dashboard/src/components/attention-panel.tsx`
- Create: `packages/dashboard/src/components/compact-index-panel.tsx`
- Create: `packages/dashboard/src/components/compact-retrieval-panel.tsx`
- Create: `packages/dashboard/src/components/compact-provider-panel.tsx`
- Create: `packages/dashboard/src/components/compact-queue-panel.tsx`
- Test: `packages/dashboard/tests/unit/overview-view.test.tsx` (pure helper behavior, not full Ink render)

**Interfaces:**
- Views consume the same data contracts defined in Task 6.
- Compact panels render a one- or two-line summary for Overview.

- [ ] **Step 1: Implement `AttentionPanel`**

Lists `AttentionItem[]`. If empty, renders `<Text dimColor>No issues</Text>`. Critical items use `red`, warning items use `yellow`.

- [ ] **Step 2: Implement compact panels**

- `compact-index-panel.tsx`: show `indexStats.totalFiles`, `vectorStats.totalChunks`, `structuredIndex.status` or `N/A`.
- `compact-retrieval-panel.tsx`: show total tool calls in window and avg latency.
- `compact-provider-panel.tsx`: show provider identity, health word, recent request count.
- `compact-queue-panel.tsx`: show queue size, state, dropped count; emphasize overflow/dropped.

- [ ] **Step 3: Implement `OverviewView`**

```tsx
export const OverviewView: React.FC<OverviewViewProps> = ({ metrics, canonical, history }) => {
  const attention = deriveAttention({
    snapshot: canonical.snapshot,
    metricsStatus: metrics.status,
    canonicalStatus: canonical.status,
    metrics: metrics.data,
    history,
  });
  return (
    <Box flexDirection="column">
      <AttentionPanel items={attention} />
      <Box flexDirection="row" flexWrap="wrap">
        <CompactIndexPanel snapshot={canonical.snapshot} />
        <CompactRetrievalPanel metrics={metrics.data} history={history} />
        <CompactProviderPanel snapshot={canonical.snapshot} metrics={metrics.data} history={history} />
        <CompactQueuePanel metrics={metrics.data} />
      </Box>
    </Box>
  );
};
```

- [ ] **Step 4: Implement detail views**

- `IndexView`: full `IndexStatusResult` display; handle `snapshot == null` with unavailable message.
- `RetrievalView`: table of `grep`/`semantic`/`hybrid`/`structured` with calls, errors, avg latency, hits, sparklines.
- `ProviderView`: identity, runtime-known health, requests/errors, latency, batch size sparkline.
- `DiagnosticsView`: metrics endpoint URL, connection status, canonical status URL, last updated timestamp, recent errors.

- [ ] **Step 5: Add helper for retrieval aggregation**

`packages/dashboard/src/utils/retrieval.ts`:

```ts
export interface RetrievalSummary {
  calls: number;
  errors: number;
  avgLatencyMs: number | null;
  totalHits: number;
}

export function summarizeRetrieval(data: MetricsJSON[] | null, searchType: string): RetrievalSummary {
  // sum nexus_tool_calls_total where tool_name includes searchType and status
  // average nexus_tool_duration_seconds histogram for tools of this searchType
  // sum nexus_search_results_hits for search_type label
}
```

Start with `grep`, `semantic`, `hybrid`, and a separate structured retrieval bucket from `nexus_structured_retrieval_outcomes_total`.

- [ ] **Step 6: Run static checks and tests**

Run: `npx tsc --noEmit`

Run: `npm run lint`

Run: `npx vitest run packages/dashboard/tests/unit/overview-view.test.tsx packages/dashboard/tests/unit/attention.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add packages/dashboard/src/components/*.tsx packages/dashboard/src/utils/retrieval.ts packages/dashboard/tests/unit/overview-view.test.tsx
GIT_MASTER=1 git commit -m "feat(dashboard): Overview と詳細ビューのコンテンツを実装"
```

---

### Task 8: Remove Old Panels And Clean Up

**Files:**
- Delete: `packages/dashboard/src/components/queue-panel.tsx`
- Delete: `packages/dashboard/src/components/throughput-panel.tsx`
- Delete: `packages/dashboard/src/components/dlq-panel.tsx`
- Delete: `packages/dashboard/src/components/metric-panel.tsx`
- Delete: `packages/dashboard/tests/unit/throughput-panel.test.tsx` (or update if helpers are kept)
- Modify: `packages/dashboard/src/utils/metrics.ts` if any helpers become unused.

**Interfaces:**
- No new interfaces; only removal.

- [ ] **Step 1: Delete obsolete panel components**

They are replaced by compact/detail views. Keep `getValue`, `getSumByLabel`, `formatIndexingProgress`, `calculateAvgDuration` in `utils/metrics.ts` if still used; otherwise remove.

- [ ] **Step 2: Update tests**

Remove `throughput-panel.test.tsx` if it only tested the deleted component. If it tested `formatIndexingProgress`, move that test to a new `metrics.test.ts`.

- [ ] **Step 3: Run full dashboard test suite**

Run: `npx vitest run packages/dashboard/tests`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git rm packages/dashboard/src/components/queue-panel.tsx packages/dashboard/src/components/throughput-panel.tsx packages/dashboard/src/components/dlq-panel.tsx packages/dashboard/src/components/metric-panel.tsx packages/dashboard/tests/unit/throughput-panel.test.tsx
GIT_MASTER=1 git add packages/dashboard/src/utils/metrics.ts packages/dashboard/tests/unit/metrics.test.ts
GIT_MASTER=1 git commit -m "refactor(dashboard): 旧パネルコンポーネントを削除"
```

---

### Task 9: Integration And End-to-end Verification

**Files:**
- Modify: `packages/dashboard/tests/integration/cli.test.ts`
- Modify: `tests/integration/cli.test.ts` if it covers `nexus dashboard` startup.

**Interfaces:**
- Uses existing CLI test harness; no new interfaces.

- [ ] **Step 1: Extend CLI integration tests**

Verify that `nexus dashboard`:
- Starts and renders the Overview header.
- Does not auto-start a missing runtime.
- Connects to metrics and canonical status endpoints when the server is running.
- Exits cleanly on `q` input.

- [ ] **Step 2: Run the full verification matrix**

Run: `npm run build`

Expected: PASS; `dist/dashboard/cli.js` is produced.

Run: `npm run lint`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run test:e2e`

Expected: PASS.

- [ ] **Step 3: Manual smoke test**

In a temporary project:

```bash
npx dist/bin/nexus.js --project-root /tmp/nexus-smoke &
sleep 2
npx dist/bin/dashboard.js --project-root /tmp/nexus-smoke
```

Confirm Overview renders, `1`–`5` keys switch views, `q` exits, and no runtime is started when the server is not running.

- [ ] **Step 4: Commit any test fixes**

```bash
GIT_MASTER=1 git add packages/dashboard/tests/integration/cli.test.ts tests/integration/cli.test.ts
GIT_MASTER=1 git commit -m "test(dashboard): Dashboard 統合テストを拡張"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task that implements it |
|---|---|
| `/metrics/json` high-frequency telemetry stream | Task 4 (history) + existing `useMetrics` usage in Task 6 |
| Canonical status snapshot as source of truth | Tasks 1, 2 |
| Low-frequency independent status refresh | Task 3 (`useCanonicalStatus` with 10s default) |
| Side-effect-free / no active provider probes | Tasks 1, 2 (shared builder) + Task 3 (read-only endpoint) |
| No runtime auto-start | Task 2 (endpoint fails open) + Task 9 (test) |
| Overview + Index/Retrieval/Provider/Diagnostics | Tasks 6, 7 |
| 5-minute bounded in-memory history | Task 4 |
| ASCII sparkline | Task 4 |
| Attention 3-way classification | Task 5 |
| No aggregate health score | Task 5 (no score emitted) |
| Direct + indirect navigation | Task 6 |
| read-only | All view tasks |

**Placeholder scan:** No TBD/TODO/fill-in-details patterns remain.

**Type consistency:**
- `buildIndexStatusSnapshot()` returns `Promise<IndexStatusResult>` everywhere.
- `CanonicalStatusEndpoint.handler` uses `IncomingMessage` / `ServerResponse` consistently.
- Dashboard `AppProps` uses `metricsPort`, `metricsInterval`, `statusPort`, `statusInterval` consistently.
- `MetricsJSON` and `MetricValue` come from `use-metrics.ts` consistently.

**One open detail:** The exact placement where `MetricsHttpServer` is instantiated may differ from `src/runtime/factory.ts`; locate the existing constructor and update Task 2 accordingly before implementation.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-24-nexus-dashboard-improvement.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like to use?
