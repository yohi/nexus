# R5-03 — Minimal Diagnostic Instrumentation Implementation Plan

> **Implementation plan.** Tasks1-6 have local TDD implementation and verification in the pinned Nexus worktree. Task7's in-process stages are implemented; supervisor/process cases remain pending. Task8 is limited to diagnostic request preparation and compatibility checks; process launch, profiler preload, host-gate integration, and Task9 remain outstanding. An independent review found no blocker in the latest Task5 scope/identity change, but the final amended-design review and supervisor integration remain outstanding. This plan does not authorize a medium/large performance worker run.

**Goal:** Add an opt-in, source-free bounded stage trace that distinguishes progress and waits across the medium cold-start path and correlates it to the CPU-active Vitest fork profile.

**Architecture:** Keep the diagnostic channel separate from `OutcomeCollector` admission events and `PerformanceReport`. An internal optional sink is passed only by a separate diagnostic request; production/default calls without the sink preserve the current execution path. The supervisor and v3 preload remain independent evidence sources and join only on process identity plus a verified monotonic clock domain.

**Tech Stack:** TypeScript, Node.js >=24, Vitest 3.2.7, Zod 4, SQLite/LanceDB production APIs, Linux `/proc`/cgroup/PSI, Python stdlib supervisor, Node `node:inspector` preload.

**Spec:** [R5-01 execution map](R5-01-runtime-stage-execution-map.md), [R5-02 instrumentation contract](R5-02-stage-instrumentation-contract.md), [R4 plan Task12](../../../docs/superpowers/plans/2026-10-24-retrieval-performance.md), and [R3 design](../../../docs/superpowers/specs/2026-10-24-retrieval-performance-design.md).

## Global constraints

- Keep medium deadline600,000ms, old-space2048MiB, audit page<=512, and L2 batch<=512 unchanged.
- No retry, audit reduction, new benchmark identity, baseline report mutation, public export, production CLI option, Prometheus metric, or enabled-by-default timer.
- Diagnostic runs use a new run ID/output directory, are marked `diagnosticOnly`, and cannot enter standard summaries.
- All spans/counters are source-free and bounded; raw profiles are confidential. Observer/trace failure never alters production return values, errors, order, cleanup, or baseline admission.
- No process or service outside the positively identified diagnostic run is stopped. No commits, pushes, PRs, merges, or CodeRabbitCLI.
- New diagnostic modules stay below the 250 nonblank/noncomment LOC ceiling. Existing larger production files receive only minimal, focused stage hooks; do not refactor unrelated behavior solely to satisfy the helper-size rule.

## Review focus

1. **Synchronous CPU can prevent worker timers/profile checkpoints from firing.** Preserve an external `/proc` CPU/RSS/IO sampler and leave spans open when no terminal event arrives; never infer zero work from a missing heartbeat. Test a fork child in a synchronous loop.
2. **Concurrent read/chunk files overlap.** Progress counts are cumulative by `operationId + attemptId`; process CPU deltas over an interval are inclusive, not exclusive per overlapping child span. Test two concurrent children and prohibit sums that double-count.
3. **Startup reindex is fire-and-forget from `initialize()`.** The child reindex may outlive the initialization span; preserve causal parent IDs without requiring child end before parent end. Test detached-but-owned work and cancellation.
4. **The observer/admission collector already retains events.** Do not append diagnostic events to its per-request array. Test that trace caps and writes are isolated from normal validity evidence.
5. **CPU profile and stage timestamps may have different clock origins/units.** Require PID+start-tick and explicit Linux monotonic calibration; if profile offsets cannot be anchored, degrade to segment overlap or `PROFILE_NOT_PROVEN`.

---

## Candidate file/interface map

These are proposed future implementation locations, not current files or completed changes.

