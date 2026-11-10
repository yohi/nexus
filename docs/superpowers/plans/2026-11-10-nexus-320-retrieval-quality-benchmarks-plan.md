# Nexus #320 — Retrieval Correctness and Agent-loop Quality Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL (only after an explicit implementation authorization): use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to execute the approved tasks. Checkboxes track steps; **this plan does not authorize their execution**. No automatic subagent/reviewer dispatch, repeat review, GitHub write, PR, merge, host change, or successor task.

**Revision:** R0.1 — DOCUMENT_ONLY / planning artifact  
**Date:** 2026-11-10 (JST)  
**Repository / Issue:** `yohi/nexus` / https://github.com/yohi/nexus/issues/320  
**Reference master at planning:** `bbb2928baa1f9117ec0fb8ee523f03bc9ddaf0d7` (reconfirm when implementation is separately approved)  
**Goal:** Demonstrate whether Nexus's retrieval yields correct current source and safer failure behavior while reducing the *actual agent exploration burden* relative to direct `ripgrep + file read`, without conflating those properties with raw performance.

**Architecture:** Keep the benchmark as test-only infrastructure under `tests/benchmarks/quality/` and `tests/integration/quality/`. Reuse #299's owned temporary workspaces, deterministic recipes, hashing, runtime assembly and real Tool Handlers, but introduce **separate versioned Oracle, Policy, Trace and Quality Report contracts**. A two-arm paired runner uses the same public task inputs and source snapshot, then scores the adopted result with an Oracle that no Policy/Adapter can read.

**Tech Stack:** Node.js >=24, TypeScript 5.9.x, Vitest 3.2.x, Zod 4.6.x, Node built-ins (`fs`, `crypto`, `child_process`), `js-tiktoken` 1.0.21, existing `buildToolHandlers` and #299 fixtures. No new runtime dependency or paid model/API requirement.

**Spec:** Nexus #320 *Retrieval Correctness and Agent-loop Quality Benchmark Design R0.1* (2026-11-10, Human Owner approved in this conversation). **The Design is an in-chat input and is not represented as a committed repository file**. If later committed, set the exact corresponding `docs/superpowers/specs/...` path in this field by a limited document edit; do not invent a repository reference.

**Authority:** Design adopted; creation of this Plan R0.1 authorized. **Implementation, fixture generation, benchmark/test execution, LSP executable approval, GitHub edits, commit/push and PR are NOT AUTHORIZED by this document**.

## Global Constraints

