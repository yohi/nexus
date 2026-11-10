# Nexus #297 — Git Worktree Isolation Implementation Plan R0.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` **only after explicit Human Owner implementation approval**. Steps use checkbox (`- [ ]`) syntax. No automatic review/correction loop; the Owner's scope and stop conditions take precedence.

**Goal:** Prove that one Git worktree is one independent Nexus runtime and close only demonstrated mutable Storage Isolation failures with bounded Fail-Closed ownership admission.

**Architecture:** Preserve the canonical `projectRoot` as runtime owner identity. Introduce a shared, side-effect-free resolver/preflight for three independently configured storage targets. If reproductions demonstrate missing isolation, use deterministic cross-process multi-target admission to verify durable owner claims and obtain one lifetime writer handle **before** runtime mutations; `memory://` vector storage remains ephemeral and unclaimed. Bridge uses read-only discovery; the child/runtime admits the writer.

**Tech Stack:** Node.js `>=24.0.0`, TypeScript 5.x, Vitest, existing `proper-lockfile`, `better-sqlite3`, LanceDB, Git worktree, MCP HTTP Bridge.

**Spec:** `docs/superpowers/specs/2026-11-10-nexus-297-git-worktree-isolation-design.md` (Design R0.1.1; Git blob `bc97de3c854df2371f235d924a0490a50fd1984a`; HEAD `69d4e0f59954f65340e78b3d2142320c6178584d`).

**Issue:** https://github.com/yohi/nexus/issues/297

**Authority:** `PLAN_AUTHORING_ONLY`. The Design currently states Owner Design Acceptance `NOT APPROVED` and Implementation Authorization `HOLD`. This document **does not authorize** tests, code changes, commits, Push, PRs, migrations, or environmental changes. All execution steps below are conditional future instructions that require separate Owner approval.

## Global Constraints

