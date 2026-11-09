# Nexus #297 — Git Worktree Isolation and Storage Ownership Design R0.1

**Issue:** [#297 — Verify Git worktree compatibility and runtime isolation](https://github.com/yohi/nexus/issues/297)  
**Date:** 2026-11-10 (JST)  
**Baseline:** `master` at `803ff948f79ebf839f35e2cfeceeef6f6130a669`  
**Decision:** Human Owner approved worktree isolation plus minimal fail-closed protection for explicit mutable-storage collisions in brainstorming.  
**Scope / authority:** DESIGN_ONLY. This commit records the design; it does not authorize implementation, tests, migration, Issue edits, PR creation, merge, or follow-on tasks. Design acceptance and implementation authorization require an explicit later Owner decision.

## 1. Intent and boundaries

Prove that each Git worktree is independently correct as a Nexus runtime. Keep the existing project-root-local model; introduce only the least additional storage ownership protection demonstrated necessary by failing compatibility/isolation tests.

Goals:

1. Primary and linked worktrees work with `.git` as either a directory or a file, and with detached HEAD and dirty source.
2. Default and genuinely disjoint custom storage keep search results, structured catalog generations, vector data, descriptors, startup/process locks, and mutable runtime state separate.
3. Reusing any of `storage.rootDir`, `storage.metadataDbPath`, or `storage.vectorDbPath` across different canonical project roots fails closed, including symlink aliases.
4. Ownership is checked before modifying a pre-existing descriptor, PID/process lock, SQLite/LanceDB data, or any other pre-existing mutable runtime state. A rejected startup cannot disrupt an existing runtime.
5. Same-worktree restart remains possible for storage with established matching ownership. Non-Git projects remain supported.
6. Parallel sibling runtimes and deletion/recreation behavior are verified against real disposable filesystem fixtures.

Non-goals and prohibited expansion:

- No shared mutable storage, cross-worktree cache reuse (#300), Global Manager (#81), multi-worktree runtime manager/scaling (#303), or remote/cloud routing.
- No `repositoryId`, `worktreeId`, or `revisionId` by default; branch names, commit hashes, and dirty state are not ownership keys.
- No automatic legacy storage adoption, migration, deletion, rewrite, or speculative ownership inference.
- No change to public MCP tool schemas, retrieval semantics, embedding cache identity, or unrelated runtime features.
- No independent review/revision loop as a default next step. Stop for Owner judgment if safe legacy ownership or same-path recreation cannot be resolved within this bounded design.

## 2. Current implementation evidence

| Component | Observed behavior on the pinned master | Consequence for #297 |
| --- | --- | --- |
| `src/config/index.ts` | Defaults are `<projectRoot>/.nexus`, `metadata.db`, and `vectors`; all three paths can be overridden independently | Storage-root-only validation is insufficient |
| `src/server/runtime-assembly.ts` | Creates directories, acquires a `storage.rootDir` project lock, then initializes SQLite/LanceDB | Ownership verification must move before initialization and existing-state mutation |
| `src/bin/nexus.ts` | Acquires `nexus.pid` under `storage.rootDir` before runtime construction and registers exit cleanup | CLI and reindex entry points also need ownership preflight before PID creation/cleanup |
| `src/server/project-connector.ts` | Reads and validates `endpoint.json` by project root, instance, PID, and health; invalid descriptors can be removed | A foreign-root descriptor is never permission to clean up shared storage |
| `src/utils/global-lock.ts` | Managed-startup lock identity is SHA-256 of canonical storage directory | Distinct roots with shared DB/vector may bypass this lock |
| `src/server/project-endpoint.ts` | Descriptor writes are atomic; matching descriptor removal checks content/inode | Retain these protections, but never remove foreign-owned descriptors |
| `tests/integration/performance/sibling-worktrees.test.ts` and its fixture | Two detached *linked* worktrees are indexed independently but sequentially | Reuse fixture and tests; add primary+linked and real concurrency |
| `tests/e2e/project-auto-connector.test.ts` | Existing single-project managed endpoint reuse and shutdown are covered | Add real sibling endpoint and lifetime isolation cases |
| `SPEC.md` | Describes project-local storage and project-scoped runtime/endpoint/lock behavior | Record the proven contract here after implementation, not as a premature claim in this design-only commit |

Note: `loadConfig()` currently accepts custom paths as supplied; filesystem resolution is performed at downstream call sites. Ownership canonicalization must use the **same effective filesystem targets** as the stores themselves, not silently invent project-relative semantics for custom values.

## 3. Approaches considered

| Approach | Trade-off | Decision |
| --- | --- | --- |
| A. Compatibility tests plus a bounded, persistent owner claim for each mutable storage target | Smallest path to fail-closed safety; requires careful startup ordering and cross-process atomicity | **Selected, conditional on failing collision tests** |
| B. Verify default worktree isolation and rely on existing storage-root locks/health checks | Lowest code cost but misses independently overridden metadata/vector paths and foreign-descriptor cleanup | Rejected for the approved guarantee |
| C. Introduce repository/revision/worktree identity and shared-storage routing | Could support future shared caches/manager, but expands schema and lifecycle dramatically | Rejected; belongs to later issues if independently justified |

First reproduce each collision class with tests. If all relevant paths already fail closed, retain the current mechanism and add no owner metadata. Otherwise implement approach A only for the demonstrated gaps.

## 4. Behavioral contract

### 4.1 Runtime identity

- `ownerProjectRoot` is the absolute canonical (`realpath`) project root; primary, linked, detached, dirty, and non-Git roots use the same rule. Git branch, revision, and `.git` directory shape are irrelevant.
- Equal canonical roots may reuse their own persistent storage after an orderly or crashed process restart; unequal roots may not reuse any of the same mutable storage targets.
- Distinct paths that resolve to the same real directory or file are the same resource, including symlinked directory/file aliases. Invalid, inaccessible, dangling, or ambiguous path resolution fails closed.
- The process must not silently change custom path resolution rules; normalization must be consistent for connector, runtime, CLI, and underlying SQLite/LanceDB opens.

### 4.2 Mutable resource identities

Evaluate these *independently*, rather than assuming they share one directory:

1. `storage.rootDir` — project runtime state, descriptors, PID and logs; directory resource.
2. `storage.metadataDbPath` — SQLite metadata and structured catalog; file resource (including relevant SQLite sidecars).
3. `storage.vectorDbPath` — LanceDB vector store; directory resource.

For an existing target use its canonical realpath; for an absent target resolve through the nearest verified existing ancestor and append the not-yet-created components. Detect aliases after creation again before opening stores. An existing SQLite file with multiple hard links is unsafe to identify by path alone: reject it unless a demonstrably safe physical-identity rule is implemented. Unknown permissions, link loops, or changes to the resolved target during admission cannot be treated as success.

Expected configuration behavior:

| Configuration | Result |
| --- | --- |
| Default independent `.nexus` trees | Both runtimes may run |
| Custom storage with disjoint effective root/metadata/vector targets | Both runtimes may run |
| Same effective `rootDir`, different owner | Refuse later startup; do not remove the first runtime's descriptor or PID |
| Shared `metadataDbPath` only, different owner | Refuse before opening SQLite; preserve existing data |
| Shared `vectorDbPath` only, different owner | Refuse before opening LanceDB; preserve existing data |
| Equivalent paths via symlink, different owner | Treat as the same resource and refuse |
| Matching owner and valid claims, sequential restart | Allow |
| Concurrent writers to an overlapping resource, even for the same owner | Do not allow a second independent writer; existing same-project bridge clients may attach to the one managed runtime |
| Existing nonempty resource with no trustworthy owner claim | Fail closed; no inferred adoption or deletion |

Resource path overlap and symlink indirection must not make an apparent disjoint configuration share mutable bytes. Preserve valid nesting of a single owner's default root/DB/vector paths. If a cross-owner ancestor/descendant alias cannot be verified safely, reject the ambiguous configuration rather than declare it disjoint.

### 4.3 Durable ownership, not mere process locking

Selected bounded mechanism when a collision test proves it necessary:

- Record an internal versioned ownership claim associated with **each** canonical mutable resource, containing the canonical `ownerProjectRoot` and canonical resource target. For file resources use a protected adjacent sidecar/claim; for directory resources use a protected in-directory claim. A role-independent target identity must not permit directory reuse across roles. Ownership is not a public worktree/revision ID.
- Use a per-resource, cross-process atomic claim lock located/derived in a manner shared by all contenders for the same physical target. Acquire unique resource claim locks in a stable order to avoid deadlocks. A temporary process-specific directory such as `TMPDIR` cannot be the only coordination authority when contenders may use different temp directories.
- Under the locks, recheck canonical targets and existing claims. Any mismatch, untrusted/malformed claim, unexplained existing data without a valid claim, or inability to acquire/verify the required claim is a *refusal*, not permission to bootstrap.
- New, provably uninitialized resources may be claimed with atomic creation and appropriate restrictive permissions; do not overwrite an existing claim. A crash leaving a valid partial claim for the same owner may be retried safely; do not auto-delete claims belonging to other owners.
- Before opening mutable stores, acquire exclusive process-lifetime resource writer leases (or an equivalently safe, test-proven scheme) for overlapping targets, including the same-owner/different-rootDir case. Release these leases on normal close and use bounded, verified stale recovery; a bridge attaching to an already healthy same-owner endpoint must not acquire a second writer lease.
- Claims survive ordinary shutdown. Shutdown and failure handlers may clean only state they own, and must not remove an ownership marker simply because a runtime stopped.

### 4.4 Safe preflight and publication ordering

Required ordering for CLI, reindex, managed server spawn/discovery, and direct runtime assembly:

```text
Resolve config + canonical projectRoot
  -> resolve/validate all three effective storage targets
  -> cross-process ownership preflight and safe claim (if justified)
  -> writer admission for a new runtime
  -> existing PID/runtime locks and storage initialization
  -> start runtime / publish healthy managed endpoint
  -> release runtime writer leases and owned transient locks on close
```

Discovery-only clients run the same ownership preflight but **do not** become additional runtime writers. They may reuse a healthy endpoint only when its canonical root and ownership match. A foreign or untrusted descriptor is neither reusable nor removable by that client; refusal must occur before existing-descriptor removal or managed-spawn side effects.

Today `src/bin/nexus.ts` creates `nexus.pid` before `createRuntimeAssembly()`, and `ensureProjectEndpoint()` may delete an invalid endpoint before taking its startup lock. A guard only inside runtime assembly would therefore be too late. Place ownership validation at all mutating entry boundaries and maintain one shared enforcement implementation. Creating minimum new directories/claim-lock files under controlled admission is not permission to modify an unknown pre-existing storage tree.

Cleanup is idempotent and owner-scoped. Failed admission must not leave a foreign-owned resource modified; do not delete another process's `endpoint.json`, `nexus.pid`, logs, or storage to recover from a conflict. `instanceId` and health continue to guard same-owner endpoint freshness.

### 4.5 Existing/legacy stores and Owner checkpoint

Legacy storage that contains data but has no provable ownership is **not safely attributable** to the calling worktree. Automatic adoption would contradict fail-closed behavior. Therefore an unclaimed nonempty custom or default store is refused until ownership can be established by an explicit, separately authorized procedure; this design does not implement a migration or destructive reset.

This deliberately exposes a compatibility tension: already-populated custom stores must not be silently corrupted, but some cannot automatically start under strict ownership validation. Treat that as an **Owner checkpoint**, not as permission to relax safety or grow #297 into a migration framework. Verify clean disjoint custom storage remains usable and report legacy pre-claim impact explicitly.

### 4.6 Delete/recreate at the same path

Deletion and recreation **at a different path** naturally create different canonical roots. At the **same path**, canonical root identity alone cannot distinguish an old worktree incarnation from a new one, especially if external custom storage or an old managed server survives. This is a concrete test hypothesis, not grounds for inventing `worktreeId` in advance.

- Include an actual same-path delete/recreate test with persistent external storage and an old descriptor/runtime, plus the ordinary default-storage case.
- A recreated worktree must never attach to an old live runtime or silently trust prior mutable storage when the old worktree identity cannot be established.
- If the test fails, evaluate a minimal root-local lifetime/incarnation witness checked against persistent owner claims or an equivalent filesystem identity guard. It must not be branch/revision based, and it must not silently migrate old stores.
- Because such a witness changes identity semantics, stop at the Human Owner checkpoint before adding it if safe implementation exceeds the bounded storage-owner mechanism. Never claim this acceptance criterion passed based on pathname equality alone.

## 5. Verification design (implementation is not authorized by this document)

Use disposable real Git repositories/worktrees, fake deterministic embedding providers where possible, distinct source sentinels, and bounded lifecycle cleanup. The existing `createSiblingGitFixture()` is a starting point, but it currently creates two detached linked worktrees and runs them sequentially.

| ID | Scenario | Must prove |
| --- | --- | --- |
| W01 | Primary `.git` directory + linked `.git` file | Both start and index without assuming `.git` is a directory |
| W02 | Primary + two linked siblings with distinct source sentinels | Search, vector records, structured catalog/SQLite generations do not leak |
| W03 | Detached HEAD and dirty modifications in separate worktrees | Runtime operates on each current worktree without branch/revision identity |
| W04 | Two real sibling runtimes and two bridges launched concurrently | Different effective endpoints/PIDs, independent startup/project locks and no cross-routing |
| W05 | Same worktree with two bridges concurrently | One healthy managed runtime is reused; no duplicate writer |
| W06 | Delete/recreate at different and same paths, default and external custom storage | No stale descriptor/runtime connection and no unsafe reuse of old mutable data |
| W07 | Non-Git project | Existing indexing and restart behavior remains deterministic |
| S01 | Same explicit storage root, different canonical project roots | Later startup fails before foreign descriptor/PID deletion or store writes |
| S02 | Distinct roots, identical metadata DB | Both cannot write shared SQLite, even when storage-root locks differ |
| S03 | Distinct roots, identical vector DB | Both cannot write shared LanceDB, even when storage-root locks differ |
| S04 | Symlink aliases of each of the three targets | Collision follows real paths, not lexical spelling |
| S05 | Disjoint custom root/metadata/vector targets | Both run without regressions |
| S06 | Matching owner, sequential restart and stale same-owner endpoint | Safe reuse/recovery and preserved data, without deleting foreign state |
| S07 | Conflicting concurrent first claims and multi-resource reversed overlap | Exactly one claimant can own a given resource; no deadlock, split ownership, or data writes by the loser |
| S08 | Existing unclaimed populated storage, malformed claim, broken symlink, unwritable marker | Fail closed without auto-adoption, overwrite, or corruption |
| S09 | Different storage roots with a same-owner overlapping DB/vector | No simultaneous independent writers; existing healthy managed runtime can still be reused |
| S10 | Process crash and claim/writer-lock recovery | Durable owner survives and stale lock recovery does not transfer ownership to another root |

Negative tests must inspect before/after storage bytes or metadata, ownership files, descriptor identity, PID, and live service state, not merely assert that an error was thrown. A parallel stress scenario should run several bounded iterations with process-level overlap; no sleeps as correctness oracles. Each test cleans only its own disposable fixture and never commits to the user's source repository.

## 6. Documentation contract

After behavior is implemented and verified, update **`SPEC.md`** to state: one canonical worktree root is one independently correct runtime; default storage isolation; the three independently configurable mutable resources; physical alias/ownership failure behavior; concurrent writer exclusion; same-owner restart; safe legacy-store limitations; deletion/recreation limitations or the validated guard; and explicit exclusions for shared cache/manager work.

Keep `SPEC.md` as the source of truth for architecture. Detail configuration knobs in `docs/configuration/storage-and-indexing.md` only if needed; do not create duplicate normative contracts or assert unimplemented guarantees in `SPEC.md` during the design-only step.

## 7. Exit and stop conditions

**Issue #297 can close** only when W01–W07 and S01–S10 relevant tests are executed and supported by evidence, collision attempts cannot corrupt/modify foreign runtime state, positive disjoint configurations remain usable, and the implemented contract is documented in `SPEC.md`. Existing tests count as evidence where their assertions demonstrably satisfy these cases; no automatic test duplication.

**Stop for Human Owner** if existing populated storage cannot be claimed safely without migration, same-path recreation needs a new incarnation identity, cross-process resource admission cannot be made atomic with a bounded mechanism, or current code reveals an unexpected independent bypass. Do not spawn follow-on reviews, fixes, PRs, or issues automatically.

**Current status:** Design authored only. No runtime execution, collision repro, test pass, migration, implementation, `SPEC.md` update, or final implementation authorization is claimed.
