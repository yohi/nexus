# Retrieval Performance Baselines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver valid, repeatable retrieval/indexing performance baselines
for issue #299, including real measurements and CI smoke artifacts.

**Architecture:** Reuse production runtime assembly and actual tool handlers,
injecting a fixed local synthetic embedding provider through an internal seam.
Observe swallowed failures before admitting samples; audit all storage paths
outside runtime timing. Run serial isolated workers and aggregate a versioned
JSON report through a quiet parent CLI.

**Tech Stack:** Node.js >=24, TypeScript, npm, Vitest, existing Zod v3,
SQLite, LanceDB, ripgrep, Git; no new package dependencies.

**Spec:** [Approved R3 design](../specs/2026-10-24-retrieval-performance-design.md).
The user supplied independent `DESIGN REVIEW PASS` for R3. Preserve that design
as the baseline; this plan does not claim implementation or runtime validation.

**Plan revision:** R3. Independent review marked PLAN-299-001 through
PLAN-299-005 resolved in plan. This limited revision addresses
PLAN-R2-NEW-001 through PLAN-R2-NEW-003; approved R3 design remains unchanged.
Independent review accepted these corrections as
`LIMITED_PASS / IMPLEMENTATION_PLAN_READY`. Execution authorization remains
separate from plan approval.

## Global constraints

- Implement on `0407c2a688654857fac2d68af6369c3d52a5f399` or a descendant.
  Old local `4fd4872d4baa4394dd3828040f4d52ac9cc9e02d` lacks #305.
- Read the spec and this plan together. Existing partial-search behavior,
  uncapped grep, provider rejection, and cache identity must remain unchanged.
- Primary retrieval boundary: `handler-internal`. Schema preflight is untimed;
  handler result normalization is timed; MCP wire/Transport work is excluded.
- Synthetic model: `nexus-synthetic-sha256-v1`, `provider: test`, 128 dimensions.
  No external embedding requests, credentials, or arbitrary-model switches.
- Profiles: smoke 20 files x 5 declarations; small 100 x 10; medium 1,000 x 10;
  large 10,000 x 10. Helper declarations are included in these counts.
- Full warm retrieval: five unmeasured warmups and 100 measured calls per case.
  Lifecycle/first-call: three independent runs, min/median/max. Smoke is not a
  tail-latency or baseline-quality run.
- `runtime_ready_ms` excludes audit/probe. Audit/probe failure invalidates its
  candidate value and every associated indexing sample.
- Only new metric: bounded cache outcome counter; no new path/query/workspace
  labels. Optional diagnostic observers are not metric families.
- No agent configuration, new public exports, transport options, optimization,
  correctness/relevance scoring, or parse/LSP cache work.
- New modules should stay focused and under 250 nonblank, noncomment code lines;
  extract cohesive helpers while moving assembly, not unrelated behavior.
- Do not commit, push, open a PR, merge, or invoke CodeRabbitCLI without explicit
  authorization. Task checkpoints mean reviewed local diffs, not automatic commits.
  The commit restriction applies to the user's repositories and worktrees.
  The sole fixture exception is a commit inside an isolated temporary Git
  repository created and owned by this benchmark for its worktree scenario.
  Verify ownership/location first. This exception never grants permission to
  commit in Nexus, the user's worktrees, or any pre-existing repository; push,
  PR, merge, and CodeRabbitCLI restrictions remain unchanged.

## Review focus

1. Ordinary factory creation must still reject `provider: test` and preserve
   cleanup/locking even when benchmark injection exists (Task 3 tests).
2. Startup/Hybrid/grep can fulfill after internal failure; missing or late
   outcomes must invalidate samples rather than look fast (Tasks 4, 7, 8).
3. Large audits must finish without materializing every vector/source at once;
   timeout/resource failure is incomplete evidence, not success (Tasks 6, 12).
4. Runtime/Vitest/npm output can corrupt machine JSON; isolated worker logs
   must never reach report stdout (Task 10 subprocess tests).
5. Legacy imports and shared cache keys can hide missing rows or double-count
   provider work; audit physical rows and logical identities separately
   (Tasks 1, 5, 6 tests).

## File and interface map

Production changes are limited to assembly reuse, optional observation, cache
metrics, and read-only audit access. The root `src/index.ts` currently uses
`export * from './server/factory.js'`; do not put benchmark constructors or new
exports in that file's export surface.

- `src/server/factory.ts`: preserve `NexusServerFactory.createRuntime(config)`;
  delegate assembly to a new internal module.
- `src/server/runtime-assembly.ts`: `createRuntimeAssembly(config, dependencies)`
  returns `{ runtime, options, diagnostics }`. `options` is the exact bundle
  used by `buildNexusRuntime`; it is not reconstructed by tests.
- `src/server/runtime/{storage,events,logging,plugins,directory-scan}.ts`: move
  existing factory helper bodies into cohesive modules without behavior changes.
- `src/server/runtime/grep-spawn.ts`: existing real ripgrep spawn/JSON parsing,
  with optional outcome observation; no new cap or alternate grep process.
- `src/observability/runtime-observer.ts`: typed optional diagnostic events and
  safe notification; no source payloads or arbitrary labels.
- `src/indexer/pipeline.ts`, `src/search/{grep,semantic,orchestrator}.ts`: emit
  optional lifecycle/branch outcomes, pre-fusion grep evidence references, and
  origin-aware embedding diagnostics.
- `src/observability/{types,metrics-collector}.ts`: bounded cache outcome hook.
- `src/storage/vector-store.ts` and `src/storage/interfaces/vector-audit.ts`:
  internal read-only paged live-row projection, no public re-export additions.
- `tests/benchmarks/performance/`: contracts, fixtures, synthetic provider,
  observer collector, audit, lifecycle, retrieval, resources, and worker entry.
  `logical-path.ts` owns untimed response-path validation;
  `cache-seed.ts` owns bounded L2 preparation, verification, and diagnostics.
- `scripts/run-performance.mjs`: parent CLI, worker orchestration, final output.
- `vitest.performance.config.ts`: only `**/*.perf.ts`, serial, no coverage.
- `tests/unit/benchmarks/performance/`: fast contract tests (`*.test.ts`).
- `tests/integration/performance/`: real-runtime validity and smoke tests.
- `package.json`, `tsconfig.json`, CI, observability docs: execution/verification.

The storage classes are already exported; mark the new audit reader internal
and do not widen the exported `IVectorStore` contract solely for benchmarks.
Keep audit projection types in the separate internal interface file and do
not add them to public re-exports.

### Shared contracts fixed by this plan

Define these in `tests/benchmarks/performance/contracts.ts` using Zod schemas
and inferred TypeScript types, not duplicate loosely typed interfaces:

- `Profile = 'smoke' | 'small' | 'medium' | 'large'`.
- `RunOptions`: profile, output mode, revision metadata, per-scenario deadline,
  audit page size, fixed cache seed batch size 512, worker memory ceiling, and
  full/smoke sample mode. The worker deadline/heap ceiling also cover setup.
- `FixtureManifest`: version/digest, files and UTF-8 bytes, per-file content
  hashes, declarations/imports, separate legacy/structured expected row keys,
  and query cases. No expected count may be inferred from the resulting index.
- `QueryCase`: tool, schema-validated args, expected matching-line/submatch
  multiset, requested maximum, and per-stage effective limit behavior.
