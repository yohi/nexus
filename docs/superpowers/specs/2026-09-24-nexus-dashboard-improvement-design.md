# Nexus Dashboard Improvement Design

## Goal, Scope, and Non-goals

Redesign the built-in, single-project Ink dashboard as a read-only Live Operations Dashboard. At a glance it answers: what needs attention now, and what Nexus is doing now. Overview, Index, Retrieval, Provider, and Diagnostics use a side-effect-free runtime status snapshot alongside short-lived metrics. Prometheus/Grafana remain responsible for long-term observability.

This documentation review concerns exactly two documents: `docs/superpowers/specs/2026-09-24-nexus-dashboard-improvement-design.md` (this design) and `docs/superpowers/plans/2026-09-24-nexus-dashboard-improvement.md` (the corresponding implementation plan). This review authorizes **no source code changes**. The implementation described below is future work; the older plan's active-probe snapshot and `pluginHealth` endpoint examples are superseded by this design and must be corrected before execution.

Scope is a single selected project, five keyboard-navigable views, a read-only local status endpoint, independently polled telemetry, five minutes of session-only history, and concrete Attention items without an aggregate health score. Non-goals are multi-project navigation, automatic runtime startup, dashboard writes, active provider probes on dashboard requests, durable history, alerting, long-term quantiles, and replacing the public MCP `index_status` contract.

## Background And Current State

The current dashboard in `packages/dashboard/` polls `/metrics/json` every two seconds and shows a fixed Queue / Indexing Throughput / DLQ screen. `MetricsHttpServer` in `src/observability/metrics-server.ts` already serves metrics on loopback. The public `index_status` result includes index, vector, pipeline, structured index, skipped-file, and probed plugin health data.

The probe chain is concrete: `executeIndexStatus()` calls `pluginRegistry.healthCheck()` at `src/server/tools/index-status.ts:42`; `PluginRegistry.healthCheck()` calls `activeProvider.healthCheck()` at `src/plugins/registry.ts:153`; Bedrock `healthCheck()` calls `embedOne('nexus health check')` at `src/plugins/embeddings/bedrock.ts:118-122`, which reaches `InvokeModel`. This is why the dashboard endpoint **must not reuse** `executeIndexStatus()` or its probed `pluginHealth` path: polling it can issue billable requests and distort observed activity.

## Status Data Boundary

The dashboard and MCP tool share the canonical **non-provider** snapshot fields and structured-index derivation, not the active provider probe. Define the following contracts in the runtime and consume the dashboard result by type in the TUI:

```ts
type RuntimeKnownHealth = 'healthy' | 'unhealthy' | 'unknown';

interface DashboardProviderStatus {
  providerName: string | null;
  health: RuntimeKnownHealth;
  lastError?: string | null;
}

type DashboardIndexStatusResult = Omit<IndexStatusResult, 'pluginHealth'> & {
  providerStatus: DashboardProviderStatus;
};
```

`DashboardIndexStatusResult` retains `indexStats`, `vectorStats`, `skippedFiles`, `pipelineProgress`, and optional `structuredIndex` with exactly the `IndexStatusResult` field types. `pluginHealth` exists only in the MCP result; it is **not** serialized in `/status`. `providerStatus` exists only in the dashboard result.

The canonical dashboard builder is `buildDashboardIndexStatusSnapshot(metadataStore, vectorStore, pluginRegistry, pipeline): Promise<DashboardIndexStatusResult>`. A shared side-effect-free collector obtains `indexStats` from `metadataStore.getIndexStats()`, `vectorStats` from `vectorStore.getStats()`, `skippedFiles` from dead-letter entry count, `pipelineProgress` from `pipeline.getProgress()`, and `structuredIndex` from the existing structured-state derivation. Both callers use that collector. The dashboard builder reads `pluginRegistry.getActiveEmbeddingProviderName()` and the registry's last-known health for **that same provider name**. It **does not** call `pluginRegistry.healthCheck()` or any provider method. If there is no active provider, set `providerName: null`; if no matching runtime-known health exists, set `health: 'unknown'` and `lastError: null`. Re-registering a provider invalidates its cached health; switching the active provider clears the active observation, so a previously cached observation cannot silently become current again. Registration alone does not prove health.

