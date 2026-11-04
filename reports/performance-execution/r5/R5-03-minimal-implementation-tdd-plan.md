# R5-03 — Minimal Diagnostic Instrumentation Implementation Plan

> **Implementation status.** Worker-free implementation for Tasks1-8 and 10-16 is present in the current uncommitted worktree. Task9 verification is partial because the standard smoke runner and `test:perf` remain unrun; Task17 review/source-pin requirements remain incomplete. Source-fingerprint and pidfd security subreviews, plus the worker-free goal/constraint review, passed. Full implementation/code-quality and documentation-context review is inconclusive because the retry sessions returned no verdict. There is no diagnostic source pin or current host snapshot. A real worker remains gated on complete review, passing host/source checks, and fresh explicit authorization. See `reports/performance-execution/progress.md` for the evidence and limitations.

**Goal:** Add an opt-in, source-free bounded stage trace that distinguishes progress and waits across the medium cold-start path and correlates it to the CPU-active Vitest fork profile.

**Architecture:** Keep the diagnostic channel separate from `OutcomeCollector` admission events and `PerformanceReport`. An internal optional sink is passed only by a separate diagnostic request; production/default calls without the sink preserve the current execution path. The Node diagnostic supervisor/bootstrap remains isolated from `scripts/run-performance.mjs`; it joins supervisor and v4 preload evidence only on process identity plus a verified monotonic clock domain.

**Tech Stack:** TypeScript and Node.js >=24, Vitest 3.2.7, Zod 4, SQLite/LanceDB production APIs, Linux `/proc`/cgroup/PSI, Node supervisor/bootstrap and `node:inspector` preload; Python stdlib remains limited to the versioned v4 clock/profile utility scripts.

**Spec:** [R5-01 execution map](R5-01-runtime-stage-execution-map.md), [R5-02 instrumentation contract](R5-02-stage-instrumentation-contract.md), [R5-05 diagnostic gate](R5-05-diagnostic-safety-execution-gate.md), [R4 plan Task12](../../../docs/superpowers/plans/2026-10-24-retrieval-performance.md), and [R3 design](../../../docs/superpowers/specs/2026-10-24-retrieval-performance-design.md).

## Global constraints

- Keep medium deadline600,000ms, old-space2048MiB, audit page<=512, and L2 batch<=512 unchanged.
- No retry, audit reduction, new benchmark identity, baseline report mutation, public export, production CLI option, Prometheus metric, or enabled-by-default timer.
- Diagnostic runs use a new run ID/output directory, are marked `diagnosticOnly`, and cannot enter standard summaries.
- All spans/counters are source-free and bounded; raw profiles are confidential. Observer/trace failure never alters production return values, errors, order, cleanup, or baseline admission.
- No process or service outside the positively identified diagnostic run is stopped. VCS operations require a direct user request. CodeRabbitCLI remains prohibited.
- New diagnostic modules stay below the 250 nonblank/noncomment LOC ceiling. Existing larger production files receive only minimal, focused stage hooks; do not refactor unrelated behavior solely to satisfy the helper-size rule.

## Review focus

1. **Synchronous CPU can prevent worker timers/profile checkpoints from firing.** Preserve an external `/proc` CPU/RSS/IO sampler and leave spans open when no terminal event arrives; never infer zero work from a missing heartbeat. Test a fork child in a synchronous loop.
2. **Concurrent read/chunk files overlap.** Progress counts are cumulative by `operationId + attemptId`; process CPU deltas over an interval are inclusive, not exclusive per overlapping child span. Test two concurrent children and prohibit sums that double-count.
3. **Startup reindex is fire-and-forget from `initialize()`.** The child reindex may outlive the initialization span; preserve causal parent IDs without requiring child end before parent end. Test detached-but-owned work and cancellation.
4. **The observer/admission collector already retains events.** Do not append diagnostic events to its per-request array. Test that trace caps and writes are isolated from normal validity evidence.
5. **CPU profile and stage timestamps may have different clock origins/units.** Require PID+start-tick and explicit Linux monotonic calibration; if profile offsets cannot be anchored, degrade to segment overlap or `PROFILE_NOT_PROVEN`.

---

## Candidate file/interface map

This map records file ownership for completed instrumentation and the approved remaining implementation.