- `AuditResult`: valid/invalid discriminated union; per-path counts and bounded
  failure records, with no vector arrays or raw source retained in reports.
- `RetrievalValidation`: valid/invalid discriminated union containing only
  validated logical result identities/counts, the validated pre-fusion grep
  multiset proof where required, or bounded failure codes.
- `GrepMultisetProof`: algorithm `sha256-multiset-v1`, line-match count,
  submatch count, canonical digest, and valid/invalid status. Captured source
  arrays and absolute paths are never schema fields.
  Invalid proofs may omit an uncomputable digest/count, with a bounded reason;
  missing evidence is never represented as a successful empty-result proof.
- `ScenarioRecord`: valid/invalid/skipped/blocked discriminated union; revision,
  boundary, cache state, raw samples, resource scopes, validity checks, and
  lifecycle endpoints. Only valid records feed normal summary statistics.
- `PerformanceReport`: `schemaVersion: 1`, recipe version, environment,
  options, scenario records, and summaries. Keep failed runs machine-readable.

Use `AbortSignal` and `Readonly` inputs throughout. Diagnostic errors carry
bounded codes; sanitize machine-specific paths before reporting messages.

### Response-path contract (PLAN-299-001)

Canonicalize the generated fixture root with `realpath()` in untimed setup
before passing it as the runtime project root. Manifest paths are non-empty,
root-relative POSIX logical paths with no `.`/`..` segments, NUL, or foreign
drive/UNC syntax. Fixture files/directories are generated without symlinks.

`createFixturePathNormalizer(root: string, manifest: FixtureManifest)` in
`logical-path.ts` builds the canonical manifest-file mapping during untimed
setup and returns `Promise<FixturePathNormalizer>`, where
`FixturePathNormalizer = (returnedPath: string) => Promise<string>`. The returned
normalizer accepts native absolute paths under that canonical root, or
already-logical relative paths satisfying the manifest grammar. For an absolute
path, use native `path.relative(root, path.resolve(returnedPath))`; reject an
empty file path, an absolute result, `..`, or a result beginning with
`..${path.sep}`. Never use string-prefix containment. Relative inputs containing
traversal segments, drive-relative forms, or invalid separators fail rather
than being repaired. On Windows convert valid native separators to `/` after
containment checks; on POSIX reject backslashes/foreign Windows path forms.

Resolve the candidate's real path and recheck root containment to reject
symlink escapes; require the logical path to name a manifest file and its real
path to equal the preflight canonical manifest-file mapping. A missing file,
alias to another manifest identity, or unknown path invalidates the sample.
Do not lowercase paths or apply Unicode normalization that could merge distinct
names. Invalid-path diagnostics contain bounded codes, not the rejected path.

Run this only on a new validation projection after the handler timer stops.
Never rewrite the original envelope, raw handler result, or production grep
arguments. Normalize all path-bearing grep matches and grep-derived/merged
Hybrid entries before manifest comparison. Report only validated logical
paths; do not retain raw envelopes, absolute chunk IDs, or unsafe error strings
in intermediate/final JSON. Rebuild diagnostic match identities from logical
path, line, and submatch offsets instead of serializing raw absolute-path IDs.

Compare a multiset keyed by logical path, line, line-content digest, and
submatch start/end/content digest. Preserve multiplicities; do not deduplicate
normalization collisions. Repeated normalized keys are valid only at the
exact manifest multiplicity; extra occurrences or aliases fail. Continue to
require complete uncapped grep results, with no benchmark truncation. Keep
Hybrid's complete grep-branch multiset separate from its final RRF output.
Final diagnostic keys also retain stage/source provenance; legitimate
cross-origin entries must not be collapsed into a false duplicate grep match.

## Dependencies and execution order

```text
0 base gate -> 1 contracts/fixtures -> 2 synthetic provider
2 -> 3 production assembly -> 4 failure observation -> 5 cache accounting
3 + 4 + 5 -> 6 audit -> 7 lifecycle -> 8 retrieval
7 + 8 -> 9 resources/reporting -> 10 parent CLI
10 -> 11 CI/quality gates -> 12 full baselines/docs
```

Do not parallelize production-file edits across Tasks 3-5. Task 9's pure
statistics can be implemented independently after Task 1, but integrate it
only against the contracts below. Checkpoint each task with focused tests and
an inspected diff. No commit operation is implied.

### Mandatory independent review gates

Use a single implementer for sequential execution. After Tasks 3, 6, 10, and
12, pause and obtain an independent review from a reviewer other than the
implementer. Self-review and passing automated checks do not replace this gate.
Provide the cumulative diff, completed-task scope, verification commands and
results, and remaining limitations. Record the review verdict and findings.

- [ ] **After Task 3, before Task 4:** Review production assembly reuse,
  provider injection isolation, public API compatibility, and lock/store cleanup.
- [ ] **After Task 6, before Task 7:** Review observation/evidence contracts,
  cache accounting and compatibility, and complete per-path storage audits.
- [ ] **After Task 10, before Task 11:** Review timing boundaries, retrieval
  validity, Hybrid evidence, worker resources/cleanup, and JSON-only output.
- [ ] **After Task 12, before completion/acceptance handoff:** Review actual
  small/medium/large baseline evidence, large-profile RSS/deadlines, CI results,
  documentation, and the requirement-to-evidence checklist.

Each gate requires PASS before proceeding. If changes are requested, resolve
the findings, rerun affected checks, and obtain independent re-review. Missing
review or incomplete evidence leaves the gate pending; do not infer approval.
Review PASS never authorizes a commit, push, PR, or merge.

### Task 0: Establish the #305-compatible execution base

**Files:** Existing worktree metadata; approved spec and this plan only.

- [ ] Read applicable `AGENTS.md`, README, spec R3, and this plan in the execution
  worktree. Load the execution and language/TDD skills at implementation time.
- [ ] Run `git status --short`, `git rev-parse HEAD`, and
  `git merge-base --is-ancestor 0407c2a688654857fac2d68af6369c3d52a5f399 HEAD`.
  Require exit 0 for ancestry. The current old worktree fails this gate.
- [ ] Use the worktree skill to establish an isolated feature worktree based on
  that commit or a descendant; preserve/copy these untracked documents without
  discarding user work. Do not merge/rebase/reset the current master to obtain
  the base. Record the actual execution revision.
- [ ] Confirm `src/indexer/embedding-cache-identity.ts` and its pipeline/factory
  wiring exist. Run `npx vitest run tests/e2e/embedding-cache-compatibility.test.ts`
  with `NEXUS_E2E=1`; require the file to be discovered and its tests to pass.
- [ ] Check Node >=24, `rg --version`, `git --version`, local dependencies, and
  available disk/memory. Prefer an existing devcontainer environment. If an
  initial setup is needed, follow the repository's Source Build/Package Usage
  choice contract rather than silently installing dependencies.

Deliverable: compatible isolated execution base and recorded preflight evidence.

### Task 1: Versioned contracts and deterministic fixture manifest

**Files:** Create `tests/benchmarks/performance/{contracts,profiles,fixtures}.ts`,
`tests/unit/benchmarks/performance/fixtures.test.ts`, and
`tests/unit/benchmarks/performance/contracts.test.ts`.