The optional last-known health cache lives in `PluginRegistry`, initially absent, and may be updated by initialization when it already knows an outcome and by the existing MCP active-probe path after a completed check. The cache records provider name, tri-state result, and last error; it never initiates a probe, and dashboard reads never mutate it. On MCP probe failure, cache `unhealthy` for the probed provider; on successful probe, cache `healthy` and clear its prior error. If the active provider changes while an asynchronous probe is in flight, the completed outcome must not be attributed to the new provider. Without an observation, dashboard UI displays `Unknown` for health and `Unavailable` for provider health detail, not `healthy` by default.

MCP `index_status` continues to call `executeIndexStatus()` and its active `PluginRegistry.healthCheck()` for backward compatibility. Refactor that function to reuse the non-provider collector and attach the probed `pluginHealth`. **`PluginRegistry.healthCheck()` MUST NOT be called on the dashboard code path**, including request handling, startup, refresh, and error recovery. No dashboard request invokes `embeddingProvider.healthCheck()`, `embedOne()`, or Bedrock `InvokeModel`. The shared fields are `indexStats`, `vectorStats`, `skippedFiles`, `pipelineProgress`, `structuredIndex`; the two provider-health representations remain separate.

## Data Sources And Update Contracts

| Source | Cadence | Contract | Ownership |
| --- | --- | --- | --- |
| `GET /metrics/json` | 2 seconds by default | Prom-client JSON metric families; high-frequency telemetry and session trends | Existing `MetricsHttpServer` registry |
| `GET /status` | 10 seconds by default, independently timed; immediate fetch on recovered connection | HTTP 200 `{ status: "ok", snapshot: DashboardIndexStatusResult }`; HTTP 500 `{ status: "error", error: string }` | Side-effect-free dashboard snapshot builder |

Both routes are served by `MetricsHttpServer` on the **same project-scoped loopback port**, bound to `127.0.0.1`. `/status` is loopback-only, GET-only, read-only, and does not record an MCP tool call. Reject non-GET `/status` with HTTP 405 and an error JSON body; unknown routes remain 404. Snapshot construction reads already-open runtime stores and progress; it never starts indexing, registers providers, or performs health checks. Do not route `/status` through the MCP tool dispatcher. A successful metrics response never substitutes for an unavailable canonical snapshot, and a successful status response never substitutes for missing telemetry. On status failure, mark the current canonical values unavailable; retain the last successful snapshot only as explicitly stale diagnostic context, not as current readiness.

## Runtime Discovery State Machine

The CLI uses the selected project's existing `storageDir` resolution; `src/server/metrics-port.ts` owns `<storageDir>/metrics.port`. All fetches use `http://127.0.0.1:<port>` and address both paths on that one port.

```text
                    discovery: port file absent/invalid
   startup ------------------------------------------------> runtime_unavailable
      |                                                         |
      | --port P (fixed)                              rediscover every 5 s
      |                                                         |
      +-----------------------> probe P <----- valid discovered port P
                                   |
                   +---------------+----------------+
                   |                                |
                both OK                      one route fails
                   |                                |
                connected              metrics_unavailable / status_unavailable
                   |                                |
                   +---- connection lost -----------+
                                 |
                discovery mode: reread port file; follow new P
                explicit --port mode: retry P; never rediscover
```

