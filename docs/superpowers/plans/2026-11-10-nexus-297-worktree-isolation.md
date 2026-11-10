# Nexus #297 — Git Worktree Isolation Implementation Plan R0.1.2

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` **only after explicit Human Owner implementation approval**. Steps use checkbox (`- [ ]`) syntax. No automatic review/correction loop; the Owner's scope and stop conditions take precedence.

**Goal:** Prove that one Git worktree is one independent Nexus runtime and close only demonstrated mutable Storage Isolation failures with bounded Fail-Closed ownership admission.

**Architecture:** Preserve the canonical `projectRoot` as runtime owner identity. Introduce a shared, side-effect-free resolver/preflight for three independently configured storage targets. If reproductions demonstrate missing isolation, use deterministic cross-process multi-target admission to verify durable owner claims and obtain one lifetime writer handle **before** runtime mutations; `memory://` vector storage remains ephemeral and unclaimed. Bridge uses read-only discovery; the child/runtime admits the writer.

**Tech Stack:** Node.js `>=24.0.0`, TypeScript 5.x, Vitest, existing `proper-lockfile`, `better-sqlite3`, LanceDB, Git worktree, MCP HTTP Bridge.

**Spec:** `docs/superpowers/specs/2026-11-10-nexus-297-git-worktree-isolation-design.md` — Design R0.1.3 F-004-limited correction over Design R0.1.2 (reviewed HEAD `a5822f44c9417aaef02fd0d4d2379453209e0791`; prior Design blob `9493b36da9b1fa811dcf5a68856b185ec3b33511`). Documentation-only Commit/Push was explicitly approved; implementation remains HOLD.

**Issue:** https://github.com/yohi/nexus/issues/297

**Authority:** `DOCUMENT_REMEDIATION_ONLY`. Human Owner approved these F-004-limited Design/Plan edits and their Commit/Push only. This plan grants **no** authority for implementation, test execution, other commits, PR, migration or environment changes. Design acceptance `NOT APPROVED`; Implementation GO `HOLD`. All execution steps remain conditional on separate Owner approval.

## Global Constraints