| File | Responsibility |
|---|---|
| Create `src/observability/diagnostic-stage-trace.ts` | Internal `AsyncLocalStorage` context, typed sink and safe no-op span/progress helpers; no root/package export. |
| Create `tests/benchmarks/performance/diagnostics/contracts.ts` | Strict diagnostic JSON event/status schemas, separate from baseline report contracts. |
| Create `tests/benchmarks/performance/diagnostics/trace-recorder.ts` | Per-process span identity/parenting, bounded counters, rate limit, caps and explicit loss status. |
| Create `tests/benchmarks/performance/diagnostics/clock-domain.ts` | Monotonic-domain metadata and parent/fork calibration result. |
| Create `tests/benchmarks/performance/diagnostics/resource-sampler.ts` | Worker CPU/heap/event-loop samples; host/cgroup sampling stays in supervisor. |
| Create `tests/benchmarks/performance/diagnostics/profile-correlation.ts` | PID/start-tick/profile-segment matching and fail-closed time mapping. |
| Create `tests/benchmarks/performance/diagnostics/profile-summary.ts` | Redacted categories, segments, stage overlap and evidence completeness. |
| `scripts/run-performance-diagnostic.mjs` | Preparation-only request creation; never launches a process. |
| Create `scripts/execute-performance-diagnostic.mjs` | Separate Node supervisor; preflight-only by default and gated execution mode. |
| Create `scripts/performance-diagnostics/{fixture-recipe,fixture-size,source-fingerprint,host-snapshot-parsers,host-snapshot,host-gate-inputs,host-gate-process-cpu,host-gate,process-identity,process-supervisor-process,diagnostic-vitest-bootstrap,diagnostic-vitest-bootstrap-control,diagnostic-admission,diagnostic-admission-artifacts,diagnostic-admission-collector}.mjs` and `scripts/performance-diagnostics/diagnostic-source-pin.json` | Offline canonical fixture sizing, diagnostic source/host gates, Linux process identity parsing/signaling, Vitest bootstrap, final admission, and reviewed source pin. |
| Create `scripts/execute-performance-diagnostic.mjs` | Explicit preflight, read-only host snapshot capture, source/host-gated supervisor entry; default mode does not spawn. |
| Create `tests/benchmarks/performance/{runtime.diagnostic.perf.ts,diagnostic-worker-entry.ts}` | Single diagnostic worker entry calling `executeDiagnosticPerformanceWorker` and writing only private worker evidence. |
| `vitest.performance.config.ts` and create `vitest.diagnostic-performance.config.ts` | Keep the standard performance discovery set restricted to `runtime.perf.ts`; diagnostic bootstrap selects only `runtime.diagnostic.perf.ts` through a separate config. |
| Modify `tests/benchmarks/performance/{worker,worker-scenario,runtime,fixtures,worker-preflight,readiness,lifecycle,audit}.ts` | Worker request mode and S00-S03/S09-S12 spans/counters; diagnostic-only outputs. |
| Modify only if needed: `src/observability/runtime-work.ts` | Reuse causal operation identity where useful; stage events remain in the separate diagnostic context, not `RuntimeEvent`/`OutcomeCollector`. |
| Modify `src/server/runtime-assembly.ts`, `src/server/runtime/assembly-types.ts`, `src/server/runtime/directory-scan.ts` | Internal sink injection plus S03/S04/S05 boundaries; no public `NexusRuntimeOptions` or root export change. |
| Modify `src/indexer/pipeline.ts`, `src/indexer/chunker.ts`, `src/indexer/structured-index-coordinator.ts` | S06-S09 spans, window/batch progress, fallback-reason counters and full-rebuild retained counts. |
| Modify `src/storage/metadata-store.ts`, `src/storage/vector-store.ts` only if caller-level boundaries cannot distinguish completed SQLite/Lance logical writes | Count logical API/transaction calls and rows after awaited success; do not add SQL-statement instrumentation without separate evidence. |
| `scripts/performance-diagnostics/v4/*` | Versioned local profile/clock kit; preserve the user-supplied ZIP archives unchanged. |

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

### Task 3 — Clock calibration and v4 profile mapping