Connection states are `runtime_unavailable`, `metrics_unavailable`, `status_unavailable`, and `connected`. `runtime_unavailable` means no valid discovered port, or both endpoints on the selected port are unreachable; `metrics_unavailable` means status works but metrics does not; `status_unavailable` means metrics works but status does not. `connected` requires fresh successful responses from **both** endpoints. If both are individually reachable but fail application-level validation, classify by failed route, giving `status_unavailable` precedence when both responses are invalid; Diagnostics records both errors. Initial pending requests display `Waiting`, not a false connected state. On port change, cancel the old pollers, invalidate their in-flight results, clear current snapshots and metric baselines, and fetch both new URLs immediately. On individual route failure, the unaffected poller continues on the same port; the failed poller retries at its own cadence. On transport loss in discovery mode, reread `metrics.port` immediately, then every five seconds while unavailable and while recovering; follow changed ports. Also reread the port file every five seconds while connected to detect a changed port without waiting for a failure. A stale port file never triggers a runtime launch. An absent runtime must leave the TUI running with `Runtime unavailable`. Explicit `--port P` fixes P for the entire session: retry there, never read `metrics.port`, and never rediscover. Clear timers and abort pending requests on exit.

### Polling Hook State Contract

Each HTTP polling hook accepts `port: number | null` plus an `enabled` boolean derived from `port !== null`. When disabled the hook emits `waiting` and never issues a request, so `port = null` never falls back to `9464` or any other port.

The hook result for a route is represented by a uniform `PollResult<T>` discriminated model:

```ts
interface PollResult<T> {
  status: "waiting" | "unavailable" | "connected";
  current: T | null;
  stale: T | null;
  error: string | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
}
```

`current` holds the most recent successful response for this route and is `null` after a poll failure or when no request has succeeded. `stale` holds the previous `current` value at the moment the route transitions to `unavailable`; it is cleared on port change or when the route recovers to `connected`. `lastSuccessAt` and `lastErrorAt` are Unix millisecond timestamps for the latest successful and the latest failed fetch respectively. `waiting` is the initial pending state; `unavailable` is emitted after the first failed retry so a discovered port whose runtime is dead can transition to `runtime_unavailable` instead of staying in `waiting` forever. Views render `current` only; Diagnostics renders `current` plus explicitly labeled `stale` values with their last-success timestamp.

## Views And Narrow Terminal Behavior

| View | Required main content |
| --- | --- |
| Overview | Attention, Main / Vector and Structured Index state, retrieval activity, provider identity and health, compact Queue / DLQ |
| Index | Canonical Main / Vector counts, last indexing time, pipeline progress and current file, skipped files, last errors; Structured Index status, counts, pending, schema and rebuild state |
| Retrieval | Calls and success/error by tool, duration and hits by search type, five-minute trends; absent metrics remain unavailable |
| Provider | Provider name and runtime-known health, last error, request/error delta, duration and batch size trends |
| Diagnostics | All Attention provenance, both endpoint URLs, connection state, most recent fetch and error, provider and index last errors, runtime availability |

Narrow layout is measured using Ink `stdout.columns`, recalculated on resize. Fixed priority: **Attention > Index > Retrieval > Provider > Queue/DLQ**. Maintain the selected view's main state and its Attention context at every width; wrap/truncate labels and allow vertical growth instead of dropping main state. Degrade in this order as available columns shrink: remove sparklines first, then supplemental trend values, then secondary statistics, then decorative borders and spacing. Overview collapses lower-priority panels after those steps; Queue/DLQ remains accessible through Diagnostics. Never drop primary state, error messages, connection label, or navigation. Width tests must prove the first removed element is a sparkline.

## Navigation

`1` Overview, `2` Index, `3` Retrieval, `4` Provider, `5` Diagnostics. `Tab` and Right move forward with wraparound; `Shift+Tab` and Left move backward with wraparound. `h` and `l` have **no** navigation binding. `q` exits. Implement with Ink `useInput` and React view state, without a routing dependency.

## Attention

Every Attention item contains a source (`canonical`, `connectivity`, `telemetry`), a concise reason, and a canonical field path for canonical items; non-canonical items carry their originating endpoint URL or metric series identity instead of inventing a canonical field path. Diagnostics renders all three provenance fields, showing `—` for canonical field path when the source is not canonical. There is no aggregate `Healthy` / `Degraded` / `Critical` score.