- One worktree = one runtime; owner key is the effective canonical `realpath(projectRoot)`, never branch, revision, `repositoryId`, `worktreeId`, or `revisionId`.
- Support primary `.git` directory, linked `.git` file, detached HEAD, dirty source, same-owner restart, and non-Git projects.
- Evaluate `storage.rootDir`, `storage.metadataDbPath`, and `storage.vectorDbPath` independently, using the *same effective filesystem path semantics* as production stores. Default and genuinely disjoint custom storage must continue to function.
- Only exact `storage.vectorDbPath === 'memory://'` is ephemeral; retain `LanceVectorStore` per-runtime temporary-directory behavior. Do not canonicalize, persist a claim, or take a cross-runtime writer lease for the ephemeral vector. Root and metadata validation are still mandatory.
- Unknown, foreign, malformed, ambiguous, dangling-symlink, or unsafe unclaimed nonempty persistent resource => refuse before mutating foreign state. No automatic legacy adoption, migration, deletion, or repair.
- Read-only preflight is **not writer authority**. The authoritative admission must precede PID/descriptor cleanup or creation, project lock, storage directory creation, SQLite/LanceDB access, logging, and Endpoint publication.
- Resolve all target identities and acquire the complete deterministic resource-lock set; recheck *all* claims and targets before first new claim write. Per-file atomic claim publication is allowed; cross-file all-or-nothing publication is not claimed. A partial claim never grants writer access.
- Exclude simultaneous independent writers of any overlapping persistent storage, even when both present the same owner. A discovery-only Bridge is never a second writer.
- No new configuration or public MCP schema, shared storage, cross-worktree cache (#300), Global Manager (#81), or scaling (#303). Preserve existing unit contracts where possible.
- Stop at Human Owner checkpoint if reliable legacy ownership, physical-alias locking, same-path worktree recreation, or crash recovery requires a broad new framework. Do not initiate new tasks, reviews, PRs, or commits automatically.

## File Structure and Responsibility Map

| File | Responsibility |
| --- | --- |
| `src/server/storage-ownership/types.ts` **new** | Internal spec-exact `ResolvedStorageOwnershipTargets`, `OwnershipPreflight`, `WriterAdmission` types |
| `src/server/storage-ownership/targets.ts` **new** | Canonical effective path resolution and exact `memory://` classification; no mutation |
| `src/server/storage-ownership/preflight.ts` **new** | Read-only owner/claim inspection across persistent targets |
| `src/server/storage-ownership/claims.ts` **new** | Internal versioned claim format, physical resource identity, atomic claim I/O and claim locks |
| `src/server/storage-ownership/admission.ts` **new** | Multi-resource ordered admission, active writer leases and failure cleanup |
| `src/server/storage-ownership/index.ts` **new** | Single `StorageOwnershipAdmissionService` export consumed by callers |
| `src/server/runtime-assembly.ts`, `src/server/runtime/assembly-types.ts`, `src/server/factory.ts` | Require one authoritative writer admission; prevent direct runtime bypass/double-admission |
| `src/bin/nexus.ts`, `src/server/process-lock.ts`, `src/server/managed-http-server.ts` | Gate all CLI, managed, reindex side effects; owner-scoped shutdown |
| `src/bin/http-bridge.ts`, `src/server/project-connector.ts` | Carry all configured targets; read-only preflight before discover/reuse/removal/spawn |
| `src/bin/commands/serve.ts` | Confirm v2 `nexus serve` uses protected factory; edit only on proven gap |
| `src/server/runtime/storage.ts` | Preserve exact ephemeral vector handling; change only on proven mismatch |
| `tests/unit/server/storage-ownership-*.test.ts` **new** | Canonicalization, read-only preflight, claims/partial failure/admission |
| `tests/integration/storage-ownership-process.test.ts` **new** | Real multi-process conflicts and crash tests |
| `tests/integration/worktree-isolation.test.ts` **new** | Primary/linked/detached/dirty/non-Git and parallel state isolation |
| Existing fixture/Bridge/CLI/E2E tests | Extend rather than duplicate existing working coverage |
| `SPEC.md` | Only document implementation-backed verified guarantees at the end |

No new third-party production dependency or generalized transaction coordinator is planned. Other files require separately justified scope approval.

## Review Focus — Five Dangerous Inputs and Their Owning Tests

These identify important test cases, **not** requests for additional review sessions.

1. Distinct storage roots but identical SQLite file: Task 1 `S02_red_shared_metadata`, Task 3 `S02_metadata_collision_refuses_without_writes`.
2. `memory://` vectors with shared metadata: Task 2 `S12_ephemeral_does_not_bypass_metadata`, Task 6 `S11_runtime_private_vectors`.
3. Bridge whose custom targets differ from spawned child's effective config: Task 5 `S13_child_revalidates_config_change`.
4. Crash between the first and second of three claim publications: Task 3 `S07_partial_claim_retry_contract`, `S10_crashed_claim_is_not_transferred`.
5. Same-path worktree recreation while an old managed process/external store survives: Task 6 `W06_same_path_recreation_never_reuses_old_runtime`.

---

### Task 1: Build disposable evidence and reproduce the actual gaps

**Files:**
- Modify only as needed: `tests/benchmarks/performance/git-fixture.ts`, `tests/integration/performance/sibling-worktrees.test.ts`
- Create: `tests/integration/worktree-isolation.test.ts`, `tests/integration/storage-ownership-process.test.ts`

**Interfaces:** Reuse `createOwnedGitWorkspace()`, `createSiblingGitFixture()`, `runSiblingScenarios()`. Provide a disposable helper exposing `primary`, `linkedA`, `linkedB` roots and an idempotent `dispose(): Promise<void>`; never commit into the user's real repository.

- [ ] **Step 1: Write W01/W02/W03/W07 positive tests.** `W01_primary_git_directory_and_linked_git_file`, `W02_independent_search_catalog_and_vector`, `W03_detached_and_dirty_current_source`, `W07_non_git_start_and_restart`. Assert `.git` shape, per-worktree sentinels, distinct default `.nexus` roots, and no cross-result/structured-generation leakage.
- [ ] **Step 2: Run tests to observe current behavior.** Run `./node_modules/.bin/vitest run tests/integration/worktree-isolation.test.ts`. Record PASS/observed failure/environment unavailable distinctly; do not claim a run occurred during planning.
- [ ] **Step 3: Write S01–S04 and S12 red collision tests.** `S01_red_shared_root`, `S02_red_shared_metadata`, `S03_red_shared_vector`, `S04_red_symlink_alias`, `S12_red_memory_vector_shared_metadata`. Use different canonical owners; for S02/S03 use *different* storage roots. Check foreign endpoint/PID bytes, SQLite content/sidecars and vector tables before/after, not merely whether an exception was thrown.
- [ ] **Step 4: Execute red tests against unchanged implementation.** Run `./node_modules/.bin/vitest run tests/integration/storage-ownership-process.test.ts`. Identify which safety guarantees are missing. No claim system is authorized if evidence shows no gap; if confirmed, proceed only with the bounded mechanism under later execution authorization.
- [ ] **Step 5: Record evidence/stop conditions.** Existing populated but unclaimed storage or same-path recreation difficulties are documented as observed/unverified separately. Stop for Owner decision if the minimal mechanism is already in doubt.

**Deliverable:** Directly reproducible worktree and storage collision cases; only proven gaps justify new code.

### Task 2: Resolve all effective storage targets and inspect without side effects

**Files:**
- Create: `src/server/storage-ownership/types.ts`, `src/server/storage-ownership/targets.ts`, `src/server/storage-ownership/preflight.ts`, `src/server/storage-ownership/index.ts`
- Test: `tests/unit/server/storage-ownership-targets.test.ts`, `tests/unit/server/storage-ownership-preflight.test.ts`

**Interfaces:** Adopt the exact Design §4.4 names and shapes:

```typescript
type CanonicalPath = string & { readonly __canonicalPath: unique symbol };
type PersistentTarget = Readonly<{ kind: 'persistent'; path: CanonicalPath }>;
type VectorTarget = PersistentTarget | Readonly<{ kind: 'ephemeral'; source: 'memory://' }>;
interface ResolvedStorageOwnershipTargets {
  readonly ownerProjectRoot: CanonicalPath;
  readonly rootDir: PersistentTarget;
  readonly metadataDbPath: PersistentTarget;
  readonly vectorDbPath: VectorTarget;
}
type OwnershipPreflight = Readonly<{
  targets: ResolvedStorageOwnershipTargets;
  disposition: 'owned' | 'unclaimed-clean' | 'refuse';
  reason?: string;
}>;
function resolveStorageOwnershipTargets(config: Config): Promise<ResolvedStorageOwnershipTargets>;
function inspectStorageOwnership(targets: ResolvedStorageOwnershipTargets): Promise<OwnershipPreflight>;
```

- [ ] **Step 1: Write failing resolver tests.** `canonicalizes_existing_symlink_alias`, `canonicalizes_missing_target_from_verified_ancestor`, `rejects_unsafe_sqlite_hardlink_and_dangling_alias`, `classifies_only_exact_memory_sentinel`, `supports_non_git_project`, `preserves_effective_custom_relative_path_semantics`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/server/storage-ownership-targets.test.ts`; expected missing implementation fails.
- [ ] **Step 3: Implement `resolveStorageOwnershipTargets(config)`.** For present targets use `realpath`; for missing targets use verified canonical ancestor and unresolved suffix, with later identity recheck; avoid creating any file. Reject unsafe ambiguous targets. Leave `memory://` as `{kind:'ephemeral',source:'memory://'}` (no generated directory, claim, or lease). Match `StorageManager`/`LanceVectorStore` effective path semantics rather than inventing project-relative resolution.
- [ ] **Step 4: Write failing preflight tests.** `S05_disjoint_clean_targets_are_unclaimed_clean`, `S02_foreign_metadata_owner_is_refused_read_only`, `S12_ephemeral_does_not_bypass_metadata`, `S08_nonempty_unclaimed_refuses`, `S04_nested_foreign_owner_refuses`, `inspection_never_creates_pid_endpoint_or_claim`.
- [ ] **Step 5: Implement `inspectStorageOwnership(targets)`.** A read-only versioned claim parser may be supplied by Task 3; match all **persistent** claims. `owned` only if verifiably same owner; `unclaimed-clean` only for provably safe initialization; `refuse` otherwise. Preflight is advisory and cannot authorize file deletion or store opening.
- [ ] **Step 6: Verify.** `./node_modules/.bin/vitest run tests/unit/server/storage-ownership-targets.test.ts tests/unit/server/storage-ownership-preflight.test.ts`; record actual failures/PASS.

**Deliverable:** Shared physical-target identity and a **side-effect-free** inspection contract.

### Task 3: Implement bounded multi-resource writer admission and safe partial claims

**Files:**
- Create: `src/server/storage-ownership/claims.ts`, `src/server/storage-ownership/admission.ts`
- Complete exports: `src/server/storage-ownership/index.ts`
- Test: `tests/unit/server/storage-ownership-admission.test.ts`
- Extend: `tests/integration/storage-ownership-process.test.ts`

**Interfaces:**

```typescript
interface WriterAdmission {
  readonly targets: ResolvedStorageOwnershipTargets;
  readonly release: () => Promise<void>; // idempotent live writer-lease release
}
interface StorageOwnershipAdmissionService {
  resolveStorageOwnershipTargets(config: Config): Promise<ResolvedStorageOwnershipTargets>;
  inspectStorageOwnership(targets: ResolvedStorageOwnershipTargets): Promise<OwnershipPreflight>;
  admitStorageWriter(targets: ResolvedStorageOwnershipTargets): Promise<WriterAdmission>;
}
function admitStorageWriter(targets: ResolvedStorageOwnershipTargets): Promise<WriterAdmission>;
```

A persistent claim is internal version `1` with `ownerProjectRoot`, canonical `resourcePath`, and physical resource kind (`file` or `directory`); don't let differing roles bypass ownership. Persistent directory claims live in the resource directory, file claims in a protected adjacent file. Never create a claim for `memory://`.

- [ ] **Step 1: Write failing S02/S03/S04/S07/S09 tests.** `S02_metadata_collision_refuses_without_writes`, `S03_vector_collision_refuses_without_writes`, `S04_symlink_alias_contends_for_same_lock`, `S07_reversed_target_order_cannot_deadlock_or_split_owner`, `S09_same_owner_second_independent_writer_is_rejected`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/server/storage-ownership-admission.test.ts tests/integration/storage-ownership-process.test.ts`.
- [ ] **Step 3: Implement physical-resource claim/lock primitives.** Deduplicate persistent keys and take all locks in globally stable canonical-target order. Use a stable shared physical lock anchor with existing `proper-lockfile`; **do not derive it solely from per-process `TMPDIR` or make its identity change after creating a missing parent**. Test this with multiple processes and different `TMPDIR`. If no minimal stable anchor works across the supported absent-path/symlink cases, **STOP** rather than claiming safety.
- [ ] **Step 4: Implement `admitStorageWriter(targets)`.** Under all locks, re-resolve all targets; reject foreign/unknown/malformed claims and nonempty unclaimed data; obtain all process-lifetime persistent-resource writer leases; *only then* publish missing claims with atomic create/no-overwrite and verify the entire target set. Return `WriterAdmission` only after all persistent targets have same-owner verified claims and active leases. Do not treat a partial claim as admission; release claim locks promptly and writer leases on `release()`.
- [ ] **Step 5: Test failures and retries.** `S07_partial_claim_retry_contract`: inject failure on the second of three claim publications; no writer handle or store mutations; valid partial same-owner claims remain and are retriable after all-lock revalidation; any different owner overlapping an already claimed target refuses. `S07_claim_lock_failure_creates_zero_new_claims`; `S08_malformed_or_unwritable_claim_refuses`; `S10_crashed_claim_is_not_transferred`; `S10_stale_lease_recovered_only_if_verifiably_safe`.
- [ ] **Step 6: Implement bounded error/cleanup behavior.** Internal failure reasons include `owner_conflict`, `owner_unknown`, `ambiguous_target`, `writer_busy`, `lock_unavailable`, `claim_io_failed`. Release only attempt-owned leases/locks, never delete foreign claims/data, and never auto-adopt legacy storage. No public MCP schema change.
- [ ] **Step 7: Verify with processes, not mock-only concurrency.** `./node_modules/.bin/vitest run tests/unit/server/storage-ownership-admission.test.ts tests/integration/storage-ownership-process.test.ts`; successful admission means all persistent targets share one verified owner and one active writer; aborted partial attempts grant no writer authority.

**Deliverable:** One opaque, idempotent runtime writer handle only after full persistent resource ownership is proven. **STOP at Owner checkpoint** if minimal atomicity cannot be established.

### Task 4: Gate CLI and every runtime construction path before mutation

**Files:**
- Modify: `src/server/runtime-assembly.ts`, `src/server/runtime/assembly-types.ts`, `src/server/factory.ts`, `src/bin/nexus.ts`
- Modify only where necessary for owner-safe cleanup: `src/server/process-lock.ts`, `src/server/managed-http-server.ts`
- Inspect: `src/bin/commands/serve.ts`, `src/server/runtime/storage.ts`
- Test: `tests/unit/bin/nexus.test.ts`, `tests/unit/server/factory.test.ts`, `tests/unit/server/process-lock.test.ts`

**Interfaces:**

```typescript
// Internal ownership transfer; exact same Config/targets must be validated.
NexusServerFactory.createRuntime(config: Config, admission?: WriterAdmission): Promise<NexusRuntime>;
createRuntimeAssembly(
  config: Config,
  dependencies?: RuntimeAssemblyDependencies & { readonly writerAdmission?: WriterAdmission }
): Promise<RuntimeAssembly>;
```

- [ ] **Step 1: Write failing tests.** `CLI_foreign_owner_refuses_before_nexus_pid`, `reindex_does_not_open_foreign_metadata`, `direct_factory_cannot_bypass_admission`, `serve_uses_guarded_factory`, `release_after_stores_and_owned_pid_cleanup`, `foreign_pid_not_unlinked_on_failed_admission`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/bin/nexus.test.ts tests/unit/server/factory.test.ts tests/unit/server/process-lock.test.ts`.
- [ ] **Step 3: Require admission before mutations.** Guard normal stdio, managed HTTP, reindex and `nexus serve`; `NexusServerFactory`/direct `createRuntimeAssembly` must admit if not given a previously validated in-process handle. CLI admit *before* `acquireProcessLock()`, current `nexus.pid` creation, logs, `StorageManager.ensureDirectories()`, `acquireProjectLock()`, or store constructors. Do not double-admit one owner.
- [ ] **Step 4: Transfer/close leases safely.** Runtime closes stores and owned process/endpoint state before lease release; all error and signal exits release exactly once. Avoid `unlinkSync` of a PID after ownership has been released. Refused admission must not alter another owner's endpoint/PID.
- [ ] **Step 5: Verify focused and process-level tests.** `./node_modules/.bin/vitest run tests/unit/bin/nexus.test.ts tests/unit/server/factory.test.ts tests/unit/server/process-lock.test.ts tests/integration/storage-ownership-process.test.ts`. Preserve same-owner restart and existing non-Git behavior.

**Deliverable:** No runtime writer entry point can bypass admission.

### Task 5: Give HTTP Bridge full-target read-only preflight without a second writer

**Files:**
- Modify: `src/bin/http-bridge.ts`, `src/server/project-connector.ts`
- Test: `tests/unit/bin/http-bridge.test.ts`, `tests/unit/server/project-connector.test.ts`, `tests/integration/http-bridge.test.ts`
- Extend if needed: `tests/e2e/project-auto-connector.test.ts`

**Interfaces:** `ProjectConnectorOptions` adds `readonly storageOwnershipTargets: ResolvedStorageOwnershipTargets`. Keep `projectRoot`, `storageDir`, spawn, fetch and timeout fields; validate consistency with the resolved object. Connector may invoke only `inspectStorageOwnership()`; it does **not** return/acquire `WriterAdmission`.

- [ ] **Step 1: Write failing tests.** `S13_bridge_passes_custom_metadata_and_vector_targets`, `S13_foreign_endpoint_not_deleted`, `S13_child_revalidates_config_change`, `bridge_never_acquires_writer_lease`, `same_owner_healthy_endpoint_reused`, `same_owner_stale_endpoint_cleanup_rechecks_ownership`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/bin/http-bridge.test.ts tests/unit/server/project-connector.test.ts tests/integration/http-bridge.test.ts`.
- [ ] **Step 3: Wire Bridge/Connector.** After `loadConfig({projectRoot,env})`, pass `resolveStorageOwnershipTargets(config)` in full; never reconstruct metadata/vector from root. In `ensureProjectEndpoint`, preflight before its existing initial `mkdir`, descriptor reuse/deletion, startup lock/spawn/log writes. A foreign or unknown descriptor is not reusable or removable.
- [ ] **Step 4: Revalidate on races.** Reinspect before cleaning a stale **same-owner** endpoint, before accepting a startup-lock winner, and on managed-spawn decision. Child re-resolves its own effective config and obtains authoritative writer admission; mismatched parent/child config must fail closed. Retain instanceId/PID/health checks, but they do not replace ownership checking.
- [ ] **Step 5: Verify.** `./node_modules/.bin/vitest run tests/unit/bin/http-bridge.test.ts tests/unit/server/project-connector.test.ts tests/integration/http-bridge.test.ts`; then `npm run build && NEXUS_E2E=1 ./node_modules/.bin/vitest run tests/e2e/project-auto-connector.test.ts`. Report actual results, not presumed PASS.

**Deliverable:** Discovery-only Bridge can safely reuse a healthy same-owner runtime but cannot create a second writer or mutate foreign storage.

### Task 6: Whole-worktree acceptance, `SPEC.md`, and terminal Owner checkpoint

**Files:**
- Extend: `tests/integration/worktree-isolation.test.ts`, `tests/integration/storage-ownership-process.test.ts`, `tests/e2e/project-auto-connector.test.ts`
- Modify only after actual implementation proof: `SPEC.md`
- Optional bounded clarification: `docs/configuration/storage-and-indexing.md`

**Interfaces:** Tasks 2–5 only; no new public identities, flags, or manager framework.

- [ ] **Step 1: Test W04/W05 parallel runtimes and Bridges.** Launch actual distinct-process sibling runtimes with independent PID, startup/project locks, Endpoint and source sentinels. Two Bridges into the *same* worktree must reuse one healthy managed runtime, not create a second writer.
- [ ] **Step 2: Test W06 delete/recreate.** Cover different-path and **identical-path** recreation, default storage, external custom storage, surviving old managed child and old descriptor. Require no stale server connection, search/index leakage or silent old-storage reuse. If canonical path alone cannot distinguish safe recreation, **STOP** and present evidence/limited root-local lifetime witness option to Owner; do not add unapproved `worktreeId`.
- [ ] **Step 3: Complete S05–S13 and W01–W07 acceptance.** Confirm disjoint custom paths work, same-owner restart works, `memory://` vectors are independent without persistent vector claims, shared root/metadata still refuses, malformed/unclaimed populated stores refuse without foreign byte changes, multi-process claim failure/crash recovery remains safe. Reuse existing tests where they genuinely prove the invariant.
- [ ] **Step 4: Run bounded verification suite.** Commands:

```bash
./node_modules/.bin/vitest run \
  tests/integration/worktree-isolation.test.ts \
  tests/integration/storage-ownership-process.test.ts \
  tests/integration/performance/sibling-worktrees.test.ts
npm run build
NEXUS_E2E=1 ./node_modules/.bin/vitest run tests/e2e/project-auto-connector.test.ts
npm run lint
./node_modules/.bin/vitest run \
  tests/unit/server/storage-ownership-targets.test.ts \
  tests/unit/server/storage-ownership-preflight.test.ts \
  tests/unit/server/storage-ownership-admission.test.ts \
  tests/unit/server/project-connector.test.ts \
  tests/unit/bin/nexus.test.ts \
  tests/unit/bin/http-bridge.test.ts
```

Expected: report observed PASS/FAIL/SKIPPED/NOT_RUN, including all relevant W01–W07 and S01–S13; do not claim universal PASS without running. Do not automatically run further unrelated suites unless evidence warrants it and execution scope allows it.

- [ ] **Step 5: Update `SPEC.md` based on verification.** State canonical project-root identity, independent default storage, protection of three persistent target kinds, exact ephemeral `memory://` exception, symlink/ownership failure behavior, writer exclusion, same-owner restart, legacy limitations and deletion/recreation guarantee actually demonstrated. Keep shared-cache/Global-Manager exclusions. Do not state unproven guarantees as accomplished.
- [ ] **Step 6: Report terminal acceptance matrix and STOP.** For each W01–W07/S01–S13 cite the exact test/observed result; disclose residual risk and blocked Owner decisions. Do not mark #297 finished if a required case is unproven. Do not automatically open PR, merge, update Issue, initiate independent review or start new tasks.

**Deliverable:** Demonstrated worktree isolation and accurate specification, or a bounded safety stop with evidence and a decision request.

## Execution and Commit Boundaries — Only After Separate Authorization

- Task 1 is the evidence gate. Skip implementation of unnecessary mechanisms if there is no demonstrated gap; otherwise limit new ownership enforcement to gaps actually reproduced.
- Execute tasks sequentially with red/green validation, scoped commits **only when specifically authorized**. Do not perform GitHub operations merely because this plan describes them.
- At the first irreducible safety concern in claims/legacy data/same-path recreation, stop and request Owner decision; no autonomous revision-review loop.
- The real completion condition is the Issue's verified runtime behavior plus `SPEC.md`, not a zero-Finding review report.

## Plan Self-Review (Authoring Only)

| Contract | Owning tasks |
| --- | --- |
| Worktree identity and W01–W07 | Task 1 evidence; Task 6 runtime acceptance |
| F-001 exact `memory://`, root/metadata still protected | Task 2 resolver/preflight; Task 6 S11/S12 |
| F-002 common targets and Bridge/Runtime/CLI boundaries | Task 2 types; Task 4/5 entry integration |
| F-003 all-lock validation, partial claims, retry/crash S07/S10 | Task 3 |
| Owner unknown/legacy, same-path recreation checkpoint | Task 1, Task 3, Task 6 |
| `SPEC.md` only after proof; no speculative extra scope | Task 6 |

**Final status:** Planning artifact only. No implementation or test execution is claimed. Human Owner retains design acceptance, execution method, exact task authorization, and any GitHub write approval.