**Files:** Create `diagnostics/clock-domain.ts`, `diagnostics/profile-correlation.ts`, `tests/unit/benchmarks/performance/diagnostics/profile-correlation.test.ts`; add the versioned v4 preload/summarizer under `scripts/performance-diagnostics/v4/`.

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
- [x] Harmless-child tests cover forced termination, parent exit/failure, reparented and escaped descendants, and explicit `CLEANUP_UNVERIFIED`; supervisor status tests verify `running` is written before child startup and a final status follows verified cleanup/admission.
- [ ] Abrupt termination of the supervisor parent while a worker is active remains untested; do not claim this process-failure case is verified.
- [x] Add S10–S12 stage spans/cumulative row counters without altering `auditResultSchema`, page size, membership validation, probe handler, runtime close order or validity gate. Worker resource samples contain heap/RSS/CPU/event-loop delay at a five-second interval and rate-limited stage boundaries; supervisor `/proc`/cgroup/PSI/IO collection remains independent.
- [x] GREEN for in-process stages: failed/truncated audits remain invalid; diagnostics stay in the private trace sidecar, outside `PerformanceReport`; unavailable resource measurements carry explicit reason codes.

### Task 8 — Diagnostic-only run integration and no-op compatibility

**Files:** Create `scripts/run-performance-diagnostic.mjs` and its declaration; `tests/benchmarks/performance/worker-contracts.ts`; `tests/integration/performance/diagnostic-mode.test.ts`.

- [x] RED/GREEN tests ensure the preparation launcher creates a new private run directory and strict private scenario/diagnostic request files, rejects repeated run IDs and missing source identity, and keeps the standard worker request schema free of diagnostic fields. Tests do not start a worker.
- [x] Keep the diagnostic preparation CLI separate from the standard baseline parent. Pin the prepared request to `diagnosticOnly=true`, profile=medium, job=`cold_initial_index`, timeout=600000, heap=2048, and a new output path. The CLI reports `prepared_only`; it does not start a process, load a profiler, create profiles, aggregate a report, or retry.
- [x] Diagnostic worker entrypoint, process supervision, profiler preload handoff, and supervisor-owned status/admission code are implemented and exercised with synthetic artifacts and harmless children only. Cleanup signalling uses a bounded Python standard-library pidfd helper; Node remains the execution owner.
- [x] Complete no-op compatibility verification for the standard smoke path: standard runner integration passes 17 tests, including the normal smoke report and silent `test:perf` output path; worker-free tests also confirm isolated discovery, preparation-only behavior, and unchanged baseline report paths. Full `npm test` remains unrun. The separate R5 diagnostic worker still requires passing source/host gates and the planned fresh authorization.

### Task 9 — Diagnostic contract and integration verification

**Files:** Focused tests above plus `tests/integration/performance/diagnostic-mode.test.ts`.

- [x] Focused worker-free diagnostic/discovery/integration suite after finalization and host-gate hardening: 31 files / 236 tests passed; TypeScript, both linters, build and `git diff --check` passed. No diagnostic performance worker was launched.
- [x] Re-ran the affected diagnostic suite and sequential safe broad suite after the latest fixes. The broad safe run passed 204 files / 1,620 tests / 1 skipped; `npm test` itself remains unrun because it includes the separately gated smoke-runner integration.
- [x] Standard and diagnostic discovery remain isolated; diagnostic-mode tests cover preparation-only behavior and no baseline output path.
- [x] R5-05 no-op compatibility confirmation: standard runner/source/report files are unchanged; `tests/integration/performance/runner.test.ts` passes 17 tests, including the smoke report and silent `test:perf` output path; discovery is isolated and preparation creates no diagnostic profile/result artifacts. No baseline report was written.
- [x] Complete focused independent review of the worker-free gate implementation and documentation: source-fingerprint, pidfd security, strict host/source gate, rejected-summary behavior, worker-free goal/constraints, and current R5 status consistency all passed. Actual R5 diagnostic execution remains gated in Task18.

## Approved continuation tasks — worker-free implementation status

The following plan expands the Node-only design in R5-05. It keeps the standard performance runner and baseline schemas unchanged. Worker-free implementation steps use synthetic fixtures or harmless child processes, never a Nexus benchmark/diagnostic worker. The status below reflects the current worktree and is not an execution approval.