**Interfaces:** `generateFixture(root: string, profile: Profile):
Promise<FixtureManifest>`; `applyIncrement(root, manifest)` returns a new manifest
and exactly one added, modified, and deleted file event. `reportSchema` parses
`PerformanceReport`; `profiles` fixes file/declaration counts from the spec.
Use profile properties `files` and `declarationsPerFile`; representative
`profile_sizes_are_fixed` assertions are:

```typescript
expect(profiles.smoke).toEqual({ files: 20, declarationsPerFile: 5 });
expect(profiles.large).toEqual({ files: 10_000, declarationsPerFile: 10 });
```

- [ ] Write failing tests asserting the four exact profile sizes, identical
  digests across temporary roots, UTF-8 bytes counted from generated source,
  disjoint incremental operations, and malformed report rejection.
  Require every manifest path to satisfy the logical-path grammar above;
  absolute/traversal paths must fail manifest parsing, never be stored as IDs.
- [ ] Include an import-bearing fixture: legacy has an extra aggregate imports
  chunk, structured declarations/import records remain separately counted.
  Include repeated helper content without adding uncounted declarations.
- [ ] Run `npx vitest run tests/unit/benchmarks/performance/fixtures.test.ts
  tests/unit/benchmarks/performance/contracts.test.ts`; require missing-module
  or missing-contract failures before implementation.
- [ ] Implement recipe `retrieval-performance-v1`, fixed top-level function
  declarations, bounded import blocks, package-like paths, and selective,
  broad, no-match, early-line, late-line query cases. Requested grep maximum
  is 100; the broad case must exceed it. Hybrid final topK is 20; structured
  context token budget is 1,000. Query flags and limits belong in the manifest.
  Include query case `hybrid-pre-fusion-125`: place one unique marker on each
  of exactly 125 deterministic comment lines distributed across fixture files,
  even in smoke mode, with one submatch per line. Comments add no declarations;
  account for their source bytes/spans/chunk hashes in the manifest. This makes
  the real-handler 125-versus-20 evidence test reproducible at every scale.
- [ ] Implement per-file expected physical identities/spans/hashes directly
  from the generator's source spans, not a parser/index result. Fix
  `maxChunkChars: 4096` and keep every generated declaration/import block below
  it; align exact legacy versus structured content extraction expectations.
  Keep hash domains explicit: canonical fixture digest and structured
  file/symbol hashes use SHA-256; Merkle and embedded chunk content hashes use
  existing `computeStringHash()` from `src/indexer/hash.ts` (xxHash64).
  Store each expected chunk's own content hash, never substitute a file hash
  or structured symbol SHA-256 when deriving #305 embedding cache keys.
- [ ] Rerun both test files; require PASS and no absolute roots in serialized
  fixture metadata. Store actual scale counts, not approximate byte targets.

### Task 2: Fixed synthetic provider and distribution preflight

**Files:** Create `tests/benchmarks/performance/synthetic-provider.ts` and
`tests/unit/benchmarks/performance/synthetic-provider.test.ts`.

**Interfaces:** `createSyntheticProvider(): EmbeddingProvider` and
`validateSyntheticDistribution(texts: readonly string[]): void`. Export a fixed
`syntheticEmbeddingConfig` matching the R3 allowlist; no model argument.

- [ ] Write failing tests for identical text across batches/restarts, abort,
  128 finite components, unit norm within `1e-6`, and no collisions/zero
  component variance for fixed strings `preflight-0` through `preflight-127`.
- [ ] Run `npx vitest run
  tests/unit/benchmarks/performance/synthetic-provider.test.ts`; expect FAIL.
- [ ] Implement the R3 SHA-256 expansion exactly: tag, zero separator, 32-bit
  big-endian counter 0..15, UTF-8 text, unsigned component mapping, L2 norm.
  Record version/dimensions in workload identity; health check stays local.
- [ ] Derive and pin reference vector digests using a separately written
  one-off verifier, then remove that temporary verifier. Include normalization
  serialization precision in the reference-digest test, not report metadata.
- [ ] Rerun tests; require PASS. Demonstrate that an all-identical-vector test
  provider fails distribution checks even in smoke mode.

### Task 3: Shared production assembly and benchmark-only injection

**Files:** Modify `src/server/factory.ts`; create the runtime assembly/helper
modules listed in the file map, the observer type contract in
`src/observability/runtime-observer.ts`, and
`tests/benchmarks/performance/runtime.ts`.
Extend `tests/unit/server/factory.test.ts`; create
`tests/integration/performance/runtime-construction.test.ts`,
`tests/unit/server/public-exports.test.ts`, and the fixed execution-base snapshot
`tests/fixtures/performance/public-exports.json`.

**Interfaces:** Internal `createRuntimeAssembly(config: Config,
dependencies?: RuntimeAssemblyDependencies): Promise<RuntimeAssembly>`.
`RuntimeAssembly` contains `runtime: NexusRuntime`,
`options: NexusRuntimeOptions`, and `diagnostics: RuntimeDiagnostics`.
The optional dependency is a provider factory plus diagnostic observer, not
alternate stores/handlers. `createBenchmarkRuntimeFactory(root, observer)`
returns `RuntimeFactory = (signal: AbortSignal) => Promise<RuntimeAssembly>`.
It prepares only immutable fixture configuration outside timing: no project
directory creation, lock acquisition, stores, provider registration, or runtime
construction occurs until that returned function is invoked. Its invocation
supplies the fixed synthetic dependency and constructs the actual assembly.
Build handlers from that returned assembly, not an independently built graph.
Define `RuntimeDiagnostics` in an internal assembly-types module: concrete
metadata/vector readers, queue snapshot, and pending-drain count. Task 4 adds
the actual observation-backed state revision, not a placeholder audit success.
Do not import benchmark types into production source. Establish the observer
type contract described in Task 4 here so this checkpoint compiles; its
default is absent and emitting instrumentation is Task 4's deliverable.

- [ ] Add failing regressions for production test-provider rejection,
  production provider selection, actual store/handler object identity, project
  lock exclusion, initialization failure cleanup, and repeated close safety.
- [ ] Before moving helpers, capture sorted runtime export names from
  `src/index.ts` and `src/server/factory.ts` at Task 0's compatible base into
  the static snapshot. Pin factory exports to exactly `NexusServerFactory`
  and `assertPackageModeConstraints`. Test imports of the latter through both
  modules resolve to the same function and preserve package-mode rejection
  of non-Bedrock providers and acceptance of allowed Bedrock configuration.
  The test must fail if either public route is removed. Review the snapshot;
  never regenerate it automatically after refactoring to bless an API change.
- [ ] Run `npx vitest run tests/unit/server/factory.test.ts
  tests/integration/performance/runtime-construction.test.ts`; expect new
  assembly/injection assertions to fail.
- [ ] Move existing helpers verbatim into cohesive internal modules and wire
  one shared builder. Preserve startup, watcher, event drain, file logging,
  metric registration, defaults, locks, rollback, and shutdown ordering.
  Normal `createRuntime(config)` still returns only `NexusRuntime`.
- [ ] Make test-provider acceptance require the explicit internal dependency
  and exact allowlisted config; absent/mismatched injection fails. Register
  and instrument it as `test`, pass identical effective config to #305, and
  build handlers from the original options plus `runtime.initialize`.