- **Canonical:** index or pipeline failure (`indexStats.lastError`, `pipelineProgress.lastError`), structured failure or reindex requirement (`structuredIndex.status`, `structuredIndex.reindexRequired`), observed provider unhealthy (`providerStatus.health` with `providerStatus.lastError`). Unknown provider health is shown as unavailable detail, not an unhealthy assertion.
- **Connectivity:** missing runtime, failed metrics, failed status, each with its selected endpoint and most recent failure reason. Suppress redundant route-failure Attention items while runtime is unavailable.
- **Telemetry:** queue overflow or dropped events, DLQ > 0, and embedding error **counter delta over the most recent five minutes**. Never alert on the absolute cumulative `embedding_requests{provider,status="error"}` value. A baseline-only first observation yields `Waiting`, not an error. Counter resets start a fresh baseline; do not count a reset as an error burst. Latency alone is not an Attention trigger.

## Short-term Trends And History

Store timestamped samples in per-series in-memory buffers for a rolling five-minute window; retain a baseline sample immediately before the window for counter deltas, and discard all history on exit or port change. Series identity is **metric name plus relevant label dimensions**; missing labels do not merge with explicit label values. The exact required series are:

| Metric family | Label dimensions | Sample |
| --- | --- | --- |
| `tool_calls` | `tool_name`, `status` | Counter |
| `tool_duration` | `tool_name` | Histogram |
| `search_hits` | `search_type` | Histogram |
| `embedding_requests` | `provider`, `status` | Counter |
| `embedding_duration` | `provider` | Histogram |
| `embedding_batch_size` | `provider` | Histogram |
| `queue_dropped` | `queue_id` | Counter |
| `queue_size` | `queue_id` | Gauge |

These logical names correspond to the runtime's `nexus_`-prefixed prom-client metric names. Identify a histogram series by its base `metricName` and listed labels; store `_sum`, `_count`, and each `_bucket` independently under that base `metricName`, with `le` added as a bucket dimension. Never collapse histogram components or buckets into a single value. Compute interval means from deltas of `_sum` and `_count` only when both deltas exist and count delta is positive; otherwise return `Waiting` or `Unavailable`. Queue size uses its observed gauge, not a counter delta. Render ASCII sparklines from valid samples, without adding a charting dependency.

For each counter and histogram component, the first sample establishes a baseline and has no rate. For consecutive samples, nondecreasing values contribute `current - previous`. A lower value indicates a reset: discard the old baseline, start at the lower value, and contribute **no** delta across that interval. Sum only valid interval deltas whose endpoints are inside the five-minute window; keep the preceding sample solely to establish a baseline for the first in-window interval. A missing sample breaks consecutive intervals for that series; the next observation establishes a new baseline without a delta. A new series does not inherit another series' baseline. Derive request success/error and the telemetry Attention rule from these window deltas; never interpret a missing series as zero.

## Error Handling And Missing Data

All display-facing extraction uses this explicit discriminated model:

```ts
type ValueState<T> =
  | { kind: 'available'; value: T }
  | { kind: 'waiting' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };
```

`waiting` means initial request or missing counter baseline; `unavailable` means absent metric, unreachable endpoint, or missing canonical snapshot with a reason; `unsupported` is an explicitly unsupported structured index; `error` is a reported canonical failure or invalid payload with its message. Numeric zero is rendered only for a present valid measurement whose value is exactly zero. **Missing metrics MUST NOT be rendered as 0.** A failed poll invalidates current values from that route; stale values appear only in Diagnostics with their last-success timestamp. Unknown provider health maps to `unavailable` for the health detail, with visible `Unknown` identity state; do not coerce it to false.

Main / Vector readiness is derived **only from canonical fields**, with precedence: `indexStats.lastError != null` or `pipelineProgress.lastError != null` => `Failed`; otherwise `pipelineProgress.status === 'running'` => `Indexing`; otherwise `indexStats.lastIndexedAt != null` => `Ready`; otherwise `Not ready`. Both Main and Vector show this canonical readiness; Vector additionally shows `vectorStats` values only when provided. Missing canonical snapshot produces `Unavailable`, not `Not ready`. Structured readiness comes from `structuredIndex.status`: `idle` => `Ready`, `building` => `Indexing`, `failed` => `Failed`, `reindex_required` => `Reindex required`, `unsupported` => `Unsupported`; absent `structuredIndex` => `Unavailable`. Do not derive readiness from metrics counters or provider probes.