### Task 10 — Canonical offline fixture sizing

**Files:** Create `scripts/performance-diagnostics/fixture-recipe.mjs` and declaration; create `scripts/performance-diagnostics/fixture-size.mjs`; modify `tests/benchmarks/performance/fixture-recipe.ts`; add `fixture-size.test.ts`.

**Interface:** `FixtureSizeSummary` is `{ files:number; utf8Bytes:number; declarations:number; imports:number; legacyRows:number; structuredRows:number }`. `measureFixtureSize(profile:'small'|'medium')` returns that exact recipe summary without filesystem writes.

- [x] RED/GREEN: `fixture-size.test.ts` compares the shared MJS recipe bytes/digest with the existing fixture generator for small and medium profiles and asserts no fixture files are written.
- [x] Focused fixture-size tests passed; the canonical recipe is shared and invalid/missing small-report dimensions fail closed.

### Task 11 — Profile budget cleanup and CommonJS lint boundary

**Files:** Create `tests/unit/benchmarks/performance/diagnostics/profile-budget.test.ts`; modify `scripts/performance-diagnostics/v4/profile-run-budget.cjs`, `profile-event-sink.cjs`, `eslint.config.mjs`, and `package.json`.

**Interface:** `withProfileRunBudget()` preserves the write error and any lock cleanup/identity error; a cleanup failure combined with an operation failure returns an `AggregateError` with code `profile_budget_lock_cleanup_failed`. A denied budget always releases an owned lock and never calls the write callback.

- [x] RED/GREEN: profile-budget tests cover lock replacement during write failure, denied over-limit writes, cleanup, and preserved operation/cleanup errors.
- [x] CJS lint boundary and nested diagnostic lint coverage are configured; focused tests and `npm run lint:perf` passed.

### Task 12 — Diagnostic-specific source fingerprint

**Files:** Create `scripts/performance-diagnostics/source-fingerprint.mjs` and `tests/unit/benchmarks/performance/diagnostics/source-fingerprint.test.ts`.

**Interface:** `diagnosticSourceFingerprint(repository)` returns `{ commit:string|null; dirtySourcePaths: readonly string[]; digest:string }` over production/test instrumentation, diagnostic entrypoints, Vitest configuration/lockfile and v4 CJS/Python kit. Determine dirtiness only from included source paths: preserve/report user ZIP assets and ignored reports without treating them as diagnostic source changes; an untracked source file remains dirty. Keep `performanceSourceMetadata()` and the normal baseline field unchanged; exclude the pin itself.

- [x] RED/GREEN: source-fingerprint tests cover included source/config/test/v4 changes, untracked source dirtiness, unchanged standard fingerprint behavior, and excluded ZIP/report/pin paths.
- [x] Deterministic diagnostic fingerprint is implemented; pin generation remains deferred until a complete independent review passes.

### Task 13 — Read-only host gate

**Files:** Create `scripts/performance-diagnostics/host-snapshot-parsers.mjs`, `host-snapshot.mjs`, `host-gate-inputs.mjs`, `host-gate-process-cpu.mjs`, and `host-gate.mjs`; add `host-snapshot.test.ts`, split gate tests by thresholds/scratch, and shared synthetic fixtures.

**Interfaces:** `collectHostSnapshot({procRoot, sysRoot, now})` returns a path-free `HostSnapshot` containing UTC/monotonic time, logical/affinity/cpuset/quota CPU capacity, process `(pid,startTicks,utime+stime)` samples and aggregate `/proc/stat` ticks, PSI, cgroup memory/swap/IO deltas, `MemAvailable`, swap delta and scratch free bytes. `evaluateHostGate(snapshots, smallReport, mediumFixtureSize)` returns `PASS`, `HOST_BUSY_STOP`, or `HOST_GATE_INDETERMINATE` with fixed reason codes. Derive CPU-equivalent usage by comparing process and aggregate tick deltas; do not assume `CLK_TCK` or spawn `getconf`. Accept injected readers/clocks for deterministic tests; never spawn or signal processes.

