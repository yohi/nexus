# R5-05 — Diagnostic Safety and Execution Gate

**R5 authority:** `READ_ONLY_SOURCE_ANALYSIS / OFFLINE_DIAGNOSTIC_DESIGN / NO_RUNTIME_EXECUTION / NO_GATE_AUTHORITY`.

This is a proposed future gate. It does not authorize a benchmark or diagnostic worker. A new explicit user authorization and fresh host/source review are required after design review and any approved implementation.

## Current status

**HISTORICAL OBSERVATION:** An earlier source check recorded branch `feature/retrieval-performance-execution`, HEAD `bf4feec5ad3e7903250a5f2134ec3155a0960a76`, fingerprint `8324d4dbac08acc06bc68e88fb8366ad419c3e5b6d8e6556c63d8f9fb4164f06`. The R4 host assessment found `llama-server` near800% CPU plus multiple OpenCode sessions and stopped before worker creation. Those are historical observations, not a statement about current host suitability.

**LATEST READ-ONLY SOURCE OBSERVATION (2026-10-29):** Same branch and HEAD; worktree is dirty; current source fingerprint `3f92e79cafcda021d0813f8c48641e8d41cd579d81519e171e144690bb7a8353`; Node `v26.10.0`, npm `11.19.1`, Linux x64, `NODE_OPTIONS` unset. Baseline JSON paths, `package.json`, and the standard `scripts/run-performance.mjs` have no changes. This is not a source-gate pass: the worktree is dirty and the fingerprint must be reviewed and pinned for the diagnostic revision. No current host snapshots were collected.

**OBSERVED:** Existing v3 preflight pins the old source fingerprint exactly. Any future stage instrumentation changes that fingerprint. Do not bypass the check or reuse the old fingerprint: version the diagnostic kit with a new pinned instrumented-source fingerprint and preserve historical report fingerprints/run IDs.

**Current outcome:** R5 performs no runtime execution. Existing formal reports and v1/v2/v3 diagnostic evidence remain unchanged; medium/large baseline acceptance remains blocked.

## Proposed Host Gate

Take at least three read-only snapshots spanning at least60 seconds, 30 seconds apart. Capture process CPU deltas per interval, not only instantaneous `ps %CPU`. Capture:

- timestamp for chronology and monotonic timestamp/clock domain for joins;
- CPU model/count/affinity, `cpuset.cpus.effective`, load average, effective cgroup CPU quota/stat and throttling deltas;
- top unrelated CPU processes by PID/start tick/owner/cgroup and bounded executable name; identify system services from cgroup/parent without exposing full command-line arguments;
- `MemAvailable`, swap used/delta, cgroup memory current/max/high, memory PSI and OOM/high/max event deltas;
- host/cgroup CPU, I/O and memory PSI; cgroup `io.stat` deltas;
- free bytes on the diagnostic scratch filesystem.

**DESIGN_PROPOSAL conservative busy thresholds** (independent review must accept/revise before implementation; these are not measured host facts):

**FAIL-CLOSED RULE (user-selected design):** If any required PSI, cgroup, affinity, swap, or scratch-capacity input cannot be collected or validated, record `HOST_GATE_INDETERMINATE` with the missing input identifiers and stop. Missing telemetry is not a pass and does not authorize a worker.

**USER REVIEW (2026-10-29):** Retain the proposed CPU thresholds below and 256 MiB swap-growth ceiling; require host and finite-cgroup 4 GiB headroom independently; stop on any non-zero host/cgroup memory PSI `some avg60` or `full avg60`; record CPU PSI trends without a separate “rising materially” stop condition. These are design decisions, not measured host facts, and do not authorize host-gate implementation or worker execution.

**USER-APPROVED APPROACH (2026-10-30):** Use a Node-only diagnostic supervisor/bootstrap isolated from the standard performance runner. Keep the current launcher preparation-only. The supervisor defaults to preflight-only, and actual worker execution requires a later fresh explicit authorization after implementation review and passing host/source gates.