| File | Responsibility |
|---|---|
| Create `src/observability/diagnostic-stage-trace.ts` | Internal `AsyncLocalStorage` context, typed sink and safe no-op span/progress helpers; no root/package export. |
| Create `tests/benchmarks/performance/diagnostics/contracts.ts` | Strict diagnostic JSON event/status schemas, separate from baseline report contracts. |
| Create `tests/benchmarks/performance/diagnostics/trace-recorder.ts` | Per-process span identity/parenting, bounded counters, rate limit, caps and explicit loss status. |
| Create `tests/benchmarks/performance/diagnostics/clock-domain.ts` | Monotonic-domain metadata and parent/fork calibration result. |
| Create `tests/benchmarks/performance/diagnostics/resource-sampler.ts` | Worker CPU/heap/event-loop samples; host/cgroup sampling stays in supervisor. |
| Create `tests/benchmarks/performance/diagnostics/profile-correlation.ts` | PID/start-tick/profile-segment matching and fail-closed time mapping. |
| Create `tests/benchmarks/performance/diagnostics/profile-summary.ts` | Redacted categories, segments, stage overlap and evidence completeness. |
| Create `scripts/run-performance-diagnostic.mjs` or a separately versioned external v3 successor | Separate explicit diagnostic request/launch; never modify default `test:perf`. |
| Modify `tests/benchmarks/performance/{worker,worker-scenario,runtime,fixtures,worker-preflight,readiness,lifecycle,audit}.ts` | Worker request mode and S00-S03/S09-S12 spans/counters; diagnostic-only outputs. |
| Modify only if needed: `src/observability/runtime-work.ts` | Reuse causal operation identity where useful; stage events remain in the separate diagnostic context, not `RuntimeEvent`/`OutcomeCollector`. |
| Modify `src/server/runtime-assembly.ts`, `src/server/runtime/assembly-types.ts`, `src/server/runtime/directory-scan.ts` | Internal sink injection plus S03/S04/S05 boundaries; no public `NexusRuntimeOptions` or root export change. |
| Modify `src/indexer/pipeline.ts`, `src/indexer/chunker.ts`, `src/indexer/structured-index-coordinator.ts` | S06-S09 spans, window/batch progress, fallback-reason counters and full-rebuild retained counts. |
| Modify `src/storage/metadata-store.ts`, `src/storage/vector-store.ts` only if caller-level boundaries cannot distinguish completed SQLite/Lance logical writes | Count logical API/transaction calls and rows after awaited success; do not add SQL-statement instrumentation without separate evidence. |
| Modify/version the external v3 preload/supervisor/summarizer kit | Add profile segment start/stop timestamps, event-loop-delay and trace/profile correlation. Preserve its external ownership; do not silently change the supplied v3 archive. |

**Proposed internal interface:** `DiagnosticTraceSink` exposes typed `withStage<T>(input, work)`, `progress(input)`, `snapshot(input)`, and `close(status)` operations. `withStage` preserves `T` and the original exception and uses `finally` for terminal status. The sink is optional and created only from a validated diagnostic request. Do not pass it through public config, exported CLI options or the normal observer event list.

## TDD task sequence

### Task 1 — Schema, identity and recorder contract

**Files:** Create `diagnostics/contracts.ts`, `diagnostics/trace-recorder.ts`, `tests/unit/benchmarks/performance/diagnostics/trace-recorder.test.ts`.

- [x] Write RED tests for strict span/process identity, same PID with different start ticks, nested/parallel parents, monotonic duration and per-event clock regression, operation-scoped attempted/succeeded counters across nested spans, invalid initial counts, fixed counter semantics, explicit `not_collected` resource/profile values, profile lifecycle states, and unknown totals.
- [x] Run `npx --no-install vitest run tests/unit/benchmarks/performance/diagnostics/trace-recorder.test.ts`; observe the expected missing-contract/recorder assertion failures.
- [x] Implement strict versioned event schemas and a process-local recorder with `runId`, `jobId`, `spanId`, `parentSpanId`, `operationId`, `attemptId`, stage ID, PID/start ticks, sequence and clock domain. Keep monotonic times as decimal strings.
- [x] GREEN: strict schemas and recorder passed11/11 diagnostic tests; event clock regression, counter-scope regression and invalid initial values are dropped with explicit incomplete reasons; wrapped results/errors are preserved. The focused 3-file suite passed30/30, root typecheck/lint passed, and the full repository suite passed after final fixes.