- Three separate assessment gates: **Gate 1 safety/current-source**, **Gate 2 discovery**, **Gate 3 agent-loop value**. Gate 1 is necessary, not sufficient, for a superiority claim.
- Outcome classes: `CORRECT_CURRENT`, `CORRECT_REFUSAL`, `FALSE_REFUSAL`, `FALSE_FRESH`, `WRONG_SOURCE`, `MISSING`, `UNAVAILABLE`, `INCONCLUSIVE`; record `NOT_RUN` separately as an *execution status*, not an observed tool outcome.
- **Initial deterministic core set:** Q01–Q11 and Q14 with test-only LSP-not-configured response. Q07/Q08 are required **only when their setup gates provably establish the intended stale/race condition**; a failed setup marks the core evaluation `INCOMPLETE`, never PASS. Q12 is an independently labeled Worktree extension (depends on demonstrated #297 runtime acceptance, not merely a Closed label). Q13 is a separately labeled LSP extension with stub evidence; real-server evidence requires explicit Owner approval. These scopes are frozen as `quality-core-v1` / `quality-worktree-v1` / `quality-lsp-v1` before any measured comparison. Full #320 Issue acceptance must reflect the extension evidence; a core result is not a full project-wide safety certification.
- **Budget v1:** max **12 logical operations**, **20 inspected candidates**, **65,536 context bytes**, **2 retries per identical operation**. Counts and limits apply to *both* arms; attempted calls, errors, status checks and fallbacks are charged. Context tokens use pinned `js-tiktoken` 1.0.21, `cl100k_base`, and are estimates, not billed model tokens.
- **Policy v1:** `INITIAL → DISCOVER → RANK → READ → VERIFY → FALLBACK → COMPLETE/EXHAUSTED`. The policy sees only `taskDescription`, `initialClues`, *public* tool results and its own trace. It **must not import/receive the Golden Oracle**.
- **Frozen fallback mapping:** `stale`/`stale_identity`/explicit refusal → bounded fresh `grep` or file read; empty `ok` and insufficient candidates → next already declared discovery step; `unsupported`/`unavailable`/`excluded`/`not_indexed`/`index_incomplete`/`degraded` → permitted alternative, never fabricate an answer; malformed/error/timeout → bounded retry then fallback; budget exceeded → `EXHAUSTED`. Never silently convert `unavailable` into `not_found`, or a correct refusal into a successful retrieval. Do not retry identical failing operations more than 2 times.
- **Fair pairing:** each task receives identical visible clues, logical source snapshot and pre-index setup; only the available retrieval tools differ. Freeze arm order before evaluation (e.g. alternate `R→N` / `N→R` by sorted task index); reset the owned workspace, index/runtime and any mutable fixture state between arms. No post-result policy tuning; change `policyVersion` for any rule/budget change.
- Baseline R is `rg` + bounded direct source read. Nexus N uses existing handlers (`grep_search`, `semantic_search`, `hybrid_search`, `get_context`, structured and opt-in LSP tools); do not pretend baseline has LSP/structured tools. Report both *tool invocation count* and *logical operation count* so command batching does not distort conclusions.
- Oracle uses committed/generated **fixture source bytes + specified mutations + independent filesystem reads**; current-worktree correctness must not be derived from Nexus/Catalog/retrieval output. Keep request-start snapshot and response-publication snapshot distinct.
- Synthetic SHA-256 embeddings support deterministic execution checks only, **not** claims of natural-language semantic relevance; semantic quality status remains `NOT_ESTABLISHED` until a pinned independent real-model corpus/snapshot is explicitly authorized and available.
- Do not reuse or modify #299's `retrieval-performance-v1` FixtureManifest/Report Schema to store #320 results. Reuse generators/helpers and attach a separate quality manifest/report; never rerun #299's scale/R5 diagnostics as part of #320.
- Worktree/Storage must be owned ephemeral test inputs. Do not touch developer/user repositories, existing `.nexus` state, or create/approve/trust an LSP executable. Never commit generated Oracle containing absolute host paths or sensitive data.
- A finite suite with zero observed False-fresh means `SAFETY_PASS` **for its executed scope only**. Any observed False-fresh or wrong source adopted as verified-current means `SAFETY_FAIL`. Missing required cases, missing Oracle, or failed setup gate means `INCOMPLETE`.

## Review Focus (capture each as a task-owned regression test; not a mandate for repeated review)

1. **Oracle leakage:** a Policy/Adapter attempting to read `expectedSourceHashes` or grader-only data is rejected (Task 1/4).
2. **Path escapes and symlink aliases:** a returned path outside the canonical test root can never be scored as current (Task 2/3).
3. **Mutation race:** a response correct at request start but stale at publication is not silently classified fresh (Task 2/5).
4. **Refusal semantics:** `ok: []`, `stale`, `unsupported`, `unavailable`, `not_found`, malformed `isError` and setup-NOT_RUN have distinct results (Task 3/5).
5. **Selective reporting / unfair budgets:** failed or missing paired tasks stay in denominators; over-budget calls, batched shell operations and arm order remain visible (Task 4/7).

## File map (proposed, not yet created)

| Responsibility | Proposed file | Change type |
|---|---|---|
| Frozen contracts, budgets, schema versions | `tests/benchmarks/quality/contracts.ts` | Create |
| Visible task projection and immutable private Oracle | `tests/benchmarks/quality/manifest.ts`, `oracle.ts` | Create |
| Owned fixture generation and mutation setup | `tests/benchmarks/quality/fixtures.ts` | Create; import #299 helpers |
| Restricted invocation / normalized observations | `tests/benchmarks/quality/adapters.ts` | Create; import `buildToolHandlers`, use Node `rg` |
| Deterministic candidate ranking and state transitions | `tests/benchmarks/quality/policy.ts` | Create |
| Independent grader and Gate 1/2/3 metrics | `tests/benchmarks/quality/scoring.ts` | Create |
| Paired execution, isolation, trace and result assembly | `tests/benchmarks/quality/runner.ts` | Create |
| Read-only quality report schema/formatter | `tests/benchmarks/quality/report.ts` | Create |
| Core, worktree and opt-in LSP integration cases | `tests/integration/quality/*.test.ts` | Create |
| Pure unit tests | `tests/unit/benchmarks/quality/*.test.ts` | Create |
| Test method/limitations and reproducible command | `docs/observability/retrieval-quality-benchmarks.md` | Create |

**Do not modify** production retrieval code, `src/server/runtime-assembly.ts`, #299's performance runner/report/schema, `SPEC.md`, or performance diagnostics as part of this plan. If an actual product defect is observed, record it with minimal reproduction and stop that unsafe product path; let the Human Owner authorize a separate scoped fix.

---

### Task 1: Versioned Quality Contracts and Private/Visible Input Separation

**Files:** Create `tests/benchmarks/quality/contracts.ts`, `manifest.ts`; Test `tests/unit/benchmarks/quality/contracts.test.ts`.

**Interfaces:**

```ts
export type QualityArm = 'R' | 'N';
export type QualityProfile = 'quality-core-v1' | 'quality-worktree-v1' | 'quality-lsp-v1';
export type ObservationKind = 'CORRECT_CURRENT' | 'CORRECT_REFUSAL' | 'FALSE_REFUSAL' |
  'FALSE_FRESH' | 'WRONG_SOURCE' | 'MISSING' | 'UNAVAILABLE' | 'INCONCLUSIVE';
export interface PublicQualityTask { readonly taskId: string; readonly scenarioId: string;
  readonly taskDescription: string; readonly initialClues: readonly string[]; }
export interface QualityBudgets { readonly maxLogicalOperations: 12;
  readonly maxCandidates: 20; readonly maxContextBytes: 65536; readonly maxRetries: 2; }
export interface QualityCaseManifest extends PublicQualityTask {
  readonly fixtureId: string; readonly sourceSnapshotDigest: string;
  readonly mutationSchedule: readonly { phase: 'before_request' | 'during_request' | 'before_publication';
    operation: string; target: string }[];
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly { filePath: string; name: string; startByte: number; endByte: number }[];
  readonly expectedSourceHashes: Readonly<Record<string, string>>;
  readonly expectedLocations: readonly { filePath: string; line: number; character: number }[];
  readonly expectedRefusalConditions: readonly string[];
  readonly evaluationEligibility: 'required_core' | 'conditional_worktree' | 'conditional_lsp';
}
export function publicTask(manifest: QualityCaseManifest): PublicQualityTask;
export function validateQualityCase(input: unknown): QualityCaseManifest;
```

`QualityCaseManifest` includes grader-only `fixtureId`, `sourceSnapshotDigest`, `mutationSchedule`, `expectedFiles`, `expectedSymbols`, `expectedSourceHashes`, `expectedLocations`, `expectedRefusalConditions`, `evaluationEligibility`. Embed the Design's `Q01`–`Q14` IDs; classify missing required vs conditional scope explicitly. Export an immutable `QUALITY_BUDGETS_V1` and `policyVersion: 'quality-policy-v1'`. Keep full manifest and `publicTask()` in different modules; adapters/policy must depend on `PublicQualityTask`, never on `QualityCaseManifest`.

- [ ] **Step 1 — RED:** Test `publicTask()` contains exactly `taskId`, `scenarioId`, `taskDescription`, `initialClues` and no `expected*`, `sourceSnapshotDigest` or `mutationSchedule`; invalid negative budgets, duplicate task IDs, unversioned/unrecognized scenarios are rejected; `Q07/Q08` have explicit setup eligibility.
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/unit/benchmarks/quality/contracts.test.ts --coverage.enabled=false` → expected FAIL because the contract module does not exist.
- [ ] **Step 3 — Implement:** Zod strict, readonly contract schema; `publicTask()` creates a fresh frozen projection and rejects unexpected fields. Define machine-readable execution statuses separately from outcomes (`executed`, `not_run`, `setup_incomplete`, `blocked`).
- [ ] **Step 4 — Verify GREEN:** Same test command → expected PASS; `npx tsc -p tsconfig.json --noEmit` → PASS.
- [ ] **Step 5 — Commit only after separately authorized implementation:** `git add tests/benchmarks/quality/contracts.ts tests/benchmarks/quality/manifest.ts tests/unit/benchmarks/quality/contracts.test.ts && git commit -m "test(nexus): define versioned retrieval quality contracts"`.

**Done:** Contracts cannot leak Golden data through the Policy API, cannot treat NOT_RUN as a tool outcome, and cannot change budgets without a version change.

### Task 2: Owned Fixtures, Mutation Snapshots, Independent Source Oracle

**Files:** Create `tests/benchmarks/quality/fixtures.ts`, `oracle.ts`; Test `tests/unit/benchmarks/quality/oracle.test.ts` and `tests/integration/quality/fixtures.test.ts`.

**Interfaces:**

```ts
export interface SourceSnapshot { readonly snapshotDigest: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly sourceBytes: Readonly<Record<string, Uint8Array>>; }
export interface SourceAdoption { readonly filePath: string;
  readonly startByte: number; readonly endByte: number;
  readonly content: string; readonly sourceValidation: 'verified' | 'partial' | 'unknown'; }
export interface OwnedQualityFixture {
  readonly root: string; readonly publicTasks: readonly PublicQualityTask[];
  readonly oracleCases: readonly QualityCaseManifest[];
  readonly dispose: () => Promise<void>;
}
export async function createQualityFixture(scenarioIds: readonly string[], signal: AbortSignal): Promise<OwnedQualityFixture>;
export async function applyQualityMutation(fixture: OwnedQualityFixture, taskId: string,
  phase: 'before_request' | 'during_request' | 'before_publication'): Promise<void>;
export async function captureOracleSnapshot(root: string, taskId: string): Promise<SourceSnapshot>;
export function scoreAdoptedSource(snapshot: SourceSnapshot, adoption: SourceAdoption): ObservationKind;
```

Use #299's `createOwnedGitWorkspace()`, `createRecipe()`, `sha256()` and `generateFixture()` only where they match the quality task. Extend fixture-owned TS/JS files for same-name, cross-file move/rename, deleted/recreated file and large declaration; add mixed-language cases independent of #299's monotonically named synthetic declarations. **Do not call `createSiblingGitFixture()` as a Primary + Linked fixture**; it creates two detached linked worktrees, and Task 6 owns the actual Primary + Linked wrapper. Normalize returned physical paths against canonical root via #299 `createFixturePathNormalizer()` when its *fixed-manifest* preconditions hold; use a fresh snapshot-aware normalizer when a case deliberately mutates/deletes a manifest file.

- [ ] **Step 1 — RED:** Test independent SHA-256 against actual `fs.readFile()` bytes, UTF-8 source slice/hash, snapshot before/after deletion/recreation, symlink escape rejection, same-named symbol in two scopes and impossible setup gate returning `setup_incomplete` (not safety PASS).
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/unit/benchmarks/quality/oracle.test.ts tests/integration/quality/fixtures.test.ts --coverage.enabled=false` → expected FAIL for missing quality fixture/Oracle.
- [ ] **Step 3 — Implement:** Build disposable owned roots, store independent fixed Oracle inputs, capture request-start and publication-time snapshots, and preserve mutation operations deterministically. Oracle reading occurs **only in runner scoring after Policy has terminated**; do not pass a source hash to tool inputs.
- [ ] **Step 4 — Verify GREEN:** Same tests → expected PASS; disposal removes owned fixture directories only.
- [ ] **Step 5 — Authorized commit:** `git add tests/benchmarks/quality/fixtures.ts tests/benchmarks/quality/oracle.ts tests/unit/benchmarks/quality/oracle.test.ts tests/integration/quality/fixtures.test.ts && git commit -m "test(nexus): add independent quality oracle and owned fixtures"`.

**Done:** Fixed Oracle is independent of retrieval response and correctly distinguishes a stale publication-time source from request-time correctness; fixture cleanup cannot touch real repositories.

### Task 3: Baseline R / Nexus N Tool Adapters and Comparable Trace Costs

**Files:** Create `tests/benchmarks/quality/adapters.ts`; Test `tests/unit/benchmarks/quality/adapters.test.ts`.

**Interfaces:**

```ts
export interface PublicCandidate { readonly filePath: string; readonly symbolId?: string;
  readonly rank: number; readonly line?: number; readonly preview?: string; }
export type QualityTool = 'rg_search' | 'read_file' |
  'grep_search' | 'semantic_search' | 'hybrid_search' | 'get_context' |
  'get_file_outline' | 'get_symbol_source' | 'get_symbol_context' |
  'get_definition' | 'get_references' | 'get_implementations' | 'index_status';
export interface QualityObservation { readonly status: 'ok' | 'not_found' | 'stale' |
  'stale_identity' | 'index_incomplete' | 'not_indexed' | 'degraded' |
  'excluded' | 'unsupported' | 'unavailable' | 'timeout' | 'cancelled' | 'error';
  readonly results: readonly PublicCandidate[]; readonly exposedBytes: number;
  readonly sourceAdoptions: readonly SourceAdoption[]; readonly rawDigest: string;
  readonly reasonCode?: string; }
export interface QualityAdapter { readonly arm: QualityArm;
  invoke(tool: QualityTool, args: Readonly<Record<string, unknown>>,
    signal: AbortSignal): Promise<QualityObservation>; }
export function createRipgrepAdapter(root: string, rgExecutable: string): QualityAdapter;
export function createNexusAdapter(handlers: ReturnType<typeof buildToolHandlers>): QualityAdapter;
```

`PublicCandidate` contains only normalized file/symbol identity, rank, preview and offsets that are actually returned; no Oracle label. Baseline uses a pinned explicit `rg` invocation from its versioned run metadata, with current-source reads bounded by canonical root; do not write a fake baseline LSP/Structured implementation. Nexus calls real `buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime))` but **does not reuse #299's performance `runRetrievalCase()` loop**: that method warms/repeats samples and validates against performance expectations, which changes agent-loop costs. Use one call per Policy action and record the actual exposed JSON/text. Translate `isError` and structured statuses preserving `stale`, `not_found`, `unavailable`, and `ok`+empty results; reject malformed envelopes without scoring them fresh.

- [ ] **Step 1 — RED:** Tests for real `rg` version/flags/path boundaries, sorted deterministic tie-breaking, no symlink escape, `rg` zero matches ≠ unavailable, Nexus `unavailable/LSP_NOT_CONFIGURED` ≠ empty successful LSP, malformed envelope `isError`, error and timeout accounting; assert `index_status` is charged when used.
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/unit/benchmarks/quality/adapters.test.ts --coverage.enabled=false` → expected FAIL for missing adapter.
- [ ] **Step 3 — Implement:** One-operation adapters, output normalization and digest; log each Tool invocation separately from logical-operation cost. Publish the exact `rg` flags/glob/exclusion contract in report metadata. **Do not enable `reindex` as a Policy tool** (benchmark setup controls indexing).
- [ ] **Step 4 — Verify GREEN:** Same test command → expected PASS; `npx tsc -p tsconfig.json --noEmit` → PASS.
- [ ] **Step 5 — Authorized commit:** `git add tests/benchmarks/quality/adapters.ts tests/unit/benchmarks/quality/adapters.test.ts && git commit -m "test(nexus): add paired quality tool adapters"`.

**Done:** R and N expose comparable public evidence; neither adapter guesses missing sources or embeds hidden Oracle expectations.

### Task 4: Deterministic Policy, Fallback Mapping, Hard Budget and Arm Order

**Files:** Create `tests/benchmarks/quality/policy.ts`; Test `tests/unit/benchmarks/quality/policy.test.ts`.

**Interfaces:**

```ts
export interface QualityTraceEvent { readonly sequence: number; readonly state: string;
  readonly tool: QualityTool; readonly argsDigest: string; readonly resultDigest: string;
  readonly exposedBytes: number; readonly logicalOperations: number;
  readonly invocationCount: number; readonly retries: number; readonly fallback: boolean; }
export interface QualityPolicyResult { readonly status: 'COMPLETE' | 'EXHAUSTED';
  readonly adoption?: SourceAdoption; readonly trace: readonly QualityTraceEvent[];
  readonly logicalOperations: number; readonly invocations: number;
  readonly contextBytes: number; readonly contextTokens: number; }
export async function runQualityPolicy(task: PublicQualityTask, adapter: QualityAdapter,
  limits: QualityBudgets, signal: AbortSignal): Promise<QualityPolicyResult>;
export function qualityArmOrder(sortedTaskIndex: number): readonly [QualityArm, QualityArm];
```

Use public clue grammar (exact identifier / file clue / conceptual clue) that is frozen in the manifest, not oracle-based decisions. E.g. exact identifier → grep; conceptual clue → semantic/hybrid on N and best-effort text clue on R; known file → bounded `get_context` or direct read. In `RANK`, use documented stable order (`public score desc`, logical normalized path ascending, position ascending) and deduplicate chunk-to-symbol candidates without altering raw retrieval evidence. `VERIFY` may inspect public source snippets, not expected hashes. Any full-loop success claim is made **only later by the Oracle**.

- [ ] **Step 1 — RED:** Test exactly 12 logical operations allowed / 13th rejected; 20 vs 21 inspected candidates; 65536 vs 65537 exposed context bytes; retries 0/1/2 vs 3; status-check/error/retry charged; `ok: []`, `stale`, `unsupported`, `unavailable`, error all select frozen fallback; Oracle fields inaccessible; batched `rg` cannot masquerade as one logical operation for many file reads; arm order even index R→N, odd N→R.
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/unit/benchmarks/quality/policy.test.ts --coverage.enabled=false` → expected FAIL for missing Policy.
- [ ] **Step 3 — Implement:** Finite state machine; budget errors terminate with `EXHAUSTED`, no unbounded retries or mutable policy rules. Count actual tool-visible data using byte lengths of exposed observations; tokenize with `getEncoding('cl100k_base')` from the pinned tokenizer.
- [ ] **Step 4 — Verify GREEN:** Same test command → expected PASS; `npx tsc -p tsconfig.json --noEmit` → PASS.
- [ ] **Step 5 — Authorized commit:** `git add tests/benchmarks/quality/policy.ts tests/unit/benchmarks/quality/policy.test.ts && git commit -m "test(nexus): add deterministic agent-loop exploration policy"`.

**Done:** The same fixed policy and cost budget can execute against both available tool sets, with no post-hoc adaptation to Oracle correctness.

### Task 5: Initial Safety Scenarios and Executable Paired Core Runner

**Files:** Create `tests/benchmarks/quality/runner.ts`; Test `tests/integration/quality/core.test.ts` and `tests/unit/benchmarks/quality/scoring.test.ts`; create `tests/benchmarks/quality/scoring.ts`.

**Interfaces:**

```ts
export interface QualityArmResult { readonly executionStatus: 'executed' | 'not_run' | 'setup_incomplete' | 'blocked';
  readonly observation: ObservationKind | null; readonly policy: QualityPolicyResult | null;
  readonly correctSourceReached: boolean; readonly wrongSourceAdopted: boolean;
  readonly reasonCode?: string; }
export interface PairedQualityResult { readonly taskId: string; readonly profile: QualityProfile;
  readonly fixtureDigest: string; readonly policyVersion: 'quality-policy-v1';
  readonly outcomes: Readonly<Record<QualityArm, QualityArmResult>>; }
export async function runQualityPair(task: QualityCaseManifest, fixture: OwnedQualityFixture,
  options: Readonly<{ signal: AbortSignal; rgExecutable: string }>): Promise<PairedQualityResult>;
export function gradeQualityArm(task: QualityCaseManifest, snapshot: SourceSnapshot,
  result: QualityPolicyResult): QualityArmResult;
```

Core Q01–Q11 + Q14, each separately reportable: Q01 indexed; Q02 dirty; Q03 rename; Q04 move; Q05 deleted/retired identity; Q06 file delete/recreate; Q07 stale vectors; Q08 generation race; Q09 parser coverage/unsupported; Q10 duplicate symbol names; Q11 large declaration/chunk; Q14 LSP not configured (no executable). Select **at least one independently graded exact/structured tool route** and one full-loop route per applicable scenario. Use synthetic embeddings only for route wiring and safe-stale handling, never as semantic relevance evidence. For Q07/Q08, assert the intended stale/index-generation/race setup is actually active **before** invoking any arm; an unproven setup produces `setup_incomplete` + Gate 1 INCOMPLETE, not an invented safety failure or success.

- [ ] **Step 1 — RED:** Tests that `FALSE_FRESH` and verified-as-current `WRONG_SOURCE` set `SAFETY_FAIL`; wrong refusal increments `FALSE_REFUSAL`; `CORRECT_REFUSAL` does not count as source discovery; missing required Q01 marks Gate 1 INCOMPLETE; Q07/Q08 setup mismatch marks `setup_incomplete`; Q06 post-publication stale source fails even if request-start matched; real Nexus response and `rg` outcomes are both graded against one fixed Oracle.
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/unit/benchmarks/quality/scoring.test.ts tests/integration/quality/core.test.ts --coverage.enabled=false` → expected FAIL for missing runner/grader.
- [ ] **Step 3 — Implement:** For each arm, create/reset owned files and fresh local runtime/index to the **same** recipe/snapshot; finish complete observation before switching arm. Reuse `createBenchmarkRuntimeFactory()` only for synthetic, LSP-off core; initialize/close via `RuntimeAssembly.runtime` and the existing handlers. Score after Policy termination; keep every failed/incomplete attempt. Stop unsafe pathways if source adoption violates Gate 1; do not re-run or auto-fix production code.
- [ ] **Step 4 — Verify GREEN:** Same tests → expected PASS. No User Worktree writes; no #299 runner re-execution.
- [ ] **Step 5 — Authorized commit:** `git add tests/benchmarks/quality/runner.ts tests/benchmarks/quality/scoring.ts tests/integration/quality/core.test.ts tests/unit/benchmarks/quality/scoring.test.ts && git commit -m "test(nexus): run paired current-source safety cases"`.

**Done:** A locally runnable deterministic core can produce bounded and traceable R/N observations; missing/race-unproven cases are not hidden by passed cases.

### Task 6: Worktree, LSP and Semantic Capability Boundaries

**Files:** Modify `tests/benchmarks/quality/fixtures.ts`, `runner.ts`; create `tests/integration/quality/worktrees.test.ts`, `tests/integration/quality/lsp-boundary.test.ts`, `tests/unit/benchmarks/quality/capability.test.ts`.

**Interfaces:** Reuse Tasks 1–5; add:

```ts
export async function createPrimaryLinkedQualityFixture(signal: AbortSignal): Promise<OwnedQualityFixture>;
export function classifyCapabilityEvidence(value: Readonly<{
  route: 'synthetic' | 'pinned_embedding' | 'lsp_stub' | 'lsp_real';
  executed: boolean; ownerApproved: boolean;
}>): 'FUNCTIONAL_ONLY' | 'RELEVANCE_ELIGIBLE' | 'CONTRACT_ONLY' | 'REAL_LSP_ELIGIBLE' | 'NOT_RUN';
```

F3 must actually contain an owned **primary Git worktree plus one linked worktree**, with divergent dirty source, independent storage/catalog/vector/runtime, and a `Q12` Oracle specific to each root. Use #299 `createOwnedGitWorkspace()`, `runGit()` with its safe isolated environment and #297 validated runtime semantics. Do not reuse two-detached-linked fixture as primary+linked. Do not assume #297 GitHub Closed implies all runtime acceptance tests ran. If its requisite evidence is unavailable, mark Q12 `blocked_dependency`; do not conceal that from the overall report. For Q13, test Definition, References, and Implementations individually using existing **test-only stub** and record `CONTRACT_ONLY`; real server test remains `NOT_RUN` without explicit executable/trust approval (#354), never auto-enable a language server. `Q14` no configured server is core. The synthetic SHA-256 route is `FUNCTIONAL_ONLY`, not natural-language relevance.

- [ ] **Step 1 — RED:** Test primary `.git` directory vs linked `.git` file, divergent dirty source, wrong-root result `WRONG_SOURCE`/`FALSE_FRESH` as appropriate; Q12 no ownership proof → `blocked_dependency`; Q13 stub observation cannot imply `REAL_LSP_ELIGIBLE`; no explicit approval → real-server `NOT_RUN`; synthetic-only → semantic `NOT_ESTABLISHED`; no LSP Trust file or executable spawned by default.
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/integration/quality/worktrees.test.ts tests/integration/quality/lsp-boundary.test.ts tests/unit/benchmarks/quality/capability.test.ts --coverage.enabled=false` → expected FAIL.
- [ ] **Step 3 — Implement:** Add safe owned primary/linked fixture, stub-only LSP handler adapter and explicit Evidence Class/capability gates. Do **not** add embedding API calls or LSP host permissions. Real semantic relevance may be a later input from a pinned independent corpus/model snapshot; if absent, report `NOT_ESTABLISHED` and do not treat synthetic Recall@K as benefit.
- [ ] **Step 4 — Verify GREEN:** Same command → expected PASS for approved test-only routes; required live runs remain explicitly NOT_RUN rather than SKIP-as-PASS.
- [ ] **Step 5 — Authorized commit:** `git add tests/benchmarks/quality/fixtures.ts tests/benchmarks/quality/runner.ts tests/integration/quality/worktrees.test.ts tests/integration/quality/lsp-boundary.test.ts tests/unit/benchmarks/quality/capability.test.ts && git commit -m "test(nexus): cover divergent worktrees and optional LSP boundaries"`.

**Done:** Q12/13/14 are distinct, precondition-gated; real LSP and semantic benefit are not fabricated by test stubs/synthetic embeddings.

### Task 7: Gate Scoring, Full-denominator Comparison and Machine-readable Report

**Files:** Create `tests/benchmarks/quality/report.ts`, `docs/observability/retrieval-quality-benchmarks.md`; Test `tests/unit/benchmarks/quality/report.test.ts`, `tests/integration/quality/report.test.ts`; modify `tests/benchmarks/quality/scoring.ts` only to implement metrics not already in Task 5.

**Interfaces:**

```ts
export interface GateSafetyReport { readonly status: 'SAFETY_PASS' | 'SAFETY_FAIL' | 'INCOMPLETE';
  readonly expected: number; readonly executed: number; readonly falseFresh: number;
  readonly wrongSource: number; readonly correctRefusals: number; readonly falseRefusals: number; }
export interface GateDiscoveryReport { readonly status: 'MEASURED' | 'NOT_ESTABLISHED' | 'INCOMPLETE';
  readonly evaluatedQueries: number; readonly recallAtK?: number; readonly mrr?: number; }
export interface GateAgentLoopReport { readonly status: 'MEASURED' | 'INCOMPLETE';
  readonly bothSuccess: number; readonly baselineOnly: number; readonly nexusOnly: number;
  readonly bothFail: number; readonly successfulPairCostSummary: Readonly<Record<string, number>>; }
export interface QualityReportMetadata { readonly rgVersion: string; readonly nexusCommit: string | null;
  readonly profile: QualityProfile; readonly fixtureDigest: string;
  readonly semanticEvidence: 'NOT_ESTABLISHED' | 'PINNED_CORPUS';
  readonly lspEvidence: 'NOT_RUN' | 'STUB_ONLY' | 'REAL_SERVER'; }
export interface QualityReport { readonly schemaVersion: 1;
  readonly profile: QualityProfile; readonly policyVersion: 'quality-policy-v1';
  readonly fixtureDigest: string; readonly nexusCommit: string | null;
  readonly rgVersion: string; readonly expectedTaskIds: readonly string[];
  readonly missingTaskIds: readonly string[];
  readonly pairs: readonly PairedQualityResult[];
  readonly gate1: GateSafetyReport; readonly gate2: GateDiscoveryReport;
  readonly gate3: GateAgentLoopReport;
  readonly semanticEvidence: 'NOT_ESTABLISHED' | 'PINNED_CORPUS';
  readonly lspEvidence: 'NOT_RUN' | 'STUB_ONLY' | 'REAL_SERVER';
  readonly limitations: readonly string[]; }
export function buildQualityReport(expected: readonly string[], pairs: readonly PairedQualityResult[],
  metadata: QualityReportMetadata): QualityReport;
export function renderQualityMarkdown(report: QualityReport): string;
```

Gate 1 uses `SAFETY_PASS`/`SAFETY_FAIL`/`INCOMPLETE` with required-case denominator. Gate 2 computes deduplicated file/symbol Recall@K/MRR *only with independent relevance labels*, otherwise `NOT_ESTABLISHED`/ineligible rather than zero or PASS. Gate 3 reports four paired categories (`both succeed`, `R only`, `N only`, `both fail`), full-task completion/failure/false-refusal/wrong-adoption rates and cost distributions. **Compare conditional exploration cost only for both-success tasks**, but always show all-task completion and failures beside it. Include risk and interpretation: if safety fails, no superiority claim; if benefit not established, do not infer intrinsic complexity is worthwhile or automatically simplify the product. No arbitrary improvement threshold.

- [ ] **Step 1 — RED:** Report tests with R-only success, N-only success, both fail, both success, a wrong-source adoption followed by later recovery, `CORRECT_REFUSAL` without completion, a missing pair, a `NOT_RUN` required case, a non-evaluable relevance case, and a path/string containing an external absolute directory. Verify successful-only metrics cannot inflate task completion and missing tasks make status INCOMPLETE.
- [ ] **Step 2 — Verify RED:** `npx vitest run tests/unit/benchmarks/quality/report.test.ts tests/integration/quality/report.test.ts --coverage.enabled=false` → expected FAIL.
- [ ] **Step 3 — Implement:** Build strict, versioned JSON report + concise Markdown, with fixture/Oracle/Policy/Nexus/rg/tokenizer versions, source snapshot digests, context bytes/tokens, normalized arguments/digests, trace references and reasons. Do not emit absolute host paths or source bytes in public summaries. Generate files only into an **explicitly owned temporary output root**, and do not update existing #299 reports; `report` can be produced in memory for ordinary tests.
- [ ] **Step 4 — Verify GREEN:** Same targeted command → expected PASS. Then (only under a separate implementation/test authorization):
  - `npx vitest run tests/unit/benchmarks/quality tests/integration/quality --coverage.enabled=false` → all relevant test assertions PASS; expected NOT_RUN/blocked capabilities remain labeled.
  - `npx tsc -p tsconfig.json --noEmit` → PASS.
  - `npm run lint:perf` → PASS for the existing suite; separately lint all new quality test/benchmark files with `npx eslint "tests/benchmarks/quality/**/*.ts" "tests/unit/benchmarks/quality/**/*.ts" "tests/integration/quality/**/*.ts"` because the current `lint:perf` glob does **not** include quality paths.
  - Do not invoke `npm run test:perf`, a live LSP server, embedding service, or host-scale benchmark as a side effect.
- [ ] **Step 5 — Authorized commit:** `git add tests/benchmarks/quality/report.ts tests/benchmarks/quality/scoring.ts tests/unit/benchmarks/quality/report.test.ts tests/integration/quality/report.test.ts docs/observability/retrieval-quality-benchmarks.md && git commit -m "test(nexus): report paired retrieval quality and evidence limits"`.

**Done:** A complete, appropriately caveated quality result can be audited from fixed inputs, traces and paired scores without using performance metrics as a correctness proxy.

---

## Evaluation Evidence / Stop Conditions

- **Core outcome:** produce at least one reproducible, machine-readable `quality-core-v1` paired result, with all required-case evidence accounted for; do not assert product-wide safety from a finite deterministic suite.
- **Conditional outcome:** Q12 depends on actual #297 runtime isolation evidence; Q13 real-server cases depend on Owner-approved #354 environment; semantic relevance depends on independently labeled real-model corpus. Mark missing inputs `blocked_dependency`, `NOT_RUN` or `NOT_ESTABLISHED` as defined, without silently shrinking the expected manifest.
- **Safety stop:** if a tested production route returns/adopts `FALSE_FRESH` or verified-current wrong source, record the smallest reproduction and block any *claim/recommendation* that route is safe; do not automatically modify product code or halt unrelated documentation work.
- **Scope stop:** if substantial new benchmark framework, provider integration, production code changes or host environment changes become necessary, stop that path and ask Human Owner to authorize a bounded change. Do not treat a new Finding as automatic next-task creation.
- **Review stop:** perform normal local self-check only. After the first necessary review/correction, an Owner checkpoint applies; no automatic series of independent reviews or mandatory zero-Finding loop.
- **Authority:** This plan itself is the authorized deliverable. The execution steps, test commands and Git commands above are **instructions for a later separately authorized implementer**, not permission to execute now. No commits, pushes, Issue updates, PR creation, test run or external service write has been authorized.

## Human Owner Checkpoint

At plan completion, the Owner chooses whether to authorize (a) only Tasks 1–5 for the initial deterministic core, (b) Tasks 1–7 including conditional Worktree/LSP extensions, or (c) no implementation yet. **Recommend (a) plus the smallest in-memory JSON reporting slice of Task 7 initially**: it produces actionable current-source/safety evidence without requiring all optional extensions. Full Task 7 reporting and Tasks 6/7 extensions remain a separate Owner choice. Do not automatically start additional work when the bounded initial evidence is available. This is a planning recommendation only, not an approval request to start the next task now.

**Status:** Implementation Plan R0.1 CREATED (local artifact). `DOCUMENT_ONLY`; no execution or GitHub mutation performed.