1. `HOST_BUSY_STOP` if any unrelated process consumes >50% of one logical CPU in at least two consecutive intervals, or identified unrelated processes together consume >1 logical CPU on average across the observation window. Rationale: prior medium workers consumed roughly1.17–1.20 CPU-equivalents, so either sustained competing threshold is large enough to perturb a single worker. Record owner/purpose as `user session`, `service`, or `unknown`; unknown ownership is not permission to stop it.
2. `HOST_BUSY_STOP` if CPU PSI `some avg60` exceeds1.0% or `full avg60` exceeds0.1%. These are conservative proposed ceilings on scheduling stalls, not project-derived guarantees. Record PSI trend across snapshots for review, but do not use the undefined phrase “rising materially” as a separate stop criterion. Load average is context, never the sole decision.
3. `HOST_BUSY_STOP` if effective CPU capacity is fewer than4 CPUs, any `nr_throttled` increment occurs, host or cgroup memory PSI `some avg60` or `full avg60` is non-zero at any snapshot, or cgroup memory `high`, `max`, `oom`, or `oom_kill` counters increase. Define effective CPU capacity as the minimum of the process affinity CPU count, `cpuset.cpus.effective` CPU count, and finite `cpu.max` quota/period; omit the quota term when unlimited. Missing required inputs produce `HOST_GATE_INDETERMINATE`. Four CPUs preserves headroom for the single worker and host services; reviewer must assess whether this is too conservative for a diagnostic.
4. Require host `MemAvailable` of at least4GiB and, when `memory.max` is finite, cgroup headroom (`memory.max - memory.current`) of at least4GiB for the unchanged 2GiB old-space diagnostic (2x heap ceiling reserved for native/storage/runtime headroom; heap is not an RSS cap). If cgroup memory is unbounded, record that fact and apply the 4GiB check to host `MemAvailable`. Require swap usage not to grow by >256MiB over the observation window as a guard against active paging. A finite memory cap is recorded separately from Node heap.
5. Estimate scratch needs from canonical medium fixture bytes and the prior valid small cold-run `artifactBytes.totalBytes`. Proposed derived multiplier: the maximum of the medium-to-small ratios for fixture UTF-8 bytes, files, declarations, imports, legacy rows, and structured rows. Estimate `mediumFixtureBytes + ceil(smallArtifactBytes * multiplier)`, then require free space >=2x that estimate plus1GiB. The host gate must obtain fixture bytes from the canonical deterministic recipe without writing fixture files. If the prior small artifact is not valid/compatible, the recipe dimensions are unavailable, or the estimate is ambiguous, record `HOST_GATE_INDETERMINATE`; do not guess or silently default a multiplier.

These thresholds are operational guardrails for a single diagnostic, not performance guarantees. The user-reviewed values remain proposals until their implementation is checked; the scratch estimate must use an independently reviewed derivation. No implementation or execution authority is implied.

## Proposed Source and Dependency Gate

- Confirm exact repository root, branch, HEAD, tracked/untracked status and base ancestry. Preserve user-supplied diagnostic kits as user files.
- Record `node --version`, npm, locked Vitest version, `vitest.performance.config.ts`, OS and source fingerprint. Require Node>=24, preinstalled dependencies, Linux fork process-group support, fingerprint equality to the reviewed diagnostic source revision, and no inherited `NODE_OPTIONS` collision with heap/profiling.
- For future stage-instrumented source, compute a separate diagnostic fingerprint covering production/test instrumentation, diagnostic scripts/bootstrap, Vitest configuration and locked dependencies, and the v4 CJS/Python kit. Pin it after independent review; do not modify historical reports or claim comparability with their prior fingerprint. The normal baseline fingerprint remains distinct and unchanged.
- Verify no unreviewed source edits, output run directory is new, and no competing Nexus performance worker owns the same scratch/store root.
- Review source/tests and the external diagnostic-kit version before any worker. R5 design readiness alone does not satisfy this gate.

## Proposed Node Diagnostic Supervisor Architecture

This section is a design proposal only. It does not enable or authorize runtime execution.

### Entry point and request flow

- Keep `scripts/run-performance.mjs`, its defaults, formal baseline aggregation, and baseline report schemas unchanged. The diagnostic supervisor is a separate entry point and consumes the private requests prepared by `scripts/run-performance-diagnostic.mjs`.
- Add a separate `scripts/execute-performance-diagnostic.mjs` supervisor; keep `scripts/run-performance-diagnostic.mjs` preparation-only. The supervisor defaults to preflight-only. Its execution mode is a distinct explicit command option, and conversational execution authorization remains required; the option itself is not authorization.
- After source and host gates pass, the supervisor revalidates the fresh run-owned directory created during preparation (canonical path, owner/mode, and absence of runtime result/profile artifacts) and spawns one detached Node bootstrap child. The child validates the prepared scenario and diagnostic requests, writes the profiler control request with its own PID as `parentPid`, loads `worker_profile_preload.cjs`, sets the preload for inherited Vitest fork workers, and invokes the installed Vitest `startVitest()` API with only a new `runtime.diagnostic.perf.ts` entry.
- The diagnostic test entry calls `executeDiagnosticPerformanceWorker` with the private scenario and worker-diagnostic request paths. The child writes only private status/phase/result evidence. It does not invoke the standard aggregator or write `docs/observability/benchmarks/*.json`.
- Use one `medium / cold_initial_index` request with the existing 600,000 ms deadline and 2,048 MiB heap. Do not retry, start another profile, or run a formal baseline profile from this entry point.

### Process identity and cleanup