### Task 2 — Bounded output, redaction and loss semantics

**Files:** `diagnostics/trace-recorder.ts`; create `diagnostics/redaction.ts`; `tests/unit/benchmarks/performance/diagnostics/trace-bounds.test.ts`.

- [x] RED tests for event/byte caps, provisional terminal status, five-second progress coalescing, dropped writes, path/source/query/embedding/error/env rejection, writer failure containment and million-update bounds.
- [x] Run focused red/green tests for each behavior; assert the failure was caused by missing bound/redaction semantics.
- [x] Implement per-process JSONL files mode0600 under an owned mode0700 run directory; cap 4,096 events/8 MiB per process, coalesce progress to one per five seconds per stage/counter group while retaining transitions, cap profiles at 64 MiB/segment and 512 MiB/run with a serialized owned-directory lock. Terminal status is provisional; persist drop counters, truncation, sampling and missing-count exactness.
- [x] GREEN: recorder stayed bounded under a million synthetic updates; allowlists and writer-error containment passed regression tests. Profile quota sink tests cover existing cross-process bytes and lock fail-closed behavior.

### Task 3 — Clock calibration and v3 profile mapping

**Files:** Create `diagnostics/clock-domain.ts`, `diagnostics/profile-correlation.ts`, `tests/unit/benchmarks/performance/diagnostics/profile-correlation.test.ts`; version the external v3 preload/summarizer separately.

- [x] RED tests use injected clock/ping fixtures for offset overlap, 10 ms boundaries, clock mismatch, PID reuse, parent-only profiles, CPU-inactive child, incomplete/corrupt/duplicate segments and minimum self-samples.
- [x] Implement `CLOCK_MONOTONIC`/boot-ID/source/resolution metadata, pre/post Node clock-probe helper, offset intervals and conservative combined uncertainty. Refuse alignment when offsets do not overlap or uncertainty exceeds 10 ms.
- [x] Extend profile lifecycle events and version a separate v4 external preload/summarizer kit; join by run + process identity + clock calibration, require the preload marker, and keep summaries path/source-free.
- [x] GREEN: same-identity child profiles map to stage intervals; mismatched/missing evidence remains `worker_profile_NOT_PROVEN`; zero samples do not satisfy the >=100 self-sample gate.

### Task 4 — Worker bootstrap, fixture and preflight stages S00-S02

**Files:** `tests/benchmarks/performance/{worker,worker-scenario,fixtures,worker-preflight}.ts`; `tests/unit/benchmarks/performance/diagnostics/worker-stages.test.ts`.

- [x] RED tests for private opt-in request, bootstrap identity, S01 file/byte counters, S02 raw-vs-unique and vector counts, partial failure, observer failure, and path-free records.
- [x] Add a separate diagnostic worker entry with bounded/private control files, owned directory and exclusive phase FD. Standard `workerRequestSchema` rejects the private diagnostic field. Wrap fixture/preflight stages and emit counters only after observed boundaries.
- [x] GREEN: injected scenario/observer failures preserve scenario behavior; normal fixture/preflight requests create no diagnostic events; controlled S00 worker scaffolding emits a provisional trace without invoking a benchmark runtime in tests.

### Task 5 — Runtime assembly, initialization and full-scan spans S03-S05

**Files:** `src/observability/diagnostic-stage-trace.ts`; internal assembly type; `src/server/runtime-assembly.ts`, `src/server/index.ts`, `src/server/runtime/directory-scan.ts`; `tests/unit/benchmarks/performance/diagnostics/runtime-stages.test.ts`.

- [x] RED tests prove S03/S04/S05 nesting, child reindex identities, context detachment, exact path-free Dirent counters and unchanged default scan results.
- [x] Add internal optional AsyncLocal diagnostic scope without changing public root/factory/runtime options. Instrument assembly/initialization and recursive scan stages; detach event drain, watcher, pipeline, metrics and post-scan loops; assign a child operation identity to startup/manual reindex.
- [x] GREEN: default scan and existing runtime startup tests pass; observed `files_emitted` matches returned events, ignored/classified counts match independent Dirent fixtures, and directory count includes root plus traversed children.