- [ ] Keep the new constructor in `runtime-assembly.ts`, not an exported helper
  in `factory.ts`: the latter is wildcard-exported by `src/index.ts`.
  If `assertPackageModeConstraints` moves into the plugin helper, explicitly
  re-export it from `factory.ts` under the original name and signature.
- [ ] Rerun focused tests plus `tests/unit/server/index.test.ts` and
  `tests/unit/server/public-exports.test.ts` and
  `tests/integration/mcp-protocol.test.ts`; require PASS. Compare exact public
  export sets before/after and verify emitted package declarations after build
  retain both public routes without benchmark entry points.

### Task 4: Observe swallowed failures without changing production results

**Files:** Extend `src/observability/runtime-observer.ts`; create
`tests/benchmarks/performance/{outcomes,grep-evidence}.ts`; modify pipeline,
semantic search, grep engine, `src/search/orchestrator.ts`, runtime event
manager, and real grep spawn/parser modules.
Create `tests/unit/benchmarks/performance/outcomes.test.ts` and
`tests/integration/performance/failure-observation.test.ts`.

**Interfaces:** `RuntimeObserver.onEvent(event: RuntimeEvent): void` is optional
and safely invoked. A discriminated union covers work start/end, raw Reindex
result/rejection, drain state, compaction failure, branch terminal outcome,
grep timeout/abort/exit/parser failure. `OutcomeCollector.run(requestId, work)`
uses async-local request/phase association; `seal(requestId)` rejects missing,
duplicate, or inconsistent terminal events. Use a counter for state revision
so audits detect concurrent runtime mutation.
Define internal `withObservationContext({ requestId, phaseId }, work)` in
`runtime-observer.ts` using `AsyncLocalStorage`, not in a test module imported
by production. Events include monotonic time, work ID, parent work ID, context,
and a discriminated terminal outcome; no source text. Assign work IDs at work
entry and preserve them through branches/spawn/drain completion.

Add an optional internal capture method on the observer:
`captureGrepResults(context: ObservationContext,
matches: readonly GrepMatch[]): GrepEvidenceRef`. `GrepEvidenceRef` is an opaque,
request-scoped token, not a path/content-bearing payload. The collector owns a
private immutable snapshot of match fields/submatches; no raw snapshot is
included in `RuntimeEvent`, metrics, intermediate JSON or final reports.
Record `grep_results_captured` with token, request/phase/work IDs, and raw
match/submatch counts. A capture exception/missing reference is observed as
unavailable evidence; safe notification preserves production results but the
benchmark sample fails closed.

In Hybrid, capture `grepResult.value` only on fulfillment, after
`Promise.allSettled()` and before `grepMatches.map()` or `fuseResults()`.
Capture the full array, including zero matches, never the final topK slice.
Direct grep captures its complete result at the engine's fulfilled boundary;
correlate captures by parent/request and stage, not counts alone. Neither a
second grep execution nor final RRF output is a substitute for evidence of
the measured branch. Branch-success status remains independently mandatory.

Snapshot copying overhead happens inside the observed handler and is included
in its duration. No filesystem/path validation or multiset hashing happens in
that callback. After handler end-time capture, `validateGrepEvidence(ref,
manifestCase, normalizePath): Promise<GrepMultisetProof>` consumes the private
snapshot, applies the existing path contract, and compares it to independently
generated manifest expectations. Keep this in `grep-evidence.ts`; do not
import benchmark validation into production.

Proof algorithm `sha256-multiset-v1`: each row's canonical JSON contains logical
path, line number, SHA-256 of line text, and its sorted submatch tuples
`[start, end, sha256(match)]`. Hash that row, sort `[rowHash, multiplicity]`
pairs, and hash their canonical JSON. Record algorithm, match count, submatch
count, digest and validity only. Preserve `lineText` newlines and byte-based
submatch offsets; do not trim source text or reinterpret offsets as characters.
Compute the expected proof from the fixture
recipe, not from captured results. Missing/extra/repeated rows or submatches
must change counts/digest and invalidate the sample. Release raw snapshots
in `finally`, including validation failure, cancellation, or worker shutdown.
If sealing cannot resolve every required capture, emit invalid evidence rather
than assuming that successful branch completion proves result completeness.

- [ ] Write failing tests for background Reindex rejection hidden by runtime,
  each Hybrid branch rejecting alone, grep abort fulfilling `[]`, late child
  close, malformed match JSON, missing outcomes, and throwing observers.
- [ ] Add a Hybrid test with 125 successful grep line matches, at least 125
  submatches, and `topK: 20`: require full pre-fusion proof for all 125 while
  public output contains 20. Inject a missing, duplicate, added, or altered
  branch row outside the final 20; the final output may remain identical but
  the proof must fail. Also test wrong-request tokens, missing captures, normal
  zero matches, redaction, thrown capture, and raw-snapshot release.
- [ ] Run `npx vitest run tests/unit/benchmarks/performance/outcomes.test.ts
  tests/integration/performance/failure-observation.test.ts`; expect FAIL.
- [ ] Observe raw pipeline promises before runtime catches; include owning
  invocation IDs for `already_running`. Observe in-flight drain work and
  queue/post-scan settlement, not only `getProgress().status`.
- [ ] Observe semantic branch settlement before Hybrid fusion. Observe grep's
  combined timeout signal and actual child lifecycle before either empty-result
  conversion, retaining exit 0/1 versus abort/error. Keep parsing semantics but
  emit invalid-match diagnostics before silently discarded malformed matches.
- [ ] With observers absent, preserve original results/errors/logging exactly;
  safe notification must not add normal-operation logs. A broken collector
  cannot manufacture successful terminal evidence.
- [ ] Rerun focused tests and existing search/grep timeout tests; require PASS
  and original partial-success behavior. No new Prometheus family in this task.

### Task 5: Bounded cache metrics and origin-aware provider work

**Files:** Modify `src/indexer/pipeline.ts`,
`src/observability/{types,metrics-collector}.ts`; extend
`tests/unit/observability/metrics-collector.test.ts`; create
`tests/integration/performance/cache-accounting.test.ts` and
`tests/unit/benchmarks/performance/cache-identity.test.ts`.

**Interfaces:** Optional
`MetricsHooks.onEmbeddingCacheLookup?(outcome, count): void`, outcome fixed to
`l1_hit | l2_hit | miss`. Counter:
`nexus_embedding_cache_lookups_total` with that bounded outcome label and the
existing process identity labels only. Diagnostic events carry origin and
batch composition separately, not new metric labels.

- [ ] Write failing tests: each chunk occurrence has exactly one terminal
  cache outcome; L1 miss/L2 hit counts only L2; mixed-origin batch counts one
  provider call; duplicate submitted items and distinct keys stay separate.
- [ ] Add A/A L1 and reopened-L2 reuse integration, A/B same-dimension namespace
  miss integration, and A-seeded L1/L2 key-map contract tests. These use direct
  test pipeline constructors; benchmark allowlist remains fixed.
- [ ] Run `npx vitest run tests/integration/performance/cache-accounting.test.ts
  tests/unit/benchmarks/performance/cache-identity.test.ts
  tests/unit/observability/metrics-collector.test.ts`; expect FAIL.
- [ ] Preserve #305 key generation and batching order. Track occurrence origin
  before flattening legacy/structured chunks; count unique keys as a union,
  not per-origin sums. Do not introduce deduplication or cache optimizations.