- The supervisor records `(pid, start_ticks, ppid, pgid, sid)` for the bootstrap and each observed descendant in its isolated session. It does not use a numeric process-group signal as proof of ownership.
- Before every signal, re-read `/proc/<pid>/stat` and verify the recorded start ticks, dedicated PGID/SID, and descendant lineage. If a parent exited and the process was reparented, accept it only when its identity was previously observed and its PGID/SID still match this run. Signal individual verified PIDs only; revalidate again before escalation.
- On timeout or interruption, request `SIGTERM`, wait the reviewed grace interval, then request `SIGKILL` only for identities that still match. If identity cannot be verified, or an owned process remains afterward, record `CLEANUP_UNVERIFIED`, stop, and preserve the run directory and evidence. Never signal an unrelated or replacement PID.
- Remove only run-owned fixture/storage paths after confirming canonical containment, no symlink escape, worker exit, and verified ownership. Any incomplete ownership/cleanup check blocks diagnostic admissibility.

### Profiling, source identity, and admission

- The worker's trace terminal event remains provisional and `diagnosticAdmissible=false`. Only the supervisor may finalize admissibility after validating process identity and CPU-active fork evidence, trace/event/profile caps and schemas, clock alignment, audit and storage-state integrity, and cleanup.
- Keep the normal performance source fingerprint unchanged. Add a separate reviewed diagnostic fingerprint that covers all instrumented source, the diagnostic bootstrap/supervisor, request contracts, Vitest configuration/lock data, and the v4 CJS/Python kit. Require exact equality to the pinned diagnostic source revision before execution.
- A missing/invalid worker result, unknown storage integrity, trace loss, profile write/identity failure, source mismatch, failed gate, or unverified cleanup yields a non-admissible diagnostic. Do not retry or repair automatically.
- Diagnostic artifacts remain under the ignored `reports/performance-execution/diagnostics/<run-id>/` tree. Raw CPU profiles remain confidential local artifacts; summaries are path-redacted and never become formal baseline samples.

### Verification design

- Unit tests cover request schemas, source/host gate predicates, `/proc` parsing/identity comparison, PSI/cgroup counter deltas, output ownership, and final admissibility.
- Supervisor integration tests use a harmless synthetic child-process fixture to exercise normal exit, forced termination, parent crash, stale/reused identity, and `CLEANUP_UNVERIFIED`. These tests do not execute a Nexus performance scenario.
- Compatibility tests prove that ordinary performance requests do not load the diagnostic preload or create trace/profile artifacts, and that the standard runner/report path remains unchanged.
- The real single-worker diagnostic is a later gated operation, after implementation review, exact source pin, passing host/source gates, and a new explicit user authorization.

## Proposed Safety and Execution Steps

Only if every host/source gate passes and the user explicitly authorizes later execution:

1. Run the exact reviewed kit's preflight without the execution flag; retain its result.
2. Use one `medium / cold_initial_index` worker only, observation window120s, worker default600s deadline and2,048MiB heap unchanged. Use a new diagnostic-only run ID/output directory under the ignored diagnostics area. Do not invoke the formal serial small/medium/large command.
3. Record `(pid,start_ticks,ppid,pgid,sid)` and verify the Vitest fork separately from the supervisor. Never signal a numeric process group alone; revalidate PID/start tick/session before each signal.
4. On timeout/user interruption, request SIGTERM only for verified owned processes, wait the reviewed grace, and escalate only to still-verified identities. If ownership cannot be proven or an owned process remains, report `CLEANUP_UNVERIFIED`, stop, and do not signal a substitute PID.
5. Confirm no owned process/descendant remains. Remove only run-owned `scratch/fixture-*` and storage paths after verifying canonical diagnostic root, no symlink/escape, and worker exit. Retain request/phase/resource/profile/termination/trace evidence and summary.
6. Independently validate storage-state integrity. Any swallowed backup finalizer, rollback/abort/clear-pending failure or `stateIntegrity: unknown` makes the diagnostic `diagnosticAdmissible=false`, even if `runFullRebuild()` resolves or a later query reports `rebuildState=idle`. Do not rerun or repair automatically.
7. Validate diagnostic JSON schema/redaction. Treat raw CPU profiles as confidential local artifacts; share only reviewed path-redacted summaries.
8. Stop after the single worker and assess H1-H4. Do not launch large or repeat medium blindly. A profile without CPU-active fork PID/start-tick evidence is `PROFILE_NOT_PROVEN`.

## Baseline and Git Isolation

- Diagnostic output belongs in a new `reports/performance-execution/diagnostics/` directory, not `docs/observability/benchmarks/`, and is never a baseline record.
- Do not change defaults, deadlines, heap, pages/batches, fixture counts, audits, provider, watcher or cache behavior.
- Preserve `small.json`, `medium.json`, `large.json` and all earlier diagnostic IDs.
- Do not stop/restart Ollama, OpenCode, systemd services or other users' processes.
- This gate does not itself authorize commit/amend/push/PR/merge; perform VCS actions only on a direct user request and the named feature branch. Do not change the master checkout or use CodeRabbitCLI.
- #299 stays BLOCKED until all scale reports meet the R4 Task12 validity/audit/L2/resource/review requirements. A localized hotspot or diagnostic-only run cannot admit baseline samples.