### Task 6 — Pipeline stages, progress and storage work S06-S09

**Files:** `src/indexer/pipeline.ts`, `src/indexer/chunker.ts`, `src/indexer/structured-index-coordinator.ts`, `src/indexer/event-queue.ts`, `src/observability/diagnostic-stage-trace.ts`, existing chunker/structured coordinator tests, and split diagnostic suites `pipeline-counter-stages.test.ts`, `pipeline-legacy-parser-stages.test.ts`, `pipeline-settlement-stages.test.ts`, `pipeline-structured-parser-stages.test.ts`, and `structured-storage-stages.test.ts`; narrowly scoped `metadata-store.ts`/`vector-store.ts` only if required.

- [x] RED/GREEN in `chunker.test.ts`: no-plugin, empty-parse, and parser-exception cases distinguish the three fallback reasons without changing returned chunks or thrown-error behavior.
- [x] Add an optional diagnostic-only fallback reason callback at `Chunker.chunkFiles()`'s three source-confirmed branches. No file path/raw error is passed; existing chunk arrays, logging policy, return values and thrown error behavior are unchanged. `parser_error` plus successful fallback increments parser failure and fallback success, not whole-file failure.
- [x] Add coverage for 16-event windows, concurrency-2 read/chunk children, legacy and structured parser outcomes, provider input-submitted/vector-returned/input-completed/batch outcomes, L1/L2/miss counters, serial finalization, full-rebuild retained files/chunks/vectors, attempted/committed SQLite logical rows, attempted/succeeded Lance row writes/activation, partial-write `unknown` state, finalizer/rollback/abort/clear-pending failures, decreasing queue gauges, cumulative dropped events, settlement spans and overlapping child spans. Diagnostic tests are split into focused modules to remain within the repository's 250-line module limit.
- [x] Wrap current operations without changing their order/args: read/chunk per window; parser/fallback counts; cache/provider batch; legacy/Lance and structured metadata/vector writes; full-rebuild commit; post-reindex compaction and `recordCompletion`; settlement wait plus queue/drain snapshots. At `StructuredIndexCoordinator.runFullRebuild()` rollback/abort/finalizer catch sites, emit diagnostic state-integrity failure before existing log/catch behavior; a later `idle` state does not promote diagnostic admissibility. Track attempted vs succeeded and row kind; SQL statement count stays `NOT_COLLECTED`.
- [x] Counter values advance only after the relevant operation succeeds. Failed batch/row does not increment succeeded/completed; existing `onIndexingProgress` remains unchanged and is treated as finalization progress only.
- [x] GREEN: injected provider/write/rollback/finalizer failures preserve caller results/errors and record failed/aborted/integrity terminals. Swallowed backup-finalizer failure leaves `runFullRebuild()` resolved and rebuild state idle while recording `backup_cleanup_failed`; queue/indexed counts and report schemas remain unchanged; nested CPU remains inclusive.

**Ruling:** `EmbeddingProvider.embed()` exposes one logical batch promise and aggregates its internal retries into `RetryExhaustedError`; it has no per-request attempt callback. Count one batch attempt per `embed()` invocation and use a new diagnostic attempt identity for each outer reindex attempt rather than fabricating per-HTTP-attempt spans. Cost if wrong: provider-internal retries are not individually attributable.

### Task 7 — Audit, probe, resources and cleanup stages S10-S12

**Files:** `tests/benchmarks/performance/{audit,audit-catalog,readiness-probe,readiness,lifecycle,worker-scenario,resources}.ts`; diagnostics sampler tests.