- [ ] Rerun tests; require PASS and exact bounded labels. Rerun existing #305
  E2E coverage with `NEXUS_E2E=1`. Keep hot config switching out of test claims.

### Task 6: Streaming per-path physical audit

**Files:** Create `src/storage/interfaces/vector-audit.ts`; modify
`src/storage/vector-store.ts`; create
`tests/benchmarks/performance/{audit,audit-manifest}.ts`,
`tests/integration/performance/audit.test.ts`.

**Interfaces:** Internal `iterateAuditRows({ pageSize, signal }):
AsyncIterable<VectorAuditRow>` reads actual live legacy and active structured
tables with minimal identity/hash/span projections, no vector columns.
`auditRuntime(reader, manifest, signal): Promise<AuditResult>` also reads
catalog records, generation metadata, persisted counters, and DLQ directly.
Use page size 512; never call full-table `toArray()` with vector payloads.

- [ ] Write failing tests for legacy imports chunk, missing/duplicate row,
  wrong hash/generation, unexpected active file, pending generation, deleted
  active row, catalog read error, and DLQ entry. Tombstones for expected
  retired symbols do not count as active rows or failures.
- [ ] Run `npx vitest run tests/integration/performance/audit.test.ts`;
  expect FAIL.
- [ ] Implement paged projection under settled runtime state. Match table-local
  keys and per-file expected sets; compare legacy-only `getStats()` against
  its own view. Read structured imports separately from declarations/vectors.
  Capture state revision before/after and invalidate concurrent mutation.
- [ ] Retain manifest identifiers/hashes, not all vectors/source texts; release
  per-file comparison sets after auditing. Cap diagnostic examples at 20 per
  error code while retaining total failure counts. Honor cancellation between
  pages/files; no partial audit is valid.
- [ ] Rerun tests; require PASS. Add a paged-reader spy proving requests never
  exceed 512 rows or project embeddings, plus timeout/cancellation cleanup.

### Task 7: Lifecycle scenarios and separated readiness clocks

**Files:** Create
`tests/benchmarks/performance/{lifecycle,readiness,clock,cache-seed}.ts`,
`tests/unit/benchmarks/performance/cache-seed.test.ts`, and
`tests/integration/performance/lifecycle.test.ts`.

**Interfaces:** Readiness-bearing scenarios use
`runStartupScenario(kind, createRuntime: RuntimeFactory, manifest, options):
Promise<ScenarioRecord>`. Kinds are cold initial index/ready, L2 rebuild, warm
restart, and each sibling-worktree startup. Each independent runtime receives
a fresh uninvoked factory from Task 3. Its indexing interval may also be
reported separately from its construction-to-ready interval.

`captureReadiness(createRuntime: RuntimeFactory, collector, manifest, clock,
signal): Promise<ReadinessCapture>` owns creation and the R3 endpoints.
`ReadinessCapture` is an internal valid/invalid union: success contains the
audited record plus assembly for subsequent retrieval; failure contains only
the invalid record after construction/initialization cleanup. Never serialize
the assembly. Its first timed actions must be equivalent to:

```typescript
const t0 = clock.now();
const assembly = await createRuntime(signal);
```

No await, store initialization, project lock acquisition, or runtime creation
may occur between those actions or before t0 under a preconstructed assembly
alias. Observer installation and fixture/cache preparation are outside t0,
but construction happens inside the observation scope. Continue with runtime
initialization, successful indexing and queue settlement before t_runtime;
perform audits/probe afterward. `clock.now()` defaults to `performance.now()`.

Existing-runtime work uses a different contract:
`runExistingRuntimeScenario(kind: 'l1_replay' | 'incremental', assembly,
manifest, options): Promise<ScenarioRecord>`. It starts its indexing-operation
timer immediately before the production entry point and never manufactures
`runtime_ready_ms` from the time the already-built assembly was supplied.
The field is absent for these operation-only records. First-call retrieval
obtains its fresh runtime through `captureReadiness()` too; reuse the returned
audited assembly rather than recreating a readiness timestamp later.
Startup-only runners close the successful assembly in `finally`; retrieval
runners own it until sampling ends. Existing-runtime operations borrow it and
leave final close to their caller. Partial constructor cleanup stays with the
shared builder; failed capture closes any fully created assembly before return.

`seedCompatibleCache(source, target, manifest, signal): Promise<CacheSeedResult>`
uses batch size 512. Each endpoint contains a real `SqliteMetadataStore`, its
effective `Readonly<EmbeddingConfig>`, and its owned database path; the target
is new and empty. Compare #305 identity keys for a fixed compatibility probe
without exporting configuration/secret values. Return only counts, key-set
digest, duration, max requested batch size, and validation status, never vectors.
Record setup duration separately from runtime/indexing samples.

Enumerate the distinct #305 keys derived from both manifest chunk views in
deterministic sorted order. Holding sorted keys/verification sets is allowed;
holding all vectors is not. For each at-most-512-key batch:

1. Check cancellation/deadline and source/target compatibility identity.
2. Call `getEmbeddings(batchKeys)` once, requiring exactly those keys with
   finite 128-dimensional vectors; missing/corrupt/foreign entries fail setup.
3. Call `setEmbeddings(entries)` with at most 512 entries. Keep only this
   batch's vector digests for readback, then clear the vector map/entry array
   and end their lexical lifetime before retrieving the next vector batch.
4. Read back the same target keys in a bounded batch and compare dimensions,
   values/digests and membership. Release readback vectors before proceeding.
5. Retain only verified key identities/counts, not vector references.

After all batches, stream target cache keys through a read-only SQLite key
projection and require exact set equality with expected and verified keys,
with no extra keys. Do not call `getEmbeddings()` with the full key union:
its internal 999-key SQL splitting still accumulates one unbounded result map.
Bound live retained numeric-vector batches independently of SQLite's SQL limit;
do not promise immediate garbage collection or equate heap ceiling with RSS.

The scenario's wall deadline, cancellation, heap ceiling and setup-resource
diagnostics start before seeding. Record `cache_seed_ms`, expected/verified key
counts, batch limit and completion status; this interval is untimed setup for
runtime comparisons but not exempt from safety limits. On any transfer,
readback, compatibility, deadline or memory failure, close stores, discard the
owned partial target, and emit an invalid `phase: setup` record. Never run a
nominal warm-cache scenario against a partial seed or silently resume/retry it.

- [ ] Write failing tests for successful cold/no-op warm startup, swallowed
  failure, `incomplete`, unowned `already_running`, stale timestamp, undrained
  queue, dropped event, incomplete manifest, audit/probe failure, and state
  mutation after candidate completion. None may enter normal summaries.
- [ ] Test injected audit/probe clock delays: audit delay never changes
  `runtime_ready_ms`; probe delay changes only probe/audited intervals.
- [ ] With a controlled clock, make factory construction consume 37 ms,
  initialization 23 ms, indexing/queue settlement 11 ms, audit 5 ms and probe
  3 ms. Require `runtime_ready_ms: 71`, `audit_validation_ms: 5`,
  `retrieval_probe_ms: 3`, `audited_ready_ms: 79` with no orchestration gaps.
  Assert the factory is called exactly once after t0, never in untimed helper
  creation. Delaying construction must increase runtime-ready time; a rejected
  constructor produces an invalid construction-phase record and releases any
  acquired lock/store. Incremental records must not contain a synthetic ready
  value. These clock fakes are contract tests, not measured baseline runtimes.