- One worktree = one runtime; owner key is the effective canonical `realpath(projectRoot)`, never branch, revision, `repositoryId`, `worktreeId`, or `revisionId`.
- Support primary `.git` directory, linked `.git` file, detached HEAD, dirty source, same-owner restart, and non-Git projects.
- Evaluate `storage.rootDir`, `storage.metadataDbPath`, and `storage.vectorDbPath` independently, using the *same effective filesystem path semantics* as production stores. Default and genuinely disjoint custom storage must continue to function.
- Only exact `storage.vectorDbPath === 'memory://'` and exact empty string `''` (LanceVectorStore falsy fallback; direct `createRuntimeAssembly()` callers) are ephemeral; retain `LanceVectorStore` per-runtime temporary-directory behavior. Do not canonicalize, persist a claim, or take a cross-runtime writer lease for the ephemeral vector. Root and metadata validation are still mandatory.
- Unknown, foreign, malformed, ambiguous, dangling-symlink, or unsafe unclaimed nonempty persistent resource => refuse before mutating foreign state. No automatic legacy adoption, migration, deletion, or repair.
- Read-only preflight is **not writer authority**. Admission precedes any PID/Endpoint mutation, project lock, **normal** `StorageManager` directory initialization, SQLite/LanceDB open, runtime logging or Endpoint publication. **F-004 exception:** Inside `admitStorageWriter()` only, after all owners/targets are validated under the complete stable admission/claim lock set and acquired kernel lifetime writer leases, create missing *empty claim-required directories and metadata claim parent*, then publish atomic no-overwrite claims and verify before returning the handle. Bridge does **not** create Storage directories.
- Resolve all target identities and acquire the complete deterministic resource-lock set; recheck *all* claims and targets before first new claim write. Per-file atomic claim publication is allowed; cross-file all-or-nothing publication is not claimed. A partial claim never grants writer access.
- Exclude simultaneous independent writers of any overlapping persistent storage, even when both present the same owner. A discovery-only Bridge is never a second writer.
- No new configuration or public MCP schema, shared storage, cross-worktree cache (#300), Global Manager (#81), or scaling (#303). Preserve existing unit contracts where possible.
- Stop at Human Owner checkpoint if reliable legacy ownership, physical-alias locking, same-path worktree recreation, or crash recovery requires a broad new framework. Do not initiate new tasks, reviews, PRs, or commits automatically.
- F-001/F-002/F-003 correction contract: Bridge Storage mutation is forbidden; stable OS-account coordination and kernel-held non-stale writer leases must be verified before execution; internal `WriterAdmission` is unforgeable by runtime registry and consumable only once. Unknown capabilities are STOP conditions, not PASS.

## File Structure and Responsibility Map

| File | Responsibility |
| --- | --- |
| `src/server/storage-ownership/types.ts` **new** | Internal spec-exact `ResolvedStorageOwnershipTargets`, `OwnershipPreflight`, `WriterAdmission` types |
| `src/server/storage-ownership/targets.ts` **new** | Canonical effective path resolution and exact `memory://` and `''` ephemeral classification; no mutation |
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
3. Bridge whose custom targets differ from child config, or whose Storage Root is absent: Task 5 `S13_child_revalidates_config_change` / `S13_absent_storage_dir_uses_external_startup_gate`.
4. Crash between claim publications, or live process pause exceeding legacy stale threshold: Task 3 `S07_partial_claim_retry_contract`, `S10_paused_live_writer_lease_cannot_be_stolen`.
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
// SHA-256(JSON.stringify(['nexus-targets-v1', owner, root, metadata,
// vectorKind, persistentVectorPathOrMemorySentinel])); shared by admission and Endpoint.
function storageTargetsFingerprint(targets: ResolvedStorageOwnershipTargets): string;
```

- [ ] **Step 1: Write failing resolver tests.** `canonicalizes_existing_symlink_alias`, `canonicalizes_missing_target_from_verified_ancestor`, `rejects_unsafe_sqlite_hardlink_and_dangling_alias`, `classifies_only_exact_memory_sentinel`, `supports_non_git_project`, `preserves_effective_custom_relative_path_semantics`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/server/storage-ownership-targets.test.ts`; expected missing implementation fails.
- [ ] **Step 3: Implement `resolveStorageOwnershipTargets(config)` and `storageTargetsFingerprint(targets)`.** For present targets use `realpath`; for missing targets use verified canonical ancestor and unresolved suffix, with later identity recheck; avoid creating any file. Reject unsafe ambiguous targets. Leave `memory://` as `{kind:'ephemeral',source:'memory://'}` (no generated directory, claim, or lease). Fingerprint uses exact Design §4.4 ordered canonical tuple, **never** generated temp vector path; use it in admission and managed Endpoint matching. Match `StorageManager`/`LanceVectorStore` effective path semantics rather than inventing project-relative resolution.
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

**F-004 claim-directory bootstrap:** A fresh `rootDir` or persistent vector directory must exist before its in-directory claim file is written. The missing SQLite file-claim **parent** must exist before writing its adjacent sidecar claim, but `metadata.db` itself must remain unopened/uncreated until successful `WriterAdmission`. These mkdir operations are allowed **only in the admission service**, after all persistent ownership checks and kernel-backed locks/leases, and never in Bridge/ordinary `StorageManager`.

**F-002 fixed lock contract (Design §4.3):** `CanonicalPath` means realpath of existing target or realpath of nearest verified ancestor plus its absent suffix. `resourceKey = SHA-256("nexus-storage-path-v1\0" + canonicalAbsoluteTargetPath)` with no role/TMPDIR/PID component, stable before/after creation and identical for symlink aliases. Place internal lock files under verified `<realpath(os.userInfo().homedir)>/.local/state/nexus-ownership-v1`; use `admission.lock` as a short kernel-exclusive claim-set gate, sorted `resource/<key>.lock` for short admission locks, and sorted `writer/<key>.lock` for **OS-kernel-backed, nonblocking, lifetime exclusive locks**. A private coordinator directory must have validated owner/permissions; reject unsafe cross-account, remote/namespace or alias conditions. Admission checks all physical targets/ancestor overlaps under the gate before publishing any claim. Lifetime leases live with the admitted Runtime and are released after owned runtime shutdown; an OS process crash releases kernel locks without moving durable claims. **Never** use the currently installed TMPDIR-derived `acquireGlobalLock()` or mtime-stale `proper-lockfile` takeover as evidence of nonoverlapping writer leases. A minimal supported `flock(2)`-equivalent adapter must be demonstrated before any store admission; Node's abstract types alone are not that demonstration. If a bounded adapter requires an unapproved dependency or cannot enforce local OS lock semantics: **STOP at Owner checkpoint** without claiming a pass, adding a dependency, or changing broader scope. This is a future implementation contract, not an observed result.

- [ ] **Step 1: Write failing S02/S03/S04/S07/S09 tests.** `S02_metadata_collision_refuses_without_writes`, `S03_vector_collision_refuses_without_writes`, `S04_symlink_alias_contends_for_same_lock`, `S07_reversed_target_order_cannot_deadlock_or_split_owner`, `S09_same_owner_second_independent_writer_is_rejected`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/server/storage-ownership-admission.test.ts tests/integration/storage-ownership-process.test.ts`.
- [ ] **Step 3: Implement stable physical-key and coordination primitives.** Use Design §4.3 `resourceKey` and verified OS-account coordination root; lock files are not inside unclaimed storage. Obtain one short-lived kernel-exclusive `admission.lock`, then all sorted per-key admission locks before evaluating claims. Keep canonical identity equal for existing/absent target and symlink alias, including when different processes set different `TMPDIR`. No role-based lock bifurcation. A name/lock-anchor change after creation, untrusted filesystem, unsupported account/namespace or unverified native file-lock backend is **Owner STOP**. Check `S07_lock_identity_survives_target_creation`, `S07_symlink_alias_and_different_tmpdir_contend` and `S07_unavailable_kernel_lock_refuses_before_claim`.
- [ ] **Step 4: Implement `admitStorageWriter(targets)` including F-004 bootstrap.** Read-only inspect, acquire stable global gate, all sorted resource locks and kernel lifetime writer leases. Re-resolve and verify **all** persistent owners, path aliases, claims and data **before any Storage mkdir or claim write**; refuse any foreign/unsafe existing target without directory creation. Only then, while retaining all locks/leases, create the missing **empty** directory-claim targets (`rootDir`, persistent vector), the missing **empty metadata file-claim parent**, and required empty ancestors with no-follow/identity checks; never create `metadata.db`, SQLite sidecars, LanceDB tables, PID, Endpoint or runtime logs. Revalidate stable keys/aliases and no unexpected data, atomically publish claims with no overwrite, and verify all persistent claims before returning the opaque handle. `memory://` requires no vector bootstrap; Root/Metadata still do. On interrupted mkdir/claim publication return **no handle** and never delete preexisting data, directories or claims; any new empty directory/valid partial same-owner claim remains for revalidation on retry. Release short admission locks; retain writer leases until owned runtime shutdown. Unverified lock backend => Owner STOP, not PASS.
- [ ] **Step 5: Define and later execute F-004/S07 safety cases.** `S07_bootstrap_new_storage_root_claim`, `S07_bootstrap_new_metadata_parent_claim_without_opening_db`, `S07_bootstrap_new_persistent_vector_directory_claim`, `S07_claim_midwrite_failure_same_owner_retry`, `S07_claim_midwrite_failure_does_not_modify_existing_data`, `S07_foreign_owner_refused_before_any_directory_creation`: check all three initial claim placements, the exact permitted pre-handle mkdir/claim side effects, complete lock+lease retention, and that failed admission does not change existing data/Endpoint/PID. Verify leftover empty directories have **no implicit owner**, matching-owner partial claims resume only after full revalidation, and foreign-owner overlap is refused before mkdir. Retain `S07_partial_claim_retry_contract`, `S07_claim_lock_failure_creates_zero_new_claims`, `S07_lock_identity_survives_target_creation`, `S07_symlink_alias_and_different_tmpdir_contend`, `S07_unavailable_kernel_lock_refuses_before_claim`, `S08_malformed_or_unwritable_claim_refuses`, `S10_crashed_claim_is_not_transferred`, `S10_paused_live_writer_lease_cannot_be_stolen`, `S10_crash_releases_kernel_lease_but_preserves_claim`, `S10_unsupported_lock_backend_is_stop_not_pass`; use separate processes for concurrent safety. **No tests are run by this documentation-only correction.**
- [ ] **Step 6: Implement bounded error/cleanup behavior.** Internal failures include `owner_conflict`, `owner_unknown`, `ambiguous_target`, `writer_busy`, `lock_unavailable`, `claim_io_failed` and `unsupported_kernel_lease`. Release only attempt-owned descriptor-backed leases/short locks; never delete foreign claims/data and never auto-adopt legacy storage. If a writer's kernel lock is lost/compromised, stop serving before any further storage mutation; do not attempt a time-based reclaim. No public MCP schema change.
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
// WriterAdmission is nominal, issued only by the shared service, and
// authenticated at runtime by a module-private WeakMap registry.
// Only ISSUED handles with live kernel leases and matching freshly-resolved
// canonical targets may be transferred; Assembly consumes once.
NexusServerFactory.createRuntime(config: Config, admission?: WriterAdmission): Promise<NexusRuntime>;
createRuntimeAssembly(
  config: Config,
  dependencies?: RuntimeAssemblyDependencies & { readonly writerAdmission?: WriterAdmission }
): Promise<RuntimeAssembly>;
// Private service primitives, NOT a public API:
assertLiveWriterAdmission(handle: unknown, config: Config): Promise<void>;
consumeWriterAdmission(handle: WriterAdmission, config: Config): Promise<ConsumedWriterLease>;
// Private runtime-only release token, distinct from transferable handle:
interface ConsumedWriterLease { readonly release: () => Promise<void> }
```

- [ ] **Step 1: Write failing tests.** `CLI_foreign_owner_refuses_before_nexus_pid`, `reindex_does_not_open_foreign_metadata`, `direct_factory_cannot_bypass_admission`, `serve_uses_guarded_factory`, `release_after_stores_and_owned_pid_cleanup`, `foreign_pid_not_unlinked_on_failed_admission`, `forged_writer_admission_is_rejected`, `cast_or_cloned_handle_is_rejected`, `released_handle_cannot_be_reused`, `consumed_handle_cannot_initialize_second_runtime`, `handle_rejects_different_metadata_or_ephemeral_vector_config`, `valid_cli_transfer_is_single_use`, `post_transfer_cli_release_cannot_drop_live_runtime_lease`, `release_is_idempotent`. All rejections must occur before any Storage/PID/Endpoint mutation.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/bin/nexus.test.ts tests/unit/server/factory.test.ts tests/unit/server/process-lock.test.ts`.
- [ ] **Step 3: Require authenticated admission before ordinary runtime mutations (F-003/F-004 boundary).** Only admission service creates handles in a private identity registry with states `ISSUED -> CONSUMED_BY_RUNTIME -> RELEASED`, issuer ID, canonical-target fingerprint and live kernel lease set. Factory validates authenticity and exact Config before forwarding; Assembly validates and atomically consumes once before **ordinary runtime** Storage/PID mutations. The sole pre-handle Storage effect is Task 3's Admission-internal locked F-004 empty-directory/claim bootstrap; `StorageManager.ensureDirectories()` remains post-handle only. Direct Assembly without a handle performs its own admission. Reject forged, released, consumed, mismatched or lost-lease handles before any ordinary mutation. Guard stdio, managed, reindex, `nexus serve`; CLI must not independently mkdir, create PID or log before admission. Never double-admit.
- [ ] **Step 4: Transfer/close leases safely.** After Assembly consumes a valid handle, it gets a separate private `ConsumedWriterLease` release token; calling the original `WriterAdmission.release()` after transfer must **not** release the runtime lease. Managed/stdio/reindex shutdown must first stop accepting work, remove **only owned** Endpoint/PID under the still-live kernel lease (reorder `managed-http-server.ts` / `nexus.ts` when their present cleanup runs after `runtime.close()`), then close stores and release once as the final operation. CLI/Factory must not release after successful transfer; pre-transfer failure may release only its own valid unconsumed handle. Both release methods are idempotent in their permitted state; no released handle is reusable. Avoid `unlinkSync` of foreign PID or late cleanup after lease release; forged handles never trigger release of another writer's leases.
- [ ] **Step 5: Verify focused and process-level tests.** `./node_modules/.bin/vitest run tests/unit/bin/nexus.test.ts tests/unit/server/factory.test.ts tests/unit/server/process-lock.test.ts tests/integration/storage-ownership-process.test.ts`. Preserve same-owner restart and existing non-Git behavior.

**Deliverable:** No runtime writer entry point can bypass admission.

### Task 5: Give HTTP Bridge full-target read-only preflight without a second writer

**Files:**
- Modify: `src/bin/http-bridge.ts`, `src/server/project-connector.ts`, `src/server/project-endpoint.ts`, `src/server/managed-http-server.ts` (internal target fingerprint / admitted-child cleanup only)
- Test: `tests/unit/bin/http-bridge.test.ts`, `tests/unit/server/project-connector.test.ts`, `tests/unit/server/project-endpoint.test.ts`, `tests/integration/http-bridge.test.ts`
- Extend if needed: `tests/e2e/project-auto-connector.test.ts`

**Interfaces (F-001):** `ProjectConnectorOptions` adds `readonly storageOwnershipTargets: ResolvedStorageOwnershipTargets`. Keep `projectRoot`, `storageDir`, spawn, fetch and timeout fields; validate consistency with the resolved object. Connector may invoke only read-only `inspectStorageOwnership()` and the external `startup` coordination gate; it **does not** acquire/return `WriterAdmission`. Use `startup/<sha256(ownerProjectRoot)>.lock` in Design §4.3's trusted account-private coordination root, **not** `projectStartupLockName(storageDir)`/TMPDIR lock (which requires `storageDir` to exist). Bridge/Connector have no permission to `mkdir(storageDir)`, touch `endpoint.json`, create `nexus.pid`, or place logs under Storage. Child's WriterAdmission protects any stale same-owner descriptor cleanup. Internal endpoint metadata includes an effective-three-target fingerprint for correct healthy-runtime reuse; no public API/setting added.

- [ ] **Step 1: Write failing tests.** `S13_bridge_passes_custom_metadata_and_vector_targets`, `S13_absent_storage_dir_uses_external_startup_gate`, `S13_bridge_never_mutates_unclaimed_storage`, `S13_foreign_endpoint_not_deleted`, `S13_child_revalidates_config_change`, `S13_internal_endpoint_fingerprint_prevents_wrong_reuse`, `S13_attempt_logs_live_outside_storage_and_are_owner_cleaned`, `bridge_never_acquires_writer_lease`, `same_owner_healthy_endpoint_reused`, `same_owner_stale_endpoint_cleanup_is_child_writer_only`, `S13_timeout_does_not_cleanup_foreign_descriptor`.
- [ ] **Step 2: Run red.** `./node_modules/.bin/vitest run tests/unit/bin/http-bridge.test.ts tests/unit/server/project-connector.test.ts tests/integration/http-bridge.test.ts`.
- [ ] **Step 3: Wire mutation-free Bridge/Connector.** After `loadConfig({projectRoot,env})`, pass all `resolveStorageOwnershipTargets(config)` fields; never reconstruct metadata/vector from root. Remove Connector's current `mkdir(storageDir)`, invalid-descriptor deletion, and Storage-root startup log creation/cleanup. First read-only preflight; then acquire the **external stable kernel-backed owner-root startup gate** (works for absent Storage Root), re-inspect ownership and endpoint/health, and spawn only if a safe new Runtime is permitted. Keep gate until healthy/failure/timeout; release without touching Storage. Child must not take this startup gate and independently re-resolves effective config before writer admission.
- [ ] **Step 4: Revalidate and assign cleanup ownership.** Existing healthy same-owner endpoint reuse requires fresh read-only preflight, matching internal effective-three-target fingerprint and instanceId/PID/health. Old descriptors lacking fingerprint are not optimistically reused. Extend only the **internal** `ProjectEndpoint` descriptor to carry `storageTargetsFingerprint(targets)` and have the admitted managed child publish it; the Bridge compares that same deterministic canonical tuple. Only child **after authentic WriterAdmission** may compare-and-delete a stale same-owner descriptor and publish its own; foreign/unverifiable descriptors stay intact. Place temporary per-attempt logs in `<coordinationRoot>/startup-logs/` with strict file ownership (`0600`) and unpredictable token; Bridge may read and remove only token-owned logs after definite outcome, otherwise retain them; child must not write Storage startup logs before admission. Bridge never holds writer leases; a changing config/race fails closed. Don't create an independent cleanup worker.
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
| F-004 admission-only empty claim-directory bootstrap / full-validation-first | Task 3 S07; Task 4 normal runtime startup boundary |
| Owner unknown/legacy, same-path recreation checkpoint | Task 1, Task 3, Task 6 |
| `SPEC.md` only after proof; no speculative extra scope | Task 6 |

**F-001–F-004 document status:** Design R0.1.3 and Plan R0.1.2 specify the same Bridge read-only boundary, persistent physical locks and writer leases, opaque `WriterAdmission`, and F-004 Admission-only empty-directory bootstrap after **complete validation and lock/lease acquisition**, before atomic claims and handle return. These guarantees are **not implemented or test-proven**. Kernel adapter availability, Legacy Storage and same-path Worktree recreation remain **UNVERIFIED / Owner checkpoint**. Task 1 collision evidence and S07 tests have **NOT RUN**.

**Final status:** Planning artifact only. No implementation or test execution is claimed. Human Owner retains design acceptance, execution method, exact task authorization, and any GitHub write approval.