- [x] RED/GREEN tests for audit row progress at 512-row boundaries, catalog verification counts, actual-handler probe span, runtime close, artifact measurement, owned scratch cleanup and resource-sample schema. Existing unit tests cover worker diagnostic writer failures.
- [ ] Supervisor-specific tests for forced worker termination, supervisor-only inferred termination, supervisor crash leaving `running` status, and explicit `CLEANUP_UNVERIFIED` remain pending the separately authorized worker/process gate.
- [x] Add S10–S12 stage spans/cumulative row counters without altering `auditResultSchema`, page size, membership validation, probe handler, runtime close order or validity gate. Worker resource samples contain heap/RSS/CPU/event-loop delay at a five-second interval and rate-limited stage boundaries; supervisor `/proc`/cgroup/PSI/IO collection remains independent.
- [x] GREEN for in-process stages: failed/truncated audits remain invalid; diagnostics stay in the private trace sidecar, outside `PerformanceReport`; unavailable resource measurements carry explicit reason codes.

### Task 8 — Diagnostic-only run integration and no-op compatibility

**Files:** Create `scripts/run-performance-diagnostic.mjs` and its declaration; `tests/benchmarks/performance/worker-contracts.ts`; `tests/integration/performance/diagnostic-mode.test.ts`.

- [x] RED/GREEN tests ensure the preparation launcher creates a new private run directory and strict private scenario/diagnostic request files, rejects repeated run IDs and missing source identity, and keeps the standard worker request schema free of diagnostic fields. Tests do not start a worker.
- [x] Keep the diagnostic preparation CLI separate from the standard baseline parent. Pin the prepared request to `diagnosticOnly=true`, profile=medium, job=`cold_initial_index`, timeout=600000, heap=2048, and a new output path. The CLI reports `prepared_only`; it does not start a process, load a profiler, create profiles, aggregate a report, or retry.
- [ ] Actual worker entrypoint, process supervision, profiler preload handoff, baseline/admission no-op integration, and supervisor terminal outcomes remain pending a reviewed host/source gate. Do not run the prepared request until R5-05's separate review and explicit execution authorization.

### Task 9 — Diagnostic contract and integration verification

**Files:** Focused tests above plus `tests/integration/performance/diagnostic-mode.test.ts`.

- [x] Safe diagnostic-only unit/integration subset: 204 tests passed across 20 files, including the prep-only launcher, R5 diagnostics, audit/readiness/lifecycle coverage and indexer chunk/queue tests. Typecheck, both linters and `git diff --check` passed. No test invoked the standard performance runner.
- [ ] Run all new unit/integration tests, existing performance observation/readiness/audit tests, TypeScript `npx --no-install tsc --noEmit -p tsconfig.json`, `npm run lint`, `npm run lint:perf`, `npm test`, and E2E only if implementation changes an existing shared production path.
- [ ] The full suite and standard `test:perf` were not run because the suite includes `tests/integration/performance/runner.test.ts`, which starts smoke workers; retain the user's no-worker constraint.
- [ ] Verify no trace file when diagnostic mode is off, no extra metric family, no change to deadline/heap/audit/batch/default jobs, redaction, event/profile schemas, output caps and no tracked change outside the approved candidate list.
- [ ] Obtain independent review of cumulative changes before any host-gated runtime diagnostic. This R5 plan does not itself authorize implementation or worker execution.

## Dependency DAG

```text
T1 schemas/recorder ─┬─> T2 bounded writer/redaction ─┬─> T4 worker S00-S02 ─┐
                     │                                ├─> T5 runtime S03-S05 ├─> T8 diagnostic runner/no-op gate
                     └─> T3 clock/profile contract ───┤                     ├─> T9 verification/review
                                                      ├─> T6 pipeline S06-S09┤
                                                      └─> T7 audit/resources ┘
```

T4 can proceed after T1/T2; T5 requires the internal sink contract; T6 requires T5 sink wiring; T7 requires the trace contract and worker sampler; T8 joins T4-T7. The current Task8 implementation stops at offline request preparation; the worker launch/supervisor join and T9 remain pending. No implementation task is started by R5.

## Evidence and checks not run

- Commands listed above are future TDD steps, not executed in R5.
- No source/test edits, benchmark worker, CPU profiler, or baseline command was run to create this plan.
- Runtime hotspots, observed per-stage progress, SQLite statement count, and exact native CPU attribution remain `NOT_VERIFIED`.