- [ ] Test 1,025 expected keys are requested/transferred/read back as
  512/512/1 with deterministic key order and no full-key vector read. Spy on
  both APIs' input lengths at call entry and vector-map clearing before the
  next batch; do not inspect a later-mutated mock argument as its original size.
  Only key/digest state may cross batches. Inject failure in batch 2, missing
  source key, corrupt vector, target extra/missing key, readback mismatch,
  identity mismatch,
  timeout and abort; require invalid setup, cleanup, and zero warm samples.
- [ ] Run `npx vitest run tests/integration/performance/lifecycle.test.ts`;
  expect FAIL.
  Also run `npx vitest run tests/unit/benchmarks/performance/cache-seed.test.ts`
  before/after implementation; require initial FAIL then PASS.
- [ ] Implement t0, candidate t_runtime, audit endpoints, and probe endpoint as
  R3 defines; only promote candidate/indexing times after full audit/probe.
  Preserve existing Reindex duration as a differently named diagnostic.
- [ ] Implement cold index, L1 warm replay, L2 warm rebuild, warm restart,
  incremental add/modify/delete, and real sibling Git-worktree scenarios.
  For L2 rebuild, settle the source runtime and use `seedCompatibleCache()`
  to populate a new isolated metadata store in bounded batches. Close source
  and target before starting the new runtime on that target and a fresh vector
  directory. Do not copy Merkle/catalog/index state or clear retained cache.
  Normal startup must process every fixture file and prove L2 hits after full
  seed verification. This is fixture preparation, not production cache sharing.
  Keep all state outside scanned source directories.
- [ ] Reconcile watcher interaction: settle/drain setup notifications before
  clocks, submit changes through production queue/reconciliation, and audit
  the exact post-increment manifest. Reject unexpected duplicate pending work.