- [x] RED/GREEN: synthetic host-gate tests cover sample spacing, missing telemetry, CPU/PSI/memory/swap thresholds, effective capacity, scratch estimates, and fail-closed statuses.
- [x] Host snapshot/gate implementation reads bounded `/proc`, PSI and cgroup data; synthetic fixtures exercise terminal statuses without reading the real host.
- [ ] Real host snapshots are intentionally deferred to Task18; none have been collected.

### Task 14 — Diagnostic Vitest bootstrap and private worker entry

**Files:** Create `scripts/performance-diagnostics/diagnostic-vitest-bootstrap.mjs` and `diagnostic-vitest-bootstrap-control.mjs`; create `tests/benchmarks/performance/{diagnostic-worker-entry.ts,runtime.diagnostic.perf.ts}`; extend diagnostic request contracts/tests as required.

**Interfaces:** Bootstrap consumes `NEXUS_PERF_REQUEST_FILE` and `NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE`, writes the mode-0600 v4 profile request named by `NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE` with its own PID as `parentPid`, loads v4 preload before starting Vitest, sets preload inheritance for Vitest fork workers, then runs only the diagnostic test entry through `startVitest()`. The test entry calls `executeDiagnosticPerformanceWorker` and writes a private result/status file; it never calls the normal aggregator.

- [x] RED/GREEN: bootstrap tests mock the Vitest adapter and validate request identity, parent PID, preload order, private paths, and diagnostic-only entry selection.
- [x] Standard and diagnostic discovery are separate; ordinary request/report schemas remain unchanged. Focused bootstrap/integration tests passed without starting a performance worker.

### Task 15 — PID-verified Node supervisor and termination handling

**Files:** Create `scripts/performance-diagnostics/{process-identity,process-supervisor,process-supervisor-process}.mjs`, `scripts/execute-performance-diagnostic.mjs`, and `tests/fixtures/performance/supervisor-child.mjs`; add identity/supervisor tests.

**Interfaces:** `ProcessIdentity` is `{ pid: number; startTicks: string; ppid: number; pgid: number; sid: number; cpuTicks: number }`. `readProcessIdentity(pid, procRoot)` returns `{status:'observed', identity: ProcessIdentity}` or `{status:'not_collected', reasonCode:'not_found'|'permission_denied'|'malformed'}`. The shared `passedHostGateResultSchema` requires a complete three-snapshot PASS summary with valid scratch and CPU capacity evidence. Cleanup opens a Linux pidfd, revalidates start ticks/PGID/SID, then calls `pidfd_send_signal` to bind delivery to the verified process; unsupported pidfd capability blocks startup before spawn. `executeDiagnosticRun(preparedRun, dependencies)` returns a discriminated status (`preflight_only|gate_blocked|completed|cleanup_unverified`), defaults to preflight-only, rechecks source identity before spawn, after worker exit, and immediately before admission, and is the only code allowed to spawn the bootstrap. The supervisor reports per-owned-PID CPU tick deltas and gates Vitest start on an IPC identity handshake.

- [x] RED/GREEN: identity and harmless-child tests cover `/proc` parsing, PID reuse, normal exit, timeout/escalation, parent exit/failure, reparented descendants, unobserved members, escaped sessions, and cleanup uncertainty.
- [x] Supervisor defaults to preflight-only, validates complete host-gate PASS evidence and source fingerprint equality before startup, rechecks the fingerprint immediately before supervisor invocation, after the run, and after evidence collection before admission, and uses an IPC start gate so the bootstrap cannot start Vitest until its PID/start-tick/session identity is observed. Cleanup uses pidfd-bound signals after identity revalidation.
- [x] Focused identity/supervisor/process tests passed using harmless children only.

### Task 16 — Final diagnostic admission and no-op compatibility

**Files:** Create `scripts/performance-diagnostics/{diagnostic-admission,diagnostic-admission-artifacts,diagnostic-admission-collector}.mjs`; extend `tests/integration/performance/diagnostic-mode.test.ts` and diagnostic unit tests.

**Interface:** `finalizeDiagnosticRun(evidence: DiagnosticRunEvidence, supervisorFinalization: SupervisorFinalization): Promise<DiagnosticSummary>` returns `admissible: true` only if every required source, host, process, trace/profile, storage-integrity and cleanup check passes, and the private run directory has a supervisor-owned `running` status. Worker `trace_status` remains provisional; only the process supervisor's verified worker-exit/cleanup/finalization evidence may accept the reserved `finalization_unverified` marker. All other inputs return an explicit non-admissible reason set.

