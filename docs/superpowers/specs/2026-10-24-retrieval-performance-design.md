# Retrieval Performance Baselines

## Status and purpose

Proposed design for [issue #299](https://github.com/yohi/nexus/issues/299).
Revision R3 retains the R2 corrections for FND-299-001 through FND-299-007,
which the independent R2 review marked resolved in design, and addresses
R2-NEW-001 through R2-NEW-005. The revised document requires independent
review before implementation planning.

Static reference: `0407c2a688654857fac2d68af6369c3d52a5f399` on upstream
`master`. The local checkout inspected for this revision is
`4fd4872d4baa4394dd3828040f4d52ac9cc9e02d`; its relevant differences from the
reference include the #305 cache-identity module and its pipeline/factory wiring.
Those relevant differences were inspected explicitly. This revision does not claim
benchmark execution, CI success, or independent review approval.

Establish repeatable repository-scale performance and resource measurements
before considering indexed text search (#301), cross-worktree cache reuse
(#300), or LSP lifecycle tuning (#298). Performance results must remain separate
from retrieval correctness, relevance, and agent-loop quality (#320).

## Existing measurements

The inventory starts with `src/observability/types.ts` and the metric catalog
in `docs/observability/README.md`:

| Existing measurement | Reuse | Remaining gap |
| --- | --- | --- |
| Tool duration | Retrieval latency | Scale, cache state, raw samples |
| Result counts | Workload diagnostics | File and byte counts |
| Reindex duration/progress | Indexing | Repeatable lifecycle scenarios |
| Embedding duration/batches | Provider work | L1/L2 hits and misses |
| Structured outcomes/catalog | Diagnostics | Scale and resources |

`tests/benchmarks/sqlite-batched.bench.ts` measures storage lifecycle work.
`tests/benchmarks/structured-retrieval.bench.ts` measures structured retrieval
with 10, 50, and 100 declarations using a test catalog fixture. Retain these
microbenchmarks; neither is the repository-scale baseline.

Do not duplicate existing metric families. Report repository size, process
resources, and lifecycle timings in benchmark output rather than introducing
workspace- or file-labeled Prometheus metrics.

## Approach and boundaries

Add an explicit benchmark runner under `tests/benchmarks/performance/`, with
small modules for fixtures, scenarios, measurement, and reporting. Expose it
through a new `test:perf` npm script using `vitest.performance.config.ts`,
coverage disabled, and the single entry point
`tests/benchmarks/performance/runtime.perf.ts`. Its include pattern is
`tests/benchmarks/performance/**/*.perf.ts`, with file parallelism disabled.
Vitest resolves TypeScript sources and `.js` import conventions without
changing production imports.
Keep the existing `test:bench` command intact.

Use real ripgrep, SQLite, LanceDB, TypeScript parsing, indexing, and retrieval
components. Reuse the production factory composition through the internal
construction seam defined below. Inject only the deterministic in-process
embedding implementation; retain production search, stores, indexing, watcher,
and handlers. Record that provider identity and dimensions.
Do not contact an external embedding service or infer model-service latency
from the deterministic provider's timings.

All primary retrieval samples use boundary ID `handler-internal` and invoke
the real `buildToolHandlers()` handlers, including `withToolMetrics`, internal
argument/path handling, error handling, and `toolResult()` result formatting.
MCP registration-time Zod schema validation is not invoked by a direct handler
call and is excluded. During untimed setup, validate fixed fixture arguments
using `z.object(toZodV3Shape(definition.input))` from the registered tool
definitions and v1 adapter; pass validated/defaulted arguments to the handler
and record them as
workload options. Invalid arguments fail preflight. No schema-validation cost
is attributed to the handler series. A future schema-inclusive series must
use a different boundary ID.

`toolResult()` performs JSON normalization inside the handler: that cost is
included. Exclude MCP client startup, wire serialization, and Transport I/O.
Do not advertise these as serialization-free or MCP round-trip measurements.
Service-only measurements are not part of this baseline; any future addition
must use a separate boundary identifier and series.

The suite does not implement indexed text search, shared caches, parse caches,
LSP tools, quality corpora, or production optimization algorithms.

### Internal construction and observation seam

Extract the component assembly currently inside
`NexusServerFactory.createRuntime()` into one shared internal builder. The
production factory delegates to it with production defaults and continues to
return the existing `NexusRuntime`. Do not reconstruct the graph in test code
or add handlers/stores to the public runtime API or package exports.

The internal builder returns the runtime and its exact `NexusRuntimeOptions`
component bundle to an internal benchmark adapter. The adapter builds handlers
with `buildToolHandlers(bundle, runtime.initialize)`, using the same objects,
initialization barrier, locks, cleanup, and storage configuration as production.
Read-only diagnostic access covers queue state, pipeline, metadata, vector
statistics, and catalog; mutations use production indexing entry points.
It must not replace stores, parsers, the grep spawn implementation, or handlers.

An optional internal provider-creation dependency supplies the synthetic
provider before registry registration and instrumentation. Normal production
construction retains its provider selection and rejection of `provider: test`.
Only the explicit benchmark adapter accepts the reserved test configuration:
`provider: test`, `model: nexus-synthetic-sha256-v1`, dimensions 128, no
credentials/headers or external endpoint, and `packageMode: false`. No new CLI
or environment switch enables this dependency in normal operation.

Pass this same effective embedding configuration to the registry, provider,
vector store dimensions, and `IndexPipeline.embeddingConfig`. Use #305's
`createEmbeddingCacheIdentity()` unchanged. Never fingerprint a synthetic
vector as an Ollama/Bedrock/hosted-model vector. Assert provider dimensions and
identity against the effective config before initialization. Normal benchmark
runs accept only the fixed synthetic model/version and verify unchanged
identity hits. Changed model/version misses are verified in separate contract
tests as specified under cache measurements, not through a configurable
benchmark model or production factory override.

Add optional internal, request-scoped observation callbacks at existing work
boundaries. They retain outcomes without changing return values or exceptions:

- Pipeline Reindex invocation, raw result/rejection, post-completion state,
  and post-reindex compaction failure before its non-fatal catch.
- Semantic branch entry and fulfillment/rejection before Hybrid's
  `Promise.allSettled()` can turn it into a partial response.
- Grep execution entry and completion, combined-signal abort/timeout, spawn
  failure, and child close/exit before either Abort-to-empty conversion.

The callbacks are optional, non-throwing, disabled by default, and not new
Prometheus families. The benchmark collector assigns invocation/parent IDs
and phase IDs so parallel Hybrid branches and startup work cannot be confused
with another sample. Late terminal events are drained before validity is
decided; an unknown outcome fails closed. Do not infer success from logs or
from an outer fulfilled promise. Instrumentation overhead is included and its
enabled state is recorded. Preserve production partial-success semantics.

## Deterministic repositories

Generate TypeScript package trees with fixed names, content, import chains,
and symbol counts. Avoid random input and wall-clock timestamps in content.

| Profile | Source files | Declarations per file | Intended use |
| --- | --- | --- | --- |
| Smoke | 20 | 5 | CI execution and report validation |
| Small | 100 | 10 | Local short baseline |
| Medium | 1,000 | 10 | Scale comparison |
| Large | 10,000 | 10 | Monorepo-like local baseline |

Distribute files across bounded package directories. Include unique declaration
content and intentionally repeated helper content to expose deduplication/cache
behavior. Report actual UTF-8 source bytes and actual generated file count,
excluding index artifacts. Record a fixture version and content digest so future
runs can detect workload changes. Generate a manifest directly from the source
recipe with every expected path, content hash, declaration identity/span, and
separate expected row sets for legacy chunks, structured vectors, declarations,
and imports as defined below. Keep declarations and the legacy aggregate
import block below the fixed chunk-size limit. One declaration per structured
chunk is a fixture constraint, not a claim that legacy chunk count equals
structured declaration count. Helper declarations count too. The manifest
defines expectations independently of observed index output. Persist updated
expected membership/hashes/counts for each incremental scenario.

Use temporary directories and isolated storage. Clean up in `finally`, including
on errors, after closing runtime resources. Never delete user worktrees or reuse
the developer's Nexus index.

Use fixed retrieval queries covering selective matches, broad matches, and
no matches. Report each query case separately: a fast empty result must not
mask a slow broad-match case. Requested limits, effective limit behavior at
each processing stage, and structured token budgets are workload identity.

Record pattern/flags, expected matching files and lines, uncapped matching-line
and submatch counts, and deterministic locations (path and line/byte offset)
in the manifest. Report `requested_max_results` separately from
`effective_limit_behavior`, including the stage and implementation revision.
At the reference HEAD, the production grep factory neither passes a limit to
ripgrep nor truncates parsed matches: its effective behavior is `uncapped`,
even when `maxResults` is present. The grep engine's default parameter of 100
does not impose a returned-result cap.

Validate the entire returned grep match multiset against all manifest matching
lines/submatches, irrespective of the requested maximum; never trim results
inside the benchmark. A broad query exceeding the requested maximum is a
required contract case. A lower count cannot be assumed to mean successful
capping. Unexpected missing/extra results invalidate the run. Hybrid's grep
branch is also uncapped at this revision; final RRF `topK` truncation is a
separate effective stage, not a grep scan limit.

Include early-file and late-file matches in fixed source files. Ripgrep file
traversal order is not guaranteed: compare membership/multiplicity without
assuming lexical visitation or interpreting return order as scan order.
No-match validity requires successful grep completion. #301 signals measure
the production grep behavior at the measured revision, including all uncapped
result materialization costs. A future production limit fix is a separate
behavior change with its own revision and before/after baseline identity;
do not retrofit capped expectations or silently compare unlike behavior.

### Per-path storage and embedding audit

The manifest keeps distinct physical expectations; no single global chunk
count represents all retrieval paths:

- `legacy_chunk_rows` and `legacy_chunk_files`: rows in the live legacy
  `chunks` table, keyed by chunk ID and file path with content hash/span.
  For these fixed TypeScript files, expect declaration chunks plus one
  aggregate imports chunk where imports exist. Account for recipe-specific
  chunk splitting explicitly; never derive this count from catalog symbols.
- `structured_vector_rows` and `structured_vector_files`: active rows in the
  live structured vector table, keyed by file, active generation, and chunk
  ID, with symbol identity/hash/span. Audit active generations independently
  against the catalog; exclude staged, retired, backup, and shadow rows.
- `structured_declarations` and `structured_imports`: catalog records and
  per-file identities/spans/hashes for the expected active generation. Imports
  are catalog entries, not automatically structured vector chunks.

Use the read-only inspection adapter to enumerate each live table's effective
rows and per-file membership directly. `LanceVectorStore.getStats()` at the
reference HEAD counts the legacy table only; record it as `legacy_get_stats`
diagnostics, not as proof of complete structured coverage. Interpret persisted
index counters by their production meaning and compare against the matching
manifest view, never against an assumed combined vector total.

Within a table count each physical row once by its full key. Across tables a
shared source declaration remains two physical storage rows if stored twice;
do not present their sum as unique logical declarations. Logical declaration
counts use catalog identities; unique embedded texts use the union of
compatibility-scoped content keys, not the sum of per-path unique counts.

Retain the origin (`legacy` or `structured`) of every chunk lookup and provider
input occurrence. Report per-origin lookup outcomes and input item counts,
plus combined provider call count, total input occurrences, and unique input
keys. A batch may contain both origins: count that call once in the combined
total and report its composition, not one whole call per origin. Duplicate
input occurrences within a batch remain separate submitted items unless
production actually deduplicates them. Shared cache keys do not imply that
provider inputs were deduplicated. This diagnostic attribution does not add
new unbounded Prometheus labels or alter batching/cache behavior.

### Synthetic embedding contract

Label semantic/hybrid results `synthetic-vector retrieval performance`.
Use algorithm `nexus-synthetic-sha256-v1`, dimension 128. For each UTF-8 input,
hash the unambiguous concatenation of the algorithm tag, a zero byte, a
big-endian 32-bit block counter, and input bytes using SHA-256. Counters 0
through 15 produce 128 big-endian unsigned 32-bit components; map each to
`(u + 0.5) / 2^32 * 2 - 1`, then L2-normalize the vector. Reject zero norm,
non-finite values, incorrect dimensions, and aborted calls.

Query and indexing use this exact implementation and configuration. Include
algorithm version/dimensions in fixture/workload identity and the model name
used by the existing cache fingerprint. Fix reference input/vector digests
and validate finite unit norms within `1e-6`. Identical text must produce
identical vectors across batches and restarts. A fixed preflight corpus of
128 distinct input strings must yield 128 distinct vectors and positive
component variance in every dimension, including in smoke mode. Also require
no collisions among distinct generated source/query inputs. Identical helper
texts intentionally share vectors and are excluded from uniqueness checks.
Fail preflight if distribution checks fail.

This synthetic distribution exercises vector-search/storage costs, not actual
model semantics, real-model candidate distributions, relevance, or inference
speed. It cannot establish production embedding throughput or ANN behavior
for real model vectors.

## Scenarios and timing boundaries

Generate fixtures before starting timers. Run scenarios serially in isolated
child processes to avoid concurrent benchmark interference. End timers only
after the operation has completed, including required persistence work.

Use an outer monotonic `performance.now()` interval, named
`benchmark_completion_ms`, for each indexing operation. Start before its
production entry point; end after awaited indexing, post-reindex compaction,
completion recording, and relevant queue work settle. Retain the raw Reindex
result and existing histogram observations as a separately named diagnostic
interval. At the reference revision, `durationMs` is computed before
`compactAfterReindex()` and `recordCompletion()`; it is not interchangeable
with the outer interval. Do not change the existing metric's meaning.

Separate runtime completion from benchmark validation using monotonic endpoints:

- `t0`: immediately before production-equivalent runtime construction.
- `t_runtime`: after initialization, successful startup indexing (or recorded
  no-op), completion persistence, and queue/drain work settle. Capture this
  candidate endpoint through lifecycle observations before any full audit or
  retrieval probe. Lightweight idle/error state checks are included.
- `t_audit_start` / `t_audit_end`: immediately around the full manifest,
  catalog, vector, and DLQ audit after runtime completion.
- `t_probe_end`: after the subsequent known-fixture handler probe succeeds.

Report `runtime_ready_ms = t_runtime - t0`,
`audit_validation_ms = t_audit_end - t_audit_start`, and
`audited_ready_ms = t_probe_end - t0`. Report the probe interval separately as
`retrieval_probe_ms`. `audited_ready_ms` also includes any recorded observer
orchestration gaps; do not require it to equal the other durations' sum.
Do not use the former ambiguous `benchmark_ready_ms` field.

Formal runtime time-to-ready comparisons, including worktree and #300 signals,
use only `runtime_ready_ms`. Full audits remain outside both that interval
and indexing-operation timers, but are mandatory sample-admission conditions.
Retain the candidate endpoint privately until every audit/probe check passes.
If validation fails, preserve candidate timing only in an invalid diagnostic
record and exclude it from all successful readiness and indexing baselines.
Fail if state changes during an audit; overlapping background work must not
turn a partial earlier endpoint into a valid later state. Mark
`audited_ready_ms` as benchmark-validation latency, never runtime-only latency.

| Scenario | State and measured interval |
| --- | --- |
| Initial cold | Empty index/caches; index start to completion |
| Warm-cache rebuild | Compatible L2 retained; rebuild start to completion |
| Warm restart | Persisted index; runtime creation to reconciled readiness |
| Cold ready | Empty storage; runtime creation to ready after initial indexing |
| Incremental | Add/modify/delete submission to completed persistence |
| Retrieval cold | First call in a reopened indexed runtime, per path/case |
| Retrieval warm | Calls after unmeasured warmup in the indexed runtime |
| Sibling worktrees | Same revision, real Git worktrees, independent indexes |

Cold refers to application index/cache/process state, not flushed operating
system page caches. Record OS-cache state as uncontrolled. A warm-cache rebuild
must actually process chunks; an unchanged no-op reconciliation is not a cache
hit benchmark. Explicitly identify whether L1 or L2 is populated.

For incremental indexing, add one file, modify one file with new declaration
content, and delete one file. Record changed file/byte counts. Restore the same
starting state outside each timed sample. This measures pipeline latency,
excluding watcher debounce; identify that exclusion in output.

Cover `grep_search`, `semantic_search`, `hybrid_search`, `get_file_outline`,
`get_symbol_source`, and `get_symbol_context`. Select known fixture symbols
outside the timed interval. Consume results and fail on tool errors, pending
index state, or missing required fixture results. These are execution guards,
not relevance or correctness benchmark scores.

### Ready and completion validity gate

`initialize()` fulfillment and `waitForActiveReindex()` alone are insufficient:
the runtime starts auto Reindex asynchronously and may catch its rejection.
Capture raw pipeline results at invocation, before those catches, using the
internal observer installed before runtime initialization. After initialization,
await every startup Reindex attempt and all queue work it caused. An
`already_running` response is not success: resolve its owning invocation and
require that invocation's successful result. `incomplete`, rejection, missing
owner, missing terminal event, or deadline expiry fails the scenario. No-op
warm startup explicitly records `startup_reindex: not_required` and still
passes every persisted-state check below.

Require all conditions for fully indexed scenarios, before retrieval sampling
and after incremental work:

- Runtime initialization finished; observed startup/indexing operations settled
  successfully, with no failed auxiliary compaction or unresolved error.
- Pipeline idle, no in-flight event drain, empty ordinary/post-scan queues, no
  overflow/dropped fixture events, and no skipped fixture files.
- Non-null index completion timestamp and no persisted/pipeline error. A
  previous timestamp is never evidence of the current invocation's success.
- Legacy rows/files, active structured vector rows/generations, and catalog
  declarations/imports each match their separate manifest view exactly;
  compare per-file physical membership, not only global totals or legacy-only
  `getStats()` output. Apply the per-path counting rules above.
- Every manifest file has a complete active structured generation matching
  its current content hash and expected declarations. Check generation metadata,
  per-file symbol/chunk membership and hashes against the manifest and active
  vector rows through a read-only internal inspection adapter. No unexpected
  active files/symbols, pending generations, reindex-required flag, or rebuild
  failure may remain. Deleted files have no active generation/vector rows;
  expected retired tombstones are allowed.
- Direct DLQ inspection succeeds and contains no unresolved fixture entry.
  Direct catalog reads must succeed; a status helper that catches catalog
  failures and omits the field is insufficient.
- A known fixture retrieval through the actual handler passes the response and
  internal-outcome validation below. An old timestamp and one successful probe
  cannot substitute for the all-file audit.

Use one explicit per-scenario deadline. On failure preserve diagnostics and
elapsed time as an invalid record, fail the run, and exclude it from normal
latency summaries. Never silently retry or replace an invalid sample with a
successful attempt. A new explicit run retains a separate run identity.
Warm retrieval first passes this gate. For first-call retrieval, record which
readiness probes ran and their warmed dependencies: this is the first call
for the named workload case, not a claim that every subsystem is untouched.

### Retrieval validity gate

Validate three independent layers for every timed handler invocation:

1. Tool envelope: no exception, `isError`, serialization error, malformed
   structured content, or expired/aborted signal.
2. Internal execution: semantic/grep branch terminal outcomes belong to this
   request and all required branches succeeded. For grep require successful
   child completion (exit 0 or normal no-match exit 1), with no timeout,
   abort, signal termination, or spawn/parser failure. Observe the engine's
   combined timeout signal and spawn boundary, since outer `search()` may
   fulfill with `[]`. Detect malformed match records before the production
   parser can silently skip them. Hybrid requires both branches to succeed,
   even when its public response contains plausible partial results.
3. Fixture response: validate membership/multiplicity and the effective limit
   behavior at each stage, not an assumed requested cap. At the reference
   HEAD require the complete uncapped grep result, including broad queries
   exceeding `requested_max_results`. Validate expected empty cases too.
   Structured positive cases require
   `status: ok`, fresh content where provided, and no reindex requirement.
   Reject `stale`, `stale_identity`, `index_incomplete`, `not_indexed`,
   `not_found`, `excluded`, `unsupported`, `failed`, and unexpected statuses.

Normal zero-match grep is valid only when all three layers succeed. Partial
Hybrid, timeout-to-empty, and Structured non-success are invalid/degraded
diagnostic records, never normal latency samples. Do not assert exact semantic
rankings or model relevance. These guards establish measurement validity only;
quality scoring remains #320.

For sibling worktrees, report independent indexing/readiness cost and provider
work without sharing state. This is the pre-#300 baseline, not a demonstration
of cross-worktree cache reuse. Record unavailable Git support as an explicit
skipped scenario; the full local baseline requires Git.

## Cache measurements

Issue #305 is closed upstream, but its compatibility contract must exist in the
implementation checkout before publishing compatible-cache impact results.
Verify the actual fingerprint implementation and tests during implementation;
issue state alone is insufficient evidence.

Observe lookups at the pipeline cache boundary with bounded outcomes: L1 hit,
L2 hit, and provider-bound miss. Count chunk lookup outcomes separately from
distinct provider input keys: duplicate chunk inputs may share a cached vector
or still be submitted more than once. Follow per-path attribution above. Add
only the missing cache counter/hook, with a finite outcome label and no file,
workspace, model fingerprint, or source labels. Disabled instrumentation must
remain a no-op.

Compare empty caches, same-process L1 reuse, and reopened-runtime L2 reuse under
unchanged compatibility identity. Record duration, lookup counts, provider calls,
and embedded text count. Fail the scenario if its expected cache state was not
exercised. Do not alter cache identity as part of this issue. If the checkout
lacks #305, report this scenario as blocked rather than silently benchmarking
the old identity as compatible.

Keep identity-change regression tests separate from normal benchmark execution.
Contract tests construct isolated real pipeline/store fixtures directly with
two explicit test-only `EmbeddingConfig` identities (A and B) and matching
same-dimension synthetic providers. They use the unchanged production
`createEmbeddingCacheIdentity()` and cache lookup paths. A then A must exercise
same-process L1 and reopened-runtime L2 reuse. For the identity-key contract,
seed test L1/L2 maps with A keys and require B lookups for the same content
to miss. In real pipeline/store integration, construct B with a fresh L1 and
A's persisted L2, and require a provider call plus B-scoped persistence even
if dimensions and synthetic vector values coincide. Do not claim to test a
hot configuration switch: pipeline identity is construction-time state.
Assert namespace separation and provider invocation rather than vector
inequality alone. Retain the existing #305 regression coverage too.

Only contract-test constructors accept B. The normal benchmark adapter retains
its fixed model allowlist; no arbitrary-model override, CLI flag, environment
switch, or production factory test-model selection is introduced. Test-only
identities and their results never appear as a normal baseline workload.

## Samples and resource reporting

The full profile uses 100 measured samples per warm retrieval case after five
warmup calls, and three independent runs of each indexing/lifecycle scenario.
First-call cases use three independent reopened runtimes, one sample per
runtime, with min/median/max rather than tail-percentile claims. Preserve all
raw durations in milliseconds. Compute warm p50/p95/p99 using nearest rank
(`ceil(p * n) - 1` in a sorted, non-empty sample). Lifecycle output includes
all three samples and min/median/max; three samples do not support meaningful
tail-percentile claims. Smoke uses three retrieval samples and one lifecycle
sample and is explicitly unsuitable for baseline or tail-latency conclusions.

Version the JSON report schema. Include:

- Git revision and dirty state, fixture version/digest, workload options.
- Node, OS, architecture, CPU model/count, available memory, and ripgrep version.
- Provider kind/dimensions and storage configuration without credentials.
- Profile, file/byte/declaration counts, scenario, query case, and cache state.
- Raw timings, sample count, summary statistics, operation/result counts.
- Separate runtime-ready, audit, audited-ready, and probe intervals, plus
  candidate endpoint validity and failure diagnostics.
- Requested result limits, per-stage effective behavior, full returned counts,
  and separate legacy/structured row and embedding-work views.
- Node worker CPU deltas, heap-used snapshots, and process peak RSS with units.
- Separate external-process resource scope and unavailable-measurement reasons.
- Index artifact bytes after settled indexing, measured outside timers.
- Explicit skipped/blocked scenarios and failure diagnostics.

Peak RSS is the Node worker's lifetime high-water mark, including setup, not
exact per-operation allocation. CPU deltas from `process.cpuUsage()` and
`process.resourceUsage()` cover that Node worker only, including in-process
native work but not external ripgrep CPU. Heap snapshots mean numeric heap-used
readings, not heap-dump files. Record these scopes and sampling boundaries.

Keep `node_worker`, `external_ripgrep`, and `process_tree` resource fields
distinct. The initial cross-platform runner reports external CPU/RSS and
process-tree totals as unavailable with reason `not_collected`; it does not
substitute zero or label Node CPU as total search CPU. Record observed ripgrep
wall time and exit outcome separately; neither estimates its CPU. Future
process-tree collection must identify its platform/method and remain a
separate comparable series. Grep resource comparisons cannot conclude total
CPU savings from Node-only measurements.
Do not serialize temporary absolute paths, source text, secrets, or environment
variables. Write reports only to a caller-selected output location; otherwise
emit JSON to stdout. Send requested progress/diagnostics to stderr. Normal Nexus
operation remains quiet.

## Baselines and optimization signals

Before optimizations, run all three repository profiles on one machine with
the same workload/options and retain raw JSON plus a readable summary under
`docs/observability/`. Record any blocked scenarios. Keep those results distinct
from smoke artifacts and #320 quality results. Never invent timings in docs.

Use these initial investigation signals, not automatic implementation mandates:

- Investigate #301 when large-profile warm grep p95 exceeds 100 ms on two
  full runs, and scale comparisons show scan cost increasing with source bytes.
- Investigate #300 when the sibling run repeats at least 80% of first-worktree
  provider inputs and indexing represents at least half of cold
  `runtime_ready_ms`, excluding manifest audits and retrieval probes.
- Investigate cache behavior when the unchanged, compatible warm rebuild has
  provider-bound misses after all expected entries were persisted.
- Investigate regressions when median or p95 worsens by more than 20% and at
  least 5 ms on two comparable full runs. Compare fixture digest, runtime,
  hardware, sample count, cache conditions, and effective limit behavior
  before attributing a regression.

These thresholds are starting decision rules, not product latency guarantees.
Require a candidate optimization to beat the matched baseline beyond the noise
floor and pass its independent correctness checks. Lower latency is not evidence
of improved retrieval relevance or source correctness.

LSP startup/request/process measurements remain explicitly deferred until #298
provides the real lifecycle. Text scan/candidate counters are optional only if
available from a stable search boundary; do not parse ripgrep internals or add
fragile instrumentation to satisfy them.

## Verification and CI

Unit-test fixture determinism, byte counts, quantiles, report serialization,
cache outcome accounting, and failure/cleanup behavior. Integration smoke must
exercise real stores and retrieval paths with the local deterministic provider.
Keep tests focused on report/scenario contracts, not timing thresholds.

Add failure-injection regression cases: background startup rejection,
`incomplete`/unowned `already_running`, old completion timestamp, missing
manifest file/chunk/generation, pending state, DLQ entry, and catalog-read
failure must prevent readiness. Also cover each Hybrid branch failing alone,
grep timeout/abort returning `[]`, spawn/parser errors, normal no-match, every
Structured non-success class, malformed synthetic vectors, and degenerate
vector distributions. Assert that invalid records never enter percentiles.
Failure injection is for contract tests only, not timed baseline workloads.

Add R3 contract coverage for uncapped grep queries exceeding a requested limit,
complete result multiplicity, Hybrid branch versus fused-output limits, and
untimed argument-schema preflight. Verify separate legacy/import chunks,
structured rows/generations, catalog imports, and mixed-origin provider batches
without double counting calls or unique keys. Identity-change tests use the
separate fixtures above and must not relax the benchmark adapter allowlist.

Test timing arithmetic with a controlled monotonic clock: added audit delay
changes `audit_validation_ms` and `audited_ready_ms`, not `runtime_ready_ms`;
probe delay changes only its own interval and audited latency. Audit/probe
failure must remove the candidate runtime timing from successful summaries.
These tests verify boundaries, not real-time speed thresholds.

Extend CI with a smoke invocation and uploaded JSON artifact after existing
build prerequisites. Do not gate shared CI on wall-clock performance. Treat
execution errors and malformed/incomplete required reports as failures.
Validate new benchmark TypeScript with
`npx tsc --noEmit -p tsconfig.json`, whose include covers `tests/**/*.ts`.
Add `vitest.performance.config.ts` to that configuration's explicit root-file
include. `tsconfig.build.json` excludes tests and is not this type-check gate.
Lint the new config and benchmark files explicitly because the current lint
script targets `src/**/*.ts` only.

Ordinary `*.test.ts` contract tests remain in the regular unit/integration
suite. Performance execution uses only `*.perf.ts`, E2E uses only
`tests/e2e/**/*.test.ts`, and existing microbenchmarks use only `*.bench.ts`.
Add discovery checks that enumerate files under the normal, E2E, existing
benchmark, and dedicated performance configurations and assert no performance
entry point appears in another suite. In the performance config explicitly
select `*.perf.ts`, disable benchmark discovery, coverage and file parallelism,
and do not inherit the normal/E2E include. Verify with `NEXUS_E2E` both set and
unset; `test:perf` must select the same entry point in either environment.

Document commands, cache semantics, metric inventory, baseline reproduction,
limitations, and optimization signals in
`docs/observability/performance-benchmarks.md`, linked from the observability
README. Implementation completion requires actual baseline runs, not merely
a working report generator. Any dependency-blocked measurement must remain
visible in the completion report and issue acceptance status.

## Review closure map

The following maps requested corrections to design contracts, not independent
PASS findings or implementation verification:

- **FND-299-001:** Ready/completion gate, manifest-wide audit, raw startup
  result observation, queue/DLQ/generation checks, and failure-injection tests.
- **FND-299-002:** Three-layer retrieval gate and request-scoped branch/spawn
  outcomes, including silent Abort-to-empty and Structured status handling.
- **FND-299-003:** Shared internal production assembly, exact handler boundary,
  reserved synthetic provider injection, and unchanged #305 fingerprint path.
- **FND-299-004:** Versioned SHA-256 expansion, normalization, fixed dimensions,
  query/index parity, non-degeneracy checks, and synthetic-only interpretation.
- **FND-299-005:** Outer monotonic completion interval separated from existing
  Reindex duration; runtime-ready and audit-inclusive latency now separated.
- **FND-299-006:** Node-only resource scope separated from uncollected external
  ripgrep/process-tree CPU and RSS.
- **FND-299-007:** Fixed `.perf.ts` entry/config, discovery isolation checks,
  and test-inclusive `tsconfig.json` type checking.

- **R2-NEW-001:** Requested maximum separated from effective uncapped grep
  behavior; full-result validation, stage-specific Hybrid limits, and
  revision-qualified #301 comparisons.
- **R2-NEW-002:** `runtime_ready_ms`, `audit_validation_ms`, and
  `audited_ready_ms` have independent endpoints; full audit/probe success
  remains mandatory before candidate timing enters any normal baseline.
- **R2-NEW-003:** `handler-internal` excludes registration-time MCP schema
  validation; fixture arguments use that schema in untimed preflight.
- **R2-NEW-004:** Separate legacy, structured-vector, catalog, and provider
  accounting with physical versus logical counting and mixed-batch rules.
- **R2-NEW-005:** Fixed normal synthetic model maintained; A/B identity changes
  exercised only by independent pipeline/cache contract-test fixtures.

The workload manifest fixes match positions, uncapped counts, requested limits,
and effective limit behavior without assuming ripgrep traversal order. Worktree
timings remain independent index-cost measurements, not #297 isolation
verification. Independent R3 review must pass before implementation planning,
implementation, and baseline runs.