## Diagnostics

Diagnostics displays every Attention item with source, reason, and canonical field path (`—` for non-canonical items), the selected metrics endpoint URL, the selected canonical status endpoint URL, connection state, last fetch error with route and timestamp, `providerStatus.lastError`, `indexStats.lastError` and `pipelineProgress.lastError`, runtime availability, and the last successful fetch timestamp for each route. When status is unavailable, show provider/index last errors only as labeled stale values with the snapshot timestamp, never as current truth. Explicit-port mode labels the port fixed; discovery mode displays the last observed `metrics.port` value. No diagnostics request may start the runtime.

## Testing Strategy

Write failing RED tests before implementation and retain them as regression tests:

1. `GET /status` returns the dashboard result without `pluginHealth`; spies verify `PluginRegistry.healthCheck()` is **not called**, `embeddingProvider.healthCheck()` is **not called**, and Bedrock `InvokeModel` is **not called**. A registered provider without a runtime-known observation returns `health: 'unknown'` and renders `Unknown` / `Unavailable`. Confirm a cached MCP probe belongs only to the matching provider and switching providers invalidates the observed state.
2. Starting the CLI without a runtime renders `Runtime unavailable` without starting Nexus. Fake-clock tests prove rediscovery every five seconds, a runtime restart on a **new port**, rerouting both endpoints, and reconnecting. Explicit `--port` tests prove there is no file rediscovery.
3. A missing metric helper returns `{ kind: 'unavailable', reason: ... }`, never numeric zero; first sample and counter reset do not create spurious five-minute embedding-error Attention.
4. A narrow-width component test proves sparklines degrade **first**, while primary state and Attention remain visible.

Unit tests cover snapshot-field sharing, health cache lifecycle, `ValueState` extraction, per-label history, `_sum`/`_count`/`_bucket` preservation, window deltas, reset handling, sparkline, readiness, and Attention provenance. Ink component tests cover each view, resize and unavailable states, direct digits, Tab / Shift+Tab / Left / Right, ignored `h`/`l`, and `q`. HTTP integration tests cover GET-only, error JSON, loopback binding, no probe or MCP call count; CLI integration tests cover startup, connection loss, polling independence, port replacement and cleanup of timers. Use fixtures with real response shapes and mock provider/network calls so tests cannot bill providers.

## Verification Gate

The future implementation must run all of the following from the repository root and require exit code zero:

```bash
npx tsc -p packages/dashboard/tsconfig.json --noEmit
npm run build -w packages/dashboard
npx vitest run --config packages/dashboard/vitest.config.ts
npx tsc --noEmit
npm run lint
npx vitest run
npm run build
```

Root `npm run lint` and `npx tsc --noEmit` **do not cover Dashboard TSX**; the dashboard-specific type check, workspace build, and Vitest configuration above are mandatory. Run the focused endpoint and CLI tests as well as the full suites and verify the real dashboard CLI against a stopped runtime and a restarted runtime on a changed port.

## File Map And Repository Integration

| Area | Responsibility |
| --- | --- |
| `src/server/tools/index-status.ts`, `src/plugins/registry.ts` | Reuse the shared non-provider fields; preserve MCP probing; expose cached runtime-known provider state without dashboard probes. |
| `src/observability/canonical-status-endpoint.ts` | **Reference for future implementation only:** canonical, GET-only dashboard `/status` helper using `buildDashboardIndexStatusSnapshot`. |
| `src/observability/metrics-server.ts`, runtime construction | Mount the helper on the existing loopback metrics listener and inject already-open stores and pipeline. |
| `src/server/metrics-port.ts`, dashboard CLI | Reuse the existing project storage port-file contract and implement fixed-port/discovery selection. |
| `packages/dashboard/src/hooks/use-canonical-status.ts`, `packages/dashboard/src/hooks/use-metrics-history.ts` | **References for future implementation only:** independent status polling and per-series five-minute telemetry history; keep both on the selected port. |
| `packages/dashboard/` views, utilities and tests | Implement presentation state, navigation, diagnostics, layout, and regressions without a new router or chart dependency. |
| `docs/superpowers/specs/2026-09-24-nexus-dashboard-improvement-design.md`, `docs/superpowers/plans/2026-09-24-nexus-dashboard-improvement.md` | The two documentation artifacts associated with this review; reconcile the plan to this design before coding. |

