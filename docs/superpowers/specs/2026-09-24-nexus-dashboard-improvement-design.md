# Nexus Dashboard Improvement Design

## Goal

Redesign the built-in Nexus Dashboard from a Queue / Indexing Throughput / DLQ
panel into a read-only Live Operations Dashboard for the currently selected
Nexus project. The dashboard must answer two questions at a glance: is anything
wrong right now, and what is Nexus doing right now. It is not a long-term
observability or alerting platform; that remains the responsibility of
Prometheus / Grafana in a separate repository.

## Scope

- Single-project, read-only Live Operations Dashboard.
- Views: Overview, Index, Retrieval, Provider, Diagnostics.
- Data sources:
  - `/metrics/json` as the high-frequency telemetry stream.
  - The same canonical status contract that backs the `index_status` MCP tool,
    exposed through a side-effect-free, project-local, read-only runtime
    endpoint.
- In-memory short-term trend history, retained only for the dashboard session.
- Direct and indirect navigation between views.
- Attention list derived from canonical state, connectivity, and telemetry,
    without introducing a dashboard-specific aggregate health score.

## Non-goals

- Multi-project selector, project list, or cross-project drill-down.
- Long-term metrics persistence, retention, or configurable dashboards inside
    the dashboard.
- Alerting, p50/p95/p99 long-term comparison, or historical performance
    analysis.
- Implicitly starting a missing Nexus runtime when the dashboard opens.
- Active embedding provider health probes triggered by dashboard refreshes.
- Re-implementing or duplicating readiness logic already owned by
    `index_status`.

## Background And Current State

The current dashboard (`packages/dashboard/`) is an Ink / React TUI that polls
`http://localhost:{metricsPort}/metrics/json` every two seconds. It renders a
single fixed screen with three panels: Event Queue, Indexing Throughput, and
DLQ Health. It does not consume `index_status` and has no navigation.

The server exposes:

- `index_status` MCP tool (`src/server/tools/index-status.ts`) returning
    `IndexStatusResult`.
- `/metrics/json` from `MetricsHttpServer`
    (`src/observability/metrics-server.ts`) backed by `MetricsCollector`
    (`src/observability/metrics-collector.ts`).

The existing `executeIndexStatus()` invokes `pluginRegistry.healthCheck()`,
which performs an active embedding provider probe including a real network call
and, for Bedrock, an actual `InvokeModel` invocation. Calling the MCP tool
periodically from the dashboard would therefore create side effects, billable
requests, and self-contamination of `nexus_tool_calls_total`.

## Status Data Boundary

The dashboard must not maintain a separate source of truth for index or
provider readiness. The relationship between the existing canonical interface
and the new dashboard transport is:

```text
Canonical status contract / snapshot builder
            │
            ├── MCP index_status
            │     └── canonical public interface
            │
            └── Dashboard read-only status endpoint
                  └── local/internal observability transport
```

- The **canonical status contract / snapshot builder** remains the single place
    where readiness and index state are determined.
- **`index_status`** continues to be the canonical public interface.
- The **Dashboard endpoint** is an internal/local read-only transport that
    exposes the same snapshot to the dashboard.
- Neither `index_status` nor the dashboard endpoint re-implements readiness
    logic independently.

### Requirements For The Dashboard Status Endpoint

- Side-effect-free: it must not invoke active embedding provider probes or
    billable provider requests.
- Provider health must reflect runtime-known state. If side-effect-free state
    is unavailable, the dashboard displays `Unknown` / `Unavailable` rather
    than probing the provider itself.
- Project-scoped and loopback-only.
- Read-only; no state mutation.
- If the runtime is absent, the endpoint connection fails and the dashboard
    shows `Runtime unavailable` or `Canonical status unavailable`. It must not
    auto-start the runtime.
- Updates are independent from `/metrics/json` polling cadence.

## Data Sources And Update Contracts

### `/metrics/json` (Telemetry Stream)

- Polling interval: keep the existing two-second default.
- Used for:
  - Queue size, state, and dropped events.
  - DLQ size and recovery totals.
  - Retrieval calls, latency, hits, and errors by type.
  - Embedding requests, latency, batch size, and errors.
  - Indexing throughput and progress gauges.
- Trend data: values are pushed into an in-memory ring buffer covering the
    last five minutes. The buffer is discarded when the dashboard exits.

### Canonical Status Snapshot (State Snapshot)

- Retrieved through the dashboard read-only status endpoint described above.
- Used for:
  - Main / Vector Index readiness and last error.
  - Structured Index status (`idle`, `building`, `failed`, `reindex_required`,
    `unsupported`).
  - Pipeline state, current file, and last error.
  - Skipped / dead-letter file count.
  - Provider identity and runtime-known health.