- [ ] Create sibling worktrees from one disposable committed fixture revision;
  commit only generated fixture content inside that temporary Git repository
  as an intrinsic benchmark operation, never the user's project. Close both
  runtimes before removing worktrees/repository in `finally`.
  Use two ordered guards. Before `git init`, require a newly created,
  benchmark-owned canonical temporary directory outside the user's repo and
  worktrees, with no `.git` and no ancestor repository. Run read-only repository
  discovery with inherited repository-selection variables (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_COMMON_DIR`) removed. Expected `not a git repository`
  is the valid pre-init state; a discovered repository or unrelated discovery
  error fails closed. Only then run `git init` in that directory.
  After successful init, require `git rev-parse --show-toplevel` to resolve
  exactly to that canonical temporary root before any add, commit or worktree
  command. Failed init or wrong top level prevents all subsequent writes.
  Use explicit cwd and per-command Git identity settings; never change user
  Git configuration. Test pre-init non-repo success, ancestor-repo rejection,
  init failure, and post-init mismatch, including that add/commit/worktree
  were not invoked on failure. Preserve the temporary-fixture-only exception.
- [ ] Rerun tests; require PASS, no leftover processes/worktrees, and correct
  L1/L2 evidence. Without Git, record skipped sibling scenario; full baseline
  remains incomplete. Do not label watcher debounce as measured.

### Task 8: Actual handler retrieval and full-result validation

**Files:** Create `tests/benchmarks/performance/{retrieval,validate-response}.ts`,
`tests/benchmarks/performance/logical-path.ts`,
`tests/unit/benchmarks/performance/logical-path.test.ts`,
`tests/unit/benchmarks/performance/retrieval.test.ts`, and
`tests/integration/performance/retrieval.test.ts`.

**Interfaces:** `validateArguments(tool, args)` uses
`z.object(toZodV3Shape(definition.input))` in untimed setup.
`runRetrievalCase(handlers, queryCase, collector, options, normalizePath)` returns
raw timings and guarded outcomes. Here `normalizePath: FixturePathNormalizer`
is built once during setup, not serialized in `RunOptions`.
`validateHandlerResponse(queryCase, envelope, outcomes, normalizePath):
Promise<RetrievalValidation>` enforces all three R3 layers after handler timing.
For Hybrid it resolves Task 4's measured pre-fusion evidence reference and
validates the complete grep proof independently of the final RRF result.
`GrepMultisetProof` is schema-defined in Task 1 contracts with only algorithm,
counts, digest and validity; no raw capture is report data.

- [ ] Write failing tests for schema preflight failure, normal empty grep,
  broad grep exceeding requested 100, missing/extra/submatch results, Hybrid
  partial success, final topK versus uncapped branch, and all Structured
  non-success statuses. Assert no benchmark-side truncation.
- [ ] Add `logical-path.test.ts` cases for native absolute paths under root,
  valid logical paths, sibling-prefix roots, outside-root paths, `..` traversal,
  NUL, foreign/drive-relative forms, unknown/missing files, symlink escape,
  internal aliases, separator/case preservation, and duplicate normalized
  keys. Run native Windows cases on Windows and explicit rejection cases on
  POSIX; do not pretend POSIX `realpath()` validates Windows filesystem paths.
  Exact expected multiplicity, not a Set, decides whether duplicates are valid.
- [ ] Add real-handler integration for both `grep_search` and Hybrid grep-derived
  entries returned with absolute paths. Assert their projected logical match
  identities pass manifest comparison and raw envelopes remain unchanged.
  Inject a delayed normalizer/clock spy: it runs after handler end-time capture
  and cannot change the recorded handler duration. An escaped Hybrid path must
  invalidate the sample even if the public response is otherwise successful.
- [ ] Integrate the 125-match/topK-20 case with real grep and actual handlers.
  Require full branch proof plus the separate final topK membership guard.
  An unchanged valid final top20 cannot rescue missing/mismatched branch
  evidence. Assert proof digest ignores raw return ordering but detects exact
  multiplicity and submatch changes; no raw content/absolute paths survive
  serialization. Validate after the handler timer, then release the capture.
- [ ] Run `npx vitest run tests/unit/benchmarks/performance/retrieval.test.ts
  tests/integration/performance/retrieval.test.ts`; expect FAIL.
  Include `npx vitest run
  tests/unit/benchmarks/performance/logical-path.test.ts` in the red/green cycle.
- [ ] Implement all six handler paths, fixed args, real result formatting,
  exact grep multiset validation, and semantic fixture-membership guards
  without ranking/quality scores. Require both Hybrid branches to succeed.
  Use the response-path contract for validation projections only; all raw
  result processing stays at the original production/timing boundary.
- [ ] Sample five warmups then 100 warm calls for full mode; use three separate
  reopened runtimes for first-call cases. Smoke uses three warm calls and one
  first-call/lifecycle run. Record readiness probes/warmed dependencies.
- [ ] Rerun tests; require PASS. No silent retry or combining query cases into
  one tail distribution; unknown/error outcomes remain invalid records.

### Task 9: Statistics, scoped resources, and report schema

**Files:** Create `tests/benchmarks/performance/{statistics,resources,report}.ts`
and `tests/unit/benchmarks/performance/report.test.ts`.

**Interfaces:** `summarizeWarm(samples)` computes nearest-rank p50/p95/p99;
`summarizeLifecycle(samples)` returns raw/min/median/max, never meaningful tails.
`captureResources()` returns Node-only CPU/heap/RSS scopes and explicit
unavailable external CPU/RSS/process-tree fields. `buildReport(records, meta)`
validates `PerformanceReport` before serialization.
The `nearest_rank_100_samples` test pins summary field names and values:

```typescript
const samples = Array.from({ length: 100 }, (_, i) => i + 1);
expect(summarizeWarm(samples)).toMatchObject({ p50: 50, p95: 95, p99: 99 });
expect(() => summarizeWarm([])).toThrow();
```

- [ ] Write failing tests for 1..100 samples (p50=50, p95=95, p99=99), empty/
  negative/non-finite samples, invalid-record exclusion, lifecycle sample
  labels, smoke warnings, and no leakage of root paths or secrets.
- [ ] Run `npx vitest run tests/unit/benchmarks/performance/report.test.ts`;
  expect FAIL.
- [ ] Implement timing/resource units, CPU deltas, numeric heap readings,
  lifetime worker peak RSS including setup, and settled index artifact bytes
  outside timers. External ripgrep CPU/RSS and process-tree totals are
  `not_collected`, never zero; observed child wall time is not CPU.
- [ ] Record revision/dirty flag, recipe digest, Node/OS/CPU/memory/rg version,
  cache/provider work, limits, sample mode, endpoints, and bounded diagnostics.
  Include configured deadlines/page/memory limits as execution metadata.
- [ ] Serialize paths only from the validated logical projection. Test raw
  absolute paths in grep matches, Hybrid chunk IDs, and error messages: none
  may survive in success/invalid reports or intermediate JSON. Invalid path
  records contain codes/counts, not the rejected string. Preserve normalized
  duplicate counts rather than overwriting a report-map entry on key collision.
- [ ] Rerun tests; require PASS and a report round-trip through schema v1.

### Task 10: Serial isolated runner with JSON-only stdout

**Files:** Create `scripts/run-performance.mjs`,
`vitest.performance.config.ts`,
`tests/benchmarks/performance/{runtime.perf,worker}.ts`, and
`tests/integration/performance/runner.test.ts`; modify `package.json` and
`tsconfig.json`.

**Interfaces:** `test:perf` runs `node scripts/run-performance.mjs`.
CLI accepts `--profile smoke|small|medium|large`, optional `--output <file>`,
`--timeout-ms <positive integer>`, and `--memory-limit-mb <positive integer>`.
Defaults: profile small; deadlines smoke/small 120,000 ms, medium 600,000 ms,
large 1,800,000 ms per scenario; 2,048 MiB Node heap ceiling. Report overrides.
The wall deadline starts before fixture/cache setup; it is not reset at t0.
The same worker heap ceiling covers preparation, indexing, retrieval and audit.
Retain `setup_ms`/`cache_seed_ms` and seeding validation/resource diagnostics
separately from runtime-ready and handler samples.

- [ ] Write failing subprocess tests for malformed options, worker stdout/stderr
  noise, invalid intermediate report, timeout, killed worker, runtime failure,
  unwritable output, paths with spaces, and cleanup after failure.
  Include failure during cache batch 2 and setup deadline expiry before t0;
  require invalid `phase: setup`, no warm timing, and no partial target reuse.
  Parse success/invalid JSON and assert temporary absolute paths and raw
  grep/Hybrid absolute IDs are absent; worker logs cannot bypass redaction.
- [ ] Run `npx vitest run tests/integration/performance/runner.test.ts`;
  expect FAIL.
- [ ] Implement parent spawning one Vitest worker process per independent
  scenario/repetition, with temporary JSON result files. Pipe both child output
  streams to sanitized diagnostic stderr, never report stdout. Workers write
  validated result files atomically. Use a final aggregation-mode Vitest worker
  to parse all intermediate records against Task 1 schemas and call Task 9's
  `buildReport()`. The parent verifies successful exit and the final JSON
  envelope before emitting the schema-validated file contents. Do not import
  TypeScript modules directly from the `.mjs` parent or duplicate Zod schemas.
  Preserve a transport envelope with requested job ID, exit/timeout status,
  and intermediate-file location for every job. The aggregation worker turns
  missing/truncated failed-job files into invalid scenario records; it must
  not omit required cases or publish a partial run as a complete baseline.
- [ ] Launch the installed Vitest CLI with `process.execPath`, resolving its
  entry using `import.meta.resolve('vitest/vitest.mjs')`. Pass `run`,
  `--config vitest.performance.config.ts`, and `--reporter=dot`. Use a private
  `NEXUS_PERF_REQUEST_FILE` worker environment value naming a parent-created
  request JSON with mode, options, and result file; validate it in `worker.ts`.
  Only `.perf.ts` reads this value; it does not enable test providers in normal
  Nexus. Resolve repository-relative entries from the script URL, not caller cwd.
- [ ] Parent emits exactly one JSON document on stdout without `--output`;
  with `--output` write only the explicit report destination and leave stdout
  empty. Execution errors still produce an invalid report and nonzero exit
  where output is writable. Diagnostics are stderr only.
- [ ] Enforce deadlines through abort then child termination with a 5-second
  grace period; reap child process groups on supported platforms and verify
  no ripgrep descendants remain. OS spawn/cleanup limitations fail explicitly.
- [ ] Configure only `.perf.ts`, no inherited normal/E2E includes, no coverage,
  no benchmark discovery, no file parallelism. Include the new root config in
  `tsconfig.json`; ordinary `.test.ts` contracts remain regular tests.
- [ ] Rerun subprocess tests. Parse stdout from both direct Node invocation and
  `npm run --silent test:perf -- --profile smoke`. Document that npm's default
  lifecycle banners require `--silent` for machine-readable stdout; do not
  falsely promise JSON-only output from unsilenced npm itself.

### Task 11: CI smoke, discovery isolation, and production regression gates

**Files:** Modify `.github/workflows/ci.yml`, `package.json`; create
`tests/unit/benchmarks/performance/discovery.test.ts`;
update `docs/observability/README.md` metric inventory/link.

- [ ] Write discovery assertions using the four real configurations: normal,
  `NEXUS_E2E=1`, microbench, and perf. Require `.perf.ts` to appear only in perf
  with E2E environment set or unset, and `*.bench.ts` only in microbench.
- [ ] Run `npx vitest run
  tests/unit/benchmarks/performance/discovery.test.ts`; require failure before
  missing isolation/configuration is implemented and PASS afterward.
- [ ] Add `lint:perf` covering new benchmark/test/config TypeScript and lint the
  parent `.mjs` with an explicit supported ESLint scope. Keep existing lint.
  Avoid shell glob patterns that silently miss newly split helper files.
- [ ] After existing build prerequisites, CI invokes
  `npm run --silent test:perf -- --profile smoke --output reports/performance-smoke.json`.
  Ensure output parent creation is explicit in the runner. Upload artifact with
  `if: always()` and missing artifact treated as an error; no latency threshold
  gates on shared CI. Smoke status/partial errors must remain visible.
- [ ] Run focused perf contracts/integration plus `npx tsc --noEmit -p tsconfig.json`,
  `npm run lint`, `npm run lint:perf`, `npm run build`, and the repository's
  `npm test`/`npm run test:e2e` gates. Require actual successful outputs.
  Existing package/provider, transport, factory, shutdown, and grep tests
  must pass; do not replace production regressions with benchmark mocks.
- [ ] Run the small smoke command and inspect generated artifact for new
  labels, missing cases, stdout pollution, absolute paths, and credentials.

### Task 12: Obtain actual scale baselines and finish operator documentation

**Files:** Create `docs/observability/performance-benchmarks.md` and
`docs/observability/benchmarks/{small,medium,large}.json`; update the existing
observability README link if not already done. Keep the approved R3 spec fixed.

- [ ] Document metric reuse/new cache counter, exact invocation, boundaries,
  fixture/provider identity, uncapped grep, external CPU limitations, synthetic
  interpretation, readiness/audit separation, and #298/#320/#297 exclusions.
- [ ] On an otherwise idle compatible host, run sequentially:
  `npm run --silent test:perf -- --profile small --output docs/observability/benchmarks/small.json`,
  then corresponding medium and large commands. Require three lifecycle runs,
  100 warm samples per case, full manifest audits and Git scenario evidence.
- [ ] Measure each large audit's wall duration and worker peak RSS. Require the
  entire 10,000-file/100,000-declaration fixture to pass within the recorded
  30-minute per-scenario deadline and 2,048 MiB Node heap ceiling. The heap
  limit is not a whole-process RSS guarantee: record actual native/process RSS
  and any host-imposed memory cap separately. Do not omit parts of the audit
  to meet the deadline. If resource-limited, report incomplete evidence and
  rerun only on an explicitly documented suitable environment.
  Include L2 preparation: record total keys, batches, maximum 512-key API
  input size, exact verified-key equality, cache-seed duration and worker RSS/
  heap observations. The 30-minute scenario deadline includes preparation;
  no full-key vector hydration is permitted even if the run fits in memory.
  Transfer/verification/resource failure makes the baseline incomplete.
- [ ] For the two-run #301/regression signals, repeat the compared full profile
  on the same host/config to temporary output; keep both run IDs/results when
  making that conclusion. A single baseline pass cannot establish repeatability.
- [ ] Write a measured summary table and interpretation in the operator guide,
  linking raw reports. Apply #301 p95 >100 ms, #300 repeated-input >=80% with
  indexing >=50% of `runtime_ready_ms`, and regression >20% plus >=5 ms rules
  exactly as R3; do not assert thresholds fired without corresponding evidence.
- [ ] Run the locked local Prettier without installing packages:

  ```bash
  node node_modules/prettier/bin/prettier.cjs --check \
    docs/observability/performance-benchmarks.md \
    docs/observability/README.md
  ```

  Require exit 0 and all target files formatted; fix only the touched documents
  and rerun if necessary. This checks Markdown parsing/formatting, not semantic
  link validity or markdownlint rule coverage. Verify local links and the
  repository's Markdown standards separately during document review.
  If the local binary is missing, report the prerequisite failure and follow
  Task 0's existing setup choice; do not use an npx download or global fallback
  to claim the locked Prettier gate passed.
- [ ] If markdownlint-cli2 is already provisioned, additionally run

  ```bash
  npx --no-install markdownlint-cli2 \
    docs/observability/performance-benchmarks.md \
    docs/observability/README.md
  ```

  This is a supplemental check, not a new repository dependency or a reason to
  install anything silently. Record its version/result or unavailability;
  never claim a Prettier pass is a markdownlint pass. Prettier is already in
  `package-lock.json`; no Markdown-specific npm script/dependency is assumed.
- [ ] Require JSON schema validation at Task 10's aggregation boundary, report
  redaction checks, and `git diff --check` before handing off artifacts.
  Mark unavailable/dependency-blocked cases explicitly;
  incomplete full profiles mean issue #299 baseline acceptance is not complete.
- [ ] Provide the user with changed files, actual tests/commands, measured
  results, remaining limitations, and a requirement-to-evidence checklist.
  Do not close the issue, submit a PR, or commit without separate authorization.

## Requirement-to-task and evidence map

| Requirement | Tasks | Required evidence |
| --- | --- | --- |
| #305-compatible base | 0, 5 | Ancestry, identity E2E and A/A/B tests |
| Existing metrics first | 5, 11, 12 | Inventory and bounded counter test |
| Fixture scale/digest | 1, 2 | Generator tests and all report metadata |
| Production handler/runtime | 3, 4, 8 | Regression and object-identity tests |
| Swallowed/partial failure | 4, 7, 8 | Fault injection, invalid exclusion |
| Physical full audits | 1, 6, 12 | Per-table tests and large completed audit |
| Cache/resource attribution | 5, 9 | Mixed-batch tests, explicit CPU scopes |
| Cold/warm/increment/worktree | 7, 12 | Actual lifecycle records and cleanup |
| Retrieval distributions | 8, 9, 12 | Raw 100 samples, quantile tests |
| Ready versus audit | 7, 9 | Controlled-clock tests and separate times |
| Test isolation/types | 10, 11 | Discovery tests and root tsc gate |
| Machine-readable stdout | 10, 11 | Noisy subprocess JSON parse tests |
| CI smoke only | 11 | Full required-case smoke artifact |
| Baseline/optimization signals | 12 | Three scale reports and real summary |

## Plan review and execution handoff

### Implementation-plan correction map

Independent reviews resolved the first five items in plan R2 and the final
three corrections in plan R3. None is a claim of implementation or runtime PASS:

- **PLAN-299-001:** Shared response-path contract; Tasks 1/8 validate canonical
  root-relative identities after timing, including grep and Hybrid; Tasks 9/10
  serialize only safe logical projections and retain multiset multiplicities.
- **PLAN-299-002:** Task 7 specifies deterministic 512-key L2 copy/readback,
  exact final key equality and failure cleanup; Tasks 10/12 enforce setup
  deadlines/heap ceilings and require large-profile resource evidence.
- **PLAN-299-003:** Task 3 pins both factory exports and root public routes,
  retains `assertPackageModeConstraints`, and compares pre/post export sets.
- **PLAN-299-004:** Global constraints and Task 7 restrict fixture commits to
  benchmark-owned temporary repositories, with explicit ownership/top-level
  guards; no user-repository commit authorization is inferred.
- **PLAN-299-005:** Task 12 provides local no-install Prettier commands and
  distinguishes formatting from Markdown rule review; preinstalled markdownlint
  is supplemental and no new dependency is introduced.
- **PLAN-R2-NEW-001:** Tasks 4/8 retain request-scoped complete pre-fusion grep
  evidence, validate its hashed multiset after handler timing, and test 125
  matches versus a final topK of 20, including hidden-tail corruption.
- **PLAN-R2-NEW-002:** Tasks 3/7 accept a lazy runtime factory and timestamp
  before invoking it. Startup and existing-runtime operation signatures are
  separate; a controlled clock proves construction is included in readiness.
- **PLAN-R2-NEW-003:** Task 7 checks temporary ownership/non-repository state
  before init, then verifies the actual Git top level before add/commit/worktree.

The tasks cover the approved R3 and its review handoff conditions. Writing this
plan does not authorize implementation or substitute for the base/runtime/CI
checks. Obtain explicit execution authorization before starting Task 0.
The agreed workflow is single-implementer sequential execution with the
mandatory independent review gates after Tasks 3, 6, 10, and 12 above. Preserve
the dependency order and do not bypass a pending review gate.