No additional new source-file paths are prescribed here. Under the single-file edit constraint, this review writes **only this design document**; it identifies the corresponding plan as the second documentation artifact to reconcile, but does not change the plan or any source files. Future implementation must keep the status route internal, project-scoped, read-only and loopback-only; create no agent configuration, commit no local port files, credentials, or machine-specific absolute paths.

## Verification Of The Design

- [ ] The MCP probe chain and the reason `/status` cannot reuse `executeIndexStatus()` are explicit.
- [ ] Dashboard and MCP share all non-provider snapshot fields while provider representations remain separate; unknown is not healthy.
- [ ] `/status` is GET-only on the metrics loopback port and never probes, starts, or mutates runtime state.
- [ ] Both CLI modes, rediscovery, changed ports, connection states and independent cadences have defined transitions.
- [ ] Five views, narrow-width priority, keyboard bindings, and Attention provenance have deterministic behavior.
- [ ] Missing metrics are not zero; readiness, histogram labels, counter baselines and resets are defined.
- [ ] RED tests cover side effects, absent/restarted runtime, missing metrics, and narrow width.
- [ ] Dashboard-specific verification complements root checks; the implementation plan is reconciled before implementation.
| Review Finding | Plan task / test that covers it |
| --- | --- |
| RG-001: side-effect-free status boundary, provider tri-state, MCP compatibility | Replace plan Tasks 1–3 active-probe snapshot design with shared non-provider collector, `buildDashboardIndexStatusSnapshot`, registry known-state cache and endpoint RED no-probe/Bedrock tests. |
| RG-002: endpoint discovery, port-null disabling, rediscovery, changed-port reconnection, explicit port, current/stale route state | Update plan CLI and status-hook tasks; hook state contract with `waiting`/`unavailable`/`connected`; `current`/`stale` separation and `lastSuccessAt`/`lastErrorAt` timestamps; CLI fake-clock startup/restart/new-port and fixed-port integration tests. |
| RG-003: labeled five-minute telemetry, bounded history, histogram components, counter reset, baseline, gap handling, histogram mean | Update plan metrics-history task; per-label `_sum`/`_count`/`_bucket`, `SERIES_DIMENSIONS` ignoring `project`/`pid`, generation tracking for missing polls, partial-label aggregation, baseline/reset, `getHistogramMean`, and window-delta unit tests. |
| RG-004: unavailable data, canonical readiness, diagnostics, Attention provenance, narrow layout, endpoint URL provenance | Update plan presentation/diagnostics tasks; nullable `indexStats`, `ValueState` model, readiness precedence, discriminated Attention provenance with actual endpoint URLs, Queue-before-Provider layout priority, sparkline-first degradation tests. |
| RG-005: concrete Attention items, telemetry independence, queue overflow, DLQ, embedding errors | Update plan Attention task; canonical/connectivity/telemetry provenance, queue-overflow and DLQ rules, five-minute embedding-error delta tests. |
| RG-006: navigation and narrow terminal | Update plan view/navigation tasks; Ink keyboard and resize component tests verify digit keys, arrows, ignored `h`/`l`, and sparkline-first degradation. |
| RG-007: complete verification and review scope | Update plan verification gate with dashboard-specific type check, build, lint config (Task 5a before first dashboard lint), tests; verify both documentation artifacts are reconciled before future coding and this review changes no source files. |