- [x] RED/GREEN: admission tests cover trace/profile schema, CPU-active worker identity, clock alignment, storage integrity, cleanup, ownership, missing/corrupt evidence, source mismatch, and fail-closed status.
- [x] Supervisor finalization writes only private diagnostic status/summary records; standard aggregation and baseline report paths remain unchanged, and preparation remains non-spawning. The worker-free no-op subset was rechecked in Task9; the standard runtime path itself remains unrun because its integration starts a worker.
- [x] Supervisor only writes `status: finalized` and returns `completed` when the admission summary is valid and `admissible: true`; a rejected summary is preserved with its reason codes in a failed final-status record and a failed run result.
- [x] Focused admission/collector/integration tests passed using synthetic evidence; no real worker output was produced.

### Task 17 — Safe verification, review and source pin

**Files:** Focused tests above, R5-03/R5-05 and create `scripts/performance-diagnostics/diagnostic-source-pin.json` after review.

- [x] Worker-free focused suite after finalization, host-gate, admission-fingerprint and fail-closed summary handling: 31 files / 236 passed; `npx tsc --noEmit -p tsconfig.json`, both linters and `git diff --check` passed; build passed after production-code changes.
- [x] Sequential broad safe suite with coverage disabled and performance-runner/dashboard-CLI exclusions: 204 files / 1,620 passed / 1 skipped. Dashboard CLI: 2 passed; setup/staging shell checks passed; safe E2E subset: 3 files / 7 passed at the earlier checkpoint. No performance/diagnostic worker was launched.
- [x] Complete independent worker-free implementation review. Focused reviews of source fingerprinting, pidfd security, strict host-gate evidence, rejected-summary handling, worker-free goal/constraints, and current R5 documentation consistency passed. Standard smoke no-op verification passed in Task9; real R5 diagnostic execution remains gated in Task18.
- [x] Pin the reviewed diagnostic source fingerprint: `c072c7f1724a7fdc9b4b8ebd24951e570f3fa4642b373bcba05f692f948dfc19`; rechecked against current source and matched. The pin file is excluded from its own diagnostic fingerprint.

### Task 18 — Host snapshots and final execution gate

- [x] Captured three read-only host snapshots spanning >60s and evaluated the host gate. Latest run `4d559415-af33-4eda-a27e-3db7497a7a9a`, after a 3-minute cooldown, returned `HOST_BUSY_STOP` (`aggregate_process_cpu_busy`, `process_cpu_busy`); the sampled service-class `opencode` processes exceeded the CPU limits, so execution remains blocked.
- [x] User explicitly instructed proceeding with R5. No diagnostic worker was launched because the host gate did not pass.
- [ ] Run at most one `medium / cold_initial_index` diagnostic only after a passing current host gate, with existing 600,000 ms deadline and 2,048 MiB heap; stop after that run and retain its private evidence.
- [ ] Full `npm test` remains a separate authorization if its runner integration starts a smoke worker. Do not use it to bypass the single diagnostic run limit.

## Dependency DAG

```text
T1-T6 ──> T7 in-process S10-S12 ─┐
T3/v4 kit ──> T10 fixture sizing ──> T11 profile budget/lint ─┐
T3 contract ──> T12 diagnostic fingerprint ──────────────────┼─> T13 host gate ───┐
T4 contract ──> T14 bootstrap ──> T15 supervisor ──> T16 admission/no-op       │
                                                                          └──> T17 safe verification/review/source pin
T17 PASS ──> T18 host snapshots ──> fresh user authorization ──> one diagnostic
```

Tasks10-16 implementation and synthetic tests may run without a Nexus benchmark worker; they do not establish real host suitability or runtime cleanup/admission behavior. Task17 review and source pin remain pending. Task18 requires passing host/source gates and fresh explicit authorization; no amount of plan approval or prior VCS permission substitutes for that authorization.

## Runtime evidence still not collected

- No real diagnostic/performance worker, CPU profiler session, or current host snapshot was run for this implementation continuation.
- Runtime hotspots, observed per-stage progress, SQLite statement count, and exact native CPU attribution remain `NOT_VERIFIED`.
