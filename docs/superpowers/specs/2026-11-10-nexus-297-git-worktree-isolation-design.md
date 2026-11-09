# Nexus #297 — Git Worktree Isolation and Storage Ownership Design R0.1.1

**Issue:** [#297 — Verify Git worktree compatibility and runtime isolation](https://github.com/yohi/nexus/issues/297)  
**Date:** 2026-11-10 (JST)  
**Baseline:** `master` at `803ff948f79ebf839f35e2cfeceeef6f6130a669`; Design R0.1 on feature branch HEAD `2e5f2687457d9d70d2e6de11e4d8f7d6a0e6624f` (blob `ade96f6229dc02ea47fa6805759c6c11955ce7dd`).  
**Decision:** Human Owner approved worktree isolation plus minimal fail-closed protection for explicit mutable-storage collisions in brainstorming.  
**Scope / authority:** DESIGN_ONLY, F-001–F-003 limited document correction. This document does not authorize implementation, test execution, Commit/Push, migration, Issue edits, PR creation, merge, or follow-on tasks. Design acceptance and implementation authorization remain **NOT APPROVED / HOLD**.

## 1. Intent and boundaries

Prove that each Git worktree is independently correct as a Nexus runtime. Keep the existing project-root-local model; introduce only the least additional storage ownership protection demonstrated necessary by failing compatibility/isolation tests.

Goals:

1. Primary and linked worktrees work with `.git` as either a directory or a file, and with detached HEAD and dirty source.
2. Default and genuinely disjoint custom storage keep search results, structured catalog generations, vector data, descriptors, startup/process locks, and mutable runtime state separate.
3. Reusing any **persistent** `storage.rootDir`, `storage.metadataDbPath`, or `storage.vectorDbPath` across different canonical project roots fails closed, including symlink aliases. Existing `storage.vectorDbPath="memory://"` is an ephemeral, runtime-private case, not a persistent resource.
4. Ownership is checked before modifying a pre-existing descriptor, PID/process lock, SQLite/LanceDB data, or any other pre-existing mutable runtime state. A rejected startup cannot disrupt an existing runtime.
5. Same-worktree restart remains possible for storage with established matching ownership. Non-Git projects remain supported.
6. Parallel sibling runtimes and deletion/recreation behavior are verified against real disposable filesystem fixtures.

Non-goals and prohibited expansion:

- No shared mutable storage, cross-worktree cache reuse (#300), Global Manager (#81), multi-worktree runtime manager/scaling (#303), or remote/cloud routing.
- No `repositoryId`, `worktreeId`, or `revisionId` by default; branch names, commit hashes, and dirty state are not ownership keys.
- No automatic legacy storage adoption, migration, deletion, rewrite, or speculative ownership inference.
- No change to public MCP tool schemas, retrieval semantics, embedding cache identity, or unrelated runtime features.
- No new configuration flag or shared-storage behavior; retain the existing `memory://` vector mode.
- No independent review/revision loop as a default next step. Stop for Owner judgment if safe legacy ownership or same-path recreation cannot be resolved within this bounded design.

## 2. Current implementation evidence

| Component | Observed behavior on the pinned master | Consequence for #297 |
| --- | --- | --- |
| `src/config/index.ts` | Defaults are `<projectRoot>/.nexus`, `metadata.db`, and `vectors`; all three paths can be overridden independently | Storage-root-only validation is insufficient |
| `src/server/runtime-assembly.ts` | Creates directories, acquires a `storage.rootDir` project lock, then initializes SQLite/LanceDB | Ownership verification must move before initialization and existing-state mutation |
| `src/bin/nexus.ts` | Acquires `nexus.pid` under `storage.rootDir` before runtime construction and registers exit cleanup | CLI and reindex entry points also need ownership preflight before PID creation/cleanup |
| `src/server/project-connector.ts` | Reads and validates `endpoint.json` by project root, instance, PID, and health; invalid descriptors can be removed | A foreign-root descriptor is never permission to clean up shared storage |
| `src/bin/http-bridge.ts` | Loads full configuration, but passes only `projectRoot` and `storageDir` into `ProjectConnectorOptions` | Propagate **all resolved storage targets** to the connector's common read-only preflight |
| `src/utils/global-lock.ts` | Managed-startup lock identity is SHA-256 of canonical storage directory | Distinct roots with shared DB/vector may bypass this lock |
| `src/server/project-endpoint.ts` | Descriptor writes are atomic; matching descriptor removal checks content/inode | Retain these protections, but never remove foreign-owned descriptors |
| `src/storage/vector-store.ts` | `dbPath === 'memory://'` creates a unique `tmpdir()/nexus-lance-${randomUUID()}` path within `LanceVectorStore` | An ephemeral vector has no persistent cross-runtime owner claim |
| `src/server/runtime/storage.ts` | Creates root/metadata directories and skips persistent vector-directory creation for `memory://`-prefixed paths | Match ephemeral admission classification to the *exact* supported `memory://` value and preserve current valid behavior |
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
- Equal canonical roots may reuse their own persistent storage after an orderly or crashed process restart; unequal roots may not reuse any of the same mutable **persistent** storage targets.
- Distinct persistent paths that resolve to the same real directory or file are the same resource, including symlinked directory/file aliases. Invalid, inaccessible, dangling, or ambiguous path resolution fails closed.
- The process must not silently change custom path resolution rules; normalization must be consistent for connector, runtime, CLI, and underlying SQLite/LanceDB opens.

### 4.2 Mutable resource identities (F-001)

Evaluate these *independently*, rather than assuming they share one directory:

1. `storage.rootDir` — **persistent directory**, holding project runtime state, descriptors, PID and logs; ownership is always verified.
2. `storage.metadataDbPath` — **persistent file**, holding SQLite metadata and structured catalog (including relevant SQLite sidecars); ownership is always verified.
3. `storage.vectorDbPath` — **discriminated union**:
   - `{ kind: 'persistent', path: CanonicalPath }` for a filesystem-backed LanceDB directory; requires ownership and writer admission;
   - `{ kind: 'ephemeral', source: 'memory://' }` for the exact legacy setting `storage.vectorDbPath === 'memory://'`. `LanceVectorStore` creates an independent temporary directory for *that runtime*; this resource has **no durable ownership claim, cross-runtime writer lease, or persistent canonical path**. The temporary directory's generated name is not a Worktree ID and must not be recorded as a durable target.

Only the exact supported `memory://` sentinel is ephemeral. Other URI-like inputs are **not** silently classified as ephemeral or mapped to a persistent filesystem path by the admission layer; their handling must remain consistent with existing supported configuration and reject ambiguous/unsupported values rather than granting ownership. This is a design contract, not authorization to change configuration behavior outside the three findings.

For an existing persistent target use its canonical `realpath`; for an absent persistent target resolve through the nearest verified existing ancestor and append the not-yet-created components. Detect aliases after creation again before opening stores. An existing SQLite file with multiple hard links is unsafe to identify by path alone: reject it unless a demonstrably safe physical-identity rule is implemented. Unknown permissions, link loops, or changes to a persistent target during admission cannot be treated as success. An ephemeral vector skips **only vector ownership**, never `rootDir` or `metadataDbPath` validation.

Expected configuration behavior:

| Configuration | Result |
| --- | --- |
| Default independent `.nexus` trees | Both runtimes may run |
| Custom storage with disjoint effective root/metadata/**persistent vector** targets | Both runtimes may run |
| Same effective `rootDir`, different owner | Refuse later startup; do not remove the first runtime's descriptor or PID |
| Shared `metadataDbPath` only, different owner | Refuse before opening SQLite; preserve existing data |
| Shared persistent `vectorDbPath` only, different owner | Refuse before opening LanceDB; preserve existing data |
| `vectorDbPath === 'memory://'` with disjoint root/metadata | Each runtime receives its own ephemeral vector; normal operation permitted |
| `vectorDbPath === 'memory://'` with shared root or metadata | Refuse based on the **persistent** resource conflict |
| Equivalent persistent paths via symlink, different owner | Treat as the same resource and refuse |
| Matching owner and valid claims, sequential restart | Allow |
| Concurrent writers to an overlapping persistent resource, even for the same owner | Do not allow a second independent writer; existing same-project bridge clients may attach to the one managed runtime |
| Existing nonempty persistent resource with no trustworthy owner claim | Fail closed; no inferred adoption or deletion |

Persistent resource path overlap and symlink indirection must not make an apparent disjoint configuration share mutable bytes. Preserve valid nesting of a single owner's default root/DB/vector paths. If a cross-owner ancestor/descendant alias cannot be verified safely, reject the ambiguous configuration rather than declare it disjoint. Ephemeral vectors do not participate in persistent path-overlap analysis.

### 4.3 Durable ownership, multi-resource admission, and recovery (F-003)

When a collision test proves the need for owner claims, apply a bounded mechanism across **all persistent** targets returned by §4.2. `memory://` is excluded from the claim set.

- Record an internal versioned ownership claim associated with each canonical persistent mutable resource, containing `ownerProjectRoot` and the canonical resource target. For a file resource use a protected adjacent sidecar/claim; for a directory resource use a protected in-directory claim. An existing claim for the same target may not be overwritten; roles or path nesting must not bypass resource collision detection. Ownership is not a public worktree/revision ID.
- Use per-resource cross-process atomic claim locks derived from the **physical resource target**, so different project roots and symlink aliases contend for the same lock. Do not rely solely on caller-specific `TMPDIR`. Acquire *all* required resource locks in globally stable canonical target order (deduplicating aliases) before reading or modifying claims. Failure to acquire any lock yields **refusal with zero new claim writes** for that attempt; release any already-held locks.
- **Validate first, publish second.** With all locks held, re-resolve persistent paths and verify *every* existing claim and existing data/empty-state requirement. Any foreign/malformed/untrusted claim, unexplained preexisting data, or inconsistent identity aborts admission before new claims are written. The complete intended claim set must pass validation before the first new claim is created; do not claim each resource as soon as its individual validation succeeds.
- Admit an **independent writer** only after all required lifetime writer leases are obtained, all ownership claims have been durably and successfully published/verified, and the complete target set is rechecked. The return of an opaque writer-admission handle (not individual claim-file presence) is the sole authorization to open stores, write PID, or publish an Endpoint. A discovery-only client never receives this handle.
- New claims are published with durable atomic create/no-overwrite semantics while still holding the full resource-lock set. Multiple files cannot be committed atomically by ordinary filesystem primitives: a failure or crash between publications may leave a **partial but valid** same-owner claim set. Such markers reserve only their own physical resources; they **do not** mean that the whole runtime was admitted or that any store write is authorized. Never claim all-or-nothing persistence across resources.
- **Claim contention:** if a contender finds a different owner's existing valid claim for *any* target, refuse the entire requested admission; do not touch other owners' claims, their data, or their Endpoint/PID. A failed contender writes no new claim after detecting that conflict.
- **Write failure during publication:** do not return the writer handle or open stores. Release all provisional writer leases/claim locks that belong to the failed attempt. Keep already valid claims intact for safely verified retry; malformed/truncated claims fail closed. Do not delete or overwrite a potentially concurrent or foreign claim to “roll back.”
- **Process crash:** claim locks and writer leases must be reclaimable only by bounded, verified stale recovery; persistent claims survive. A crash after a subset of claims but before returning a writer handle cannot be reported as a successful admission. No implicit ownership transfer occurs.
- **Same-owner retry after partial claim:** acquire the complete lock set afresh, validate all prior claims against the same canonical owner/target, validate all not-yet-claimed resources as safe to initialize, obtain writer leases, and publish missing claims before returning an admission handle. Do not infer success merely from the subset already present.
- **Different-owner retry after partial claim:** any overlap with an already claimed target fails closed, even if the previous writer crashed. Do not infer that partial claims are abandoned. If a different owner's admission concerns only *other*, still-unclaimed disjoint resources, it may proceed; later attempts that overlap must refuse rather than mix owners.
- Prevent active simultaneous writers to an overlapping persistent target (including same-owner/different-rootDir configurations). A bridge connecting to one already healthy same-owner managed runtime uses discovery preflight, not a second writer lease. Release writer leases on normal close; do not remove the durable claims on shutdown.

**Testable S07 invariant — no split ownership:** For every *successful* writer admission for target set `T`, all persistent targets in `T` must be verifiably claimed by its **single** canonical `ownerProjectRoot` and held by one writer admission. A losing or interrupted attempt must have no store-writing authority, and it must never mutate a foreign owner's existing resources. Partial same-owner reservations can remain after a failed attempt, but may never be treated as a successful multi-target admission. This is a safety property, not a promise of atomic multi-file claim commits, perfect cleanup, or progress for an abandoned claim.

If atomic lock acquisition across physical aliases, claim validation, and safe writer admission cannot be provided by a minimal mechanism, **stop at the Human Owner checkpoint** rather than adding a general transaction coordinator.

### 4.4 Shared admission interface and safe ordering (F-001/F-002)

Use one shared internal contract for CLI, `http-bridge`/Connector, and direct Runtime Assembly. Types below are **proposed design interfaces**, not present code or authorization to implement them:

```typescript
// CanonicalPath: validated absolute filesystem identity, not a raw input string.
type CanonicalPath = string & { readonly __canonicalPath: unique symbol };
type PersistentTarget = Readonly<{
  kind: 'persistent';
  path: CanonicalPath;
}>;
type VectorTarget = PersistentTarget | Readonly<{
  kind: 'ephemeral';
  source: 'memory://';
}>;

interface ResolvedStorageOwnershipTargets {
  readonly ownerProjectRoot: CanonicalPath;
  readonly rootDir: PersistentTarget;        // directory
  readonly metadataDbPath: PersistentTarget; // SQLite file
  readonly vectorDbPath: VectorTarget;       // persistent directory OR ephemeral
}

type OwnershipPreflight = Readonly<{
  targets: ResolvedStorageOwnershipTargets;
  disposition: 'owned' | 'unclaimed-clean' | 'refuse';
  reason?: string; // internal bounded diagnostic; no permission to mutate
}>;
interface WriterAdmission {
  readonly targets: ResolvedStorageOwnershipTargets;
  readonly release: () => Promise<void>; // live writer leases, idempotent
}

// No storage mutation, ownership claim or writer lease. Use for discovery.
interface StorageOwnershipAdmissionService {
  resolveStorageOwnershipTargets(config: Config): Promise<ResolvedStorageOwnershipTargets>;
  inspectStorageOwnership(targets: ResolvedStorageOwnershipTargets): Promise<OwnershipPreflight>;
  // Re-resolve/revalidate *all* targets under ordered locks, claim as needed,
  // and acquire live writer exclusion. Preflight alone is never authority.
  admitStorageWriter(targets: ResolvedStorageOwnershipTargets): Promise<WriterAdmission>;
}
```

Interface responsibility boundaries:

| Caller | Input / output | Required behavior |
| --- | --- | --- |
| `http-bridge.ts` | `loadConfig({ projectRoot, env })` -> `resolveStorageOwnershipTargets(config)` -> pass the **full `ResolvedStorageOwnershipTargets`** (and existing spawn/health dependencies) into `ProjectConnectorOptions` | The current rootDir-only Connector options are insufficient; do not reconstruct metadata/vector defaults from `rootDir` |
| `project-connector.ts` | Full targets -> `inspectStorageOwnership()` -> validated endpoint URL **or** permission to attempt managed spawn | Preflight happens **before** mkdir, descriptor removal, lock/side effects; only healthy matching-owner Endpoint may be reused. A foreign/unverifiable descriptor is never deleted. An allowed spawn is only a *request*, not a writer admission |
| Managed child `nexus.ts` and direct `nexus.ts`/reindex | Resolve from the child's **own effective config**, then call `admitStorageWriter()` -> `WriterAdmission` | Admission precedes `nexus.pid`, project lock, `ensureDirectories`, store open, logging, or endpoint publishing; release lease during shutdown/failure. Child revalidation is authoritative even when parent preflight succeeded |
| `runtime-assembly.ts` (direct library entry) | Effective `Config` -> shared targets/admission, or receive a still-valid transferred in-process `WriterAdmission` | Must not bypass ownership enforcement; avoid double admission when invoked from a CLI that already owns the handle; no duplicate writer lease |

The parent Bridge's full preflight and child admission may observe different configuration if environment/file state changes. The child must re-resolve and revalidate all targets and refuse on mismatch; the Bridge must re-evaluate ownership before reusing a discovered Endpoint. The URL, instanceId, PID and health checks remain necessary but are **not substitutes** for ownership preflight. Keep current external CLI/MCP flags unchanged; no new setting is required.

Preflight is read-only and reports `refuse` for a foreign or unknowable persistent owner, `owned` only for a trustworthy matching owner, and `unclaimed-clean` only when every unclaimed persistent target is provably safe for initial claim. An ephemeral vector does not require a claim but does not override the root/metadata result. A `refuse` result stops the operation without deleting descriptors or creating PID files. A preflight success can become stale immediately; it **never** authorizes writing, deleting an untrusted descriptor, or bypassing the child's writer admission.

Required ordering for new runtime startup:

```text
Resolve effective Config + canonical projectRoot
  -> resolve all three effective targets; classify exact memory:// as ephemeral
  -> inspect pre-existing persistent ownership (no mutation)
  -> acquire the complete ordered set of cross-process resource claim locks
  -> re-resolve/revalidate every persistent target and all existing claims
  -> obtain lifetime writer leases for the complete persistent target set
  -> publish/verify new durable claims while all claim locks remain held
  -> successful WriterAdmission handle
  -> create/lock owned runtime root (nexus.pid / project lock)
  -> StorageManager.ensureDirectories / initializeStores
  -> start runtime / publish healthy managed Endpoint
  -> release owned writer leases + transient locks on close or failure
```

For **discovery-only** bridge clients, resolve and inspect before attempting to attach to a healthy Endpoint. If no suitable Endpoint exists and preflight permits a fresh managed runtime, the Connector may coordinate a spawn; it still cannot become a writer. Any Connector cleanup of a stale *same-owner* descriptor must be conditioned on ownership being revalidated immediately before the owner-scoped mutation and must never remove a foreign or untrusted descriptor. The child's `admitStorageWriter()` is required before its first mutating startup action. A race with a competing claim must fail closed, never be treated as safe because of an earlier read-only preflight.

Today `src/bin/nexus.ts` creates `nexus.pid` before `createRuntimeAssembly()`, and `ensureProjectEndpoint()` may delete an invalid descriptor before taking its startup lock. A guard only inside runtime assembly would therefore be too late. Place ownership validation at all mutating entry boundaries and maintain one shared enforcement implementation. Creating minimum new directories/claim-lock files under controlled admission is not permission to modify an unknown pre-existing storage tree.

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
| S01 | Same explicit persistent storage root, different canonical project roots | Later startup fails before foreign descriptor/PID deletion or store writes |
| S02 | Distinct roots, identical metadata DB | Both cannot write shared SQLite, even when storage-root locks differ |
| S03 | Distinct roots, identical persistent vector DB | Both cannot write shared LanceDB, even when storage-root locks differ |
| S04 | Symlink aliases of each persistent target | Collision follows real paths, not lexical spelling |
| S05 | Disjoint custom root/metadata/persistent vector targets | Both run without regressions |
| S06 | Matching owner, sequential restart and stale same-owner endpoint | Safe reuse/recovery and preserved data, without deleting foreign state |
| S07 | Multi-resource reversed overlap, concurrent claim races, injection of claim-write failure and process crash | Under globally ordered locks, validate all claims before first publication; exactly one admission wins any conflicting resource; loser/partial claimant receives no writer authority; no **successful** admission has mixed owners; valid partial same-owner claims are retriable; different-owner overlap is refused; no foreign bytes are modified |
| S08 | Existing unclaimed populated storage, malformed claim, broken symlink, unwritable marker | Fail closed without auto-adoption, overwrite, or corruption |
| S09 | Different storage roots with a same-owner overlapping DB/vector | No simultaneous independent writers; existing healthy managed runtime can still be reused |
| S10 | Process crash and claim/writer-lock recovery | Durable owner survives and stale lock recovery does not transfer ownership to another root |
| S11 | Two sibling runtimes with `vectorDbPath='memory://'`, disjoint metadata/root | Both use runtime-private ephemeral vectors, no persistent vector claim, independent results, no forced filesystem-vector canonicalization |
| S12 | `vectorDbPath='memory://'` with shared root or metadata | Root or metadata collision still fails closed; ephemeral vector does not mask an unsafe persistent overlap |
| S13 | Bridge configured with nondefault metadata/vector paths and foreign endpoint descriptor | Connector preflight receives all three effective targets and refuses before descriptor deletion/spawn; child validates the same effective targets afresh; discovery-only does not acquire a writer lease |

Negative tests must inspect before/after storage bytes or metadata, ownership files, descriptor identity, PID, and live service state, not merely assert that an error was thrown. A parallel stress scenario should run several bounded iterations with process-level overlap; no sleeps as correctness oracles. Each test cleans only its own disposable fixture and never commits to the user's source repository.

## 6. Documentation contract

After behavior is implemented and verified, update **`SPEC.md`** to state: one canonical worktree root is one independently correct runtime; default storage isolation; the persistent root/metadata/vector target identities and existing ephemeral `memory://` vector exception; physical alias/ownership failure behavior; concurrent writer exclusion; same-owner restart; safe legacy-store limitations; deletion/recreation limitations or the validated guard; and explicit exclusions for shared cache/manager work.

Keep `SPEC.md` as the source of truth for architecture. Detail configuration knobs in `docs/configuration/storage-and-indexing.md` only if needed; do not create duplicate normative contracts or assert unimplemented guarantees in `SPEC.md` during this design-only correction.

## 7. Exit and stop conditions

**Issue #297 can close** only when W01–W07 and the relevant S01–S13 cases are executed and supported by evidence, collision attempts cannot corrupt/modify foreign runtime state, positive disjoint configurations and `memory://` remain usable, and the implemented contract is documented in `SPEC.md`. Existing tests count as evidence where their assertions demonstrably satisfy these cases; no automatic test duplication.

**Stop for Human Owner** if existing populated storage cannot be claimed safely without migration, same-path recreation needs a new incarnation identity, cross-process resource admission cannot be made atomic with a bounded mechanism, or current code reveals an unexpected independent bypass. Do not spawn follow-on reviews, fixes, PRs, or issues automatically.

**Current status:** F-001–F-003 limited design correction only. No runtime execution, collision repro, test pass, migration, implementation, `SPEC.md` update, GitHub Commit/Push, or final implementation authorization is claimed.