- Update cadence: low-frequency and independent of metrics polling; also
    refreshed on connection recovery.

## Views

### Overview

The default view. It must show:

- **Attention Summary**: only concrete actionable states; quiet when healthy.
- **Index Health Summary**: Main / Vector readiness, Structured Index state,
    key counts, and relevant last error.
- **Retrieval Activity Summary**: calls, success/error, latency, and hits by
    search type.
- **Provider Summary**: provider identity, runtime-known health, request/error
    counts, latency, and batch size with a short-term sparkline.
- **Queue / DLQ**: compact normal-time display; emphasized only on overflow,
    dropped events, or DLQ > 0.

### Index

Detailed read-only view of canonical index state:

- Main / Vector Index: processed / total files, vector/index statistics, last
    indexed, skipped files, last error.
- Structured Index: files, symbols, pending files, `reindexRequired`, schema
    / rebuild state, last error.

### Retrieval

Breakdown by `grep`, `semantic`, `hybrid`, and structured retrieval:

- Calls, success/error rates, latency, hits.
- Recent short-term trend sparklines for latency and hits.

### Provider

- Provider identity.
- Runtime-known health / availability.
- Requests, errors, latency, batch size.
- Short-term trend sparklines.

### Diagnostics

Dashboard runtime and connection diagnostics only:

- Metrics endpoint URL and connection state.
- Aggregator status (if used).
- Runtime availability.
- Last canonical status fetch result and timestamp.
- Recent dashboard-level errors.

## Navigation

- Direct navigation with digit keys: `1` Overview, `2` Index, `3` Retrieval,
    `4` Provider, `5` Diagnostics.
- Indirect navigation: `Tab` / `Shift+Tab` or arrow keys (`h`/`l` / left/right)
    to cycle views.
- `q` exits, preserving existing behavior.
- Implemented with Ink `useInput` and internal React state; no external routing
    library.

## Attention

No aggregate health score (`Healthy` / `Degraded` / `Critical`) is introduced.
Concrete states are grouped into three sources:

### Canonical State

- Index build failed.
- Structured index requires rebuild.
- `reindex_required`.
- Current provider unhealthy (runtime-known side-effect-free state only).

### Connectivity

- Runtime unavailable.
- Canonical status unavailable.
- Metrics unavailable.

### Telemetry

- Queue overflow.
- DLQ > 0.
- Dropped events observed.
- Embedding errors observed in the recent five-minute window (counter delta
    within the dashboard session, not the cumulative counter absolute value).

## Short-term Trends

- History is kept only in dashboard process memory and discarded on exit.
- Ring buffer length is sized for five minutes at the two-second metrics
    polling interval.
- Stored series include: retrieval latency, embedding latency, queue size,
    tool / search calls, error rate, indexing throughput, and search hits.
- Visualized with a lightweight ASCII sparkline utility implemented inside
    the dashboard package. No new heavy chart dependency.

## Error Handling And Degraded States

- If metrics polling fails, the dashboard continues to show the last known
    snapshot and marks metrics as unavailable in Attention / Diagnostics.
- If the canonical status endpoint fails, the dashboard marks canonical status
    as unavailable and does not synthesize index state from metrics.
- If the runtime is absent, the dashboard waits without auto-starting it and
    displays `Runtime unavailable`.
- Latency increases alone never generate Attention; only explicit canonical or
    telemetry states do.

## Testing

- Unit tests for pure helpers: trend ring buffer, sparkline rendering, attention
    derivation, and metric value extraction.
- Component-level tests for view panels using the existing
    `@testing-library/react` + `vitest` pattern.
- Integration tests for the dashboard CLI startup and connection-state
    behavior, preserving the existing `packages/dashboard/tests/integration/`
    style.
- Verification gate for the whole change:
  - `npm run build`
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm test`

## Repository Integration

- Implementation lives in `packages/dashboard/`.
- The new dashboard endpoint contract is implemented in the main `src/`
    runtime and exposed alongside the existing `/metrics/json` server.
- No project-level agent configuration files are created.
- No absolute paths, credentials, or generated local state are committed.

## Verification Of The Design

This design is considered validated when:

- `index_status` remains the canonical public interface and no duplicate
    readiness logic is added for the dashboard.
- The dashboard endpoint is side-effect-free and never auto-starts the runtime.
- The dashboard never triggers active embedding provider probes for refreshes.
- Attention is derived only from canonical state, connectivity, or telemetry
    with explicit semantics; no dashboard-only aggregate health score exists.
- `nexus_tool_calls_total` is not inflated by dashboard status refreshes.
- Build, lint, type check, and tests pass after implementation.
