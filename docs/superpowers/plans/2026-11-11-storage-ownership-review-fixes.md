# Storage Ownership Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the confirmed storage-ownership, runtime-shutdown, startup-wait, bounded-log-read, documentation, and complexity findings while preserving established contracts.

**Architecture:** Keep ownership validation in the existing storage-ownership modules and thread cancellation/terminal state through existing runtime boundaries. Use handle-based filesystem checks and targeted helper extraction without changing public APIs or established verdict/order semantics.

**Tech Stack:** TypeScript, Node.js >=24, npm, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-storage-ownership-review-fixes-design.md`

## Global Constraints

- Keep indexing state local; do not enable external embedding or data transmission.
- Preserve existing ownership verdicts and operation order except for the stricter refusals and cancellation specified in the design.
- Do not modify generated local state (`.nexus/`), credentials, or machine-specific paths.
- Use TDD for behavior changes; retain existing byte, validation, and error contracts.

## Review Focus

- Admission released during target resolution: test that it is refused before the caller can proceed.
- Witness removed or changed during admission validation: test that witness-bound admission is rejected.
- Claim path replaced after `lstat`: test that opened inode mismatch is rejected.
- Runtime close/lease loss during an awaited initialization step: test no later metrics or reindex metadata mutation and ensure a started watcher stops.
- Child failure while endpoint polling is sleeping: test prompt cancellation and no remaining poll timer.

---

### Task 1: Admission revalidation and witness binding

**Files:**
- Modify: `src/server/storage-ownership/admission.ts`
- Test: `tests/unit/server/storage-ownership-admission.test.ts`

**Interfaces:**
- Consumes: `resolveStorageOwnershipTargets(config)`, `storageTargetsFingerprint(targets)`, `RegistryEntry`, `readWorktreeWitness`, `witnessRequired`.
- Produces: strengthened `assertLiveWriterAdmission(handle, config)`; no public signature change.

- [ ] **Step 1: Add failing tests**

Add tests that release an issued admission while target resolution is pending, lose one lease during that wait, and remove/change the witness for an admission whose persistent target is external. Assert each fails as `StorageOwnershipError` (`invalid_writer_admission` for state/lease failures; existing incarnation-related refusal for witness failures).

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts`
Expected: new tests fail because post-await state/lease and witness checks are absent.

- [ ] **Step 3: Revalidate admission after awaits**

In `assertLiveWriterAdmission`, after resolving fresh targets, re-check `entry.state === 'ISSUED'`, all `entry.leases` are held, and the fingerprint matches. When the admission bound a witness, require current witness evidence and exact equality before returning success.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts`
Expected: PASS.

### Task 2: Claim file identity-safe reads

**Files:**
- Modify: `src/server/storage-ownership/claim-format.ts`
- Test: `tests/unit/server/storage-ownership-admission.test.ts` (or the existing claim-format coverage location if present)

**Interfaces:**
- Consumes: existing `readOwnerClaim(claimPath)` contract.
- Produces: unchanged public return union; internal read via `FileHandle`.

- [ ] **Step 1: Add a race test**

Test claim parsing with a deterministic filesystem seam or controlled replacement so the opened file's `dev`, `ino`, or size differs from the `lstat` result. Assert the result is `invalid`, never `present`.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts`
Expected: FAIL because `readOwnerClaim` reads by path after `lstat`.

- [ ] **Step 3: Read through a no-follow handle**

Open with `O_RDONLY | O_NOFOLLOW`, compare handle `stat()` with the inspected regular file (including inode/device and size), read through that handle, and close it on every path. Reject changed identity/size through the existing invalid-claim result.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts`
Expected: PASS.

### Task 3: Coordination-root trusted ancestry and same-root lock use

**Files:**
- Modify: `src/server/storage-ownership/claims.ts`
- Test: `tests/unit/server/storage-ownership-admission.test.ts`, `tests/unit/server/storage-ownership-remote-fs.test.ts`

**Interfaces:**
- Consumes: `prepareCoordinationRoot(root, persistentTargets)`.
- Produces: unchanged return type; verify the parent is trusted and retain identity protection through lock-directory preparation/use.

- [ ] **Step 1: Add failing tests**

Test rejection of a parent directory owned by another uid or accessible to group/other, and a parent/root replacement between verification and lock use. Assert no lease is accepted under a substituted directory.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts tests/unit/server/storage-ownership-remote-fs.test.ts`
Expected: FAIL because parent trust and continuous identity protection are not enforced.

- [ ] **Step 3: Validate and pin trusted ancestry**

Validate the parent’s owner and permissions using existing private-directory checks or a narrow equivalent; use the repository’s established safe filesystem mechanism to keep the verified parent/root identity stable through lock use. Preserve overlap and filesystem checks.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts tests/unit/server/storage-ownership-remote-fs.test.ts`
Expected: PASS.

### Task 4: Preflight ancestor claim validation and responsibility extraction

**Files:**
- Modify: `src/server/storage-ownership/preflight.ts`
- Test: `tests/unit/server/storage-ownership-preflight.test.ts`

**Interfaces:**
- Consumes: `evaluate(resource, all, owner, binding)` and `checkAncestors`.
- Produces: same `Verdict` results; focused internal helpers for existing-claim and unclaimed-content evaluation.

- [ ] **Step 1: Add failing ancestor-claim tests**

Cover an ancestor claim with matching owner/witness but wrong `resourcePath`, and one with matching owner/witness but `kind: 'file'`. Both must refuse. Preserve tests for verdict priority and unclaimed-directory contents.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `npx vitest run tests/unit/server/storage-ownership-preflight.test.ts`
Expected: FAIL for malformed ancestor claims.

- [ ] **Step 3: Validate ancestor identity and extract helpers**

Require each present ancestor claim’s `resourcePath` to equal `dir` and `kind` to be `directory`. Extract existing-claim evaluation and unclaimed-resource content checks from `evaluate`, retaining ancestor-first ordering and every existing verdict.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/server/storage-ownership-preflight.test.ts`
Expected: PASS.

### Task 5: Runtime terminal state across close and lease loss

**Files:**
- Modify: `src/server/runtime-assembly.ts` and the runtime initialization implementation reached by `runtime.initialize()`.
- Test: `tests/unit/server/runtime.test.ts`, `tests/unit/server/runtime-auto-index.test.ts` (add or extend the most relevant existing suite).

**Interfaces:**
- Consumes: `NexusRuntime.initialize()`, runtime `onClose`, `IndexPipeline`, watcher start/stop.
- Produces: internal permanent terminal-state guard; no public API change.

- [ ] **Step 1: Add failing lifecycle tests**

Close or simulate lease loss while initialization is blocked at an awaited operation. After unblocking, assert no metrics-port write or startup-reindex metadata update occurs. Also assert a watcher started before termination is stopped and a later `initialize()` does no work.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/unit/server/runtime.test.ts tests/unit/server/runtime-auto-index.test.ts`
Expected: FAIL because terminal state is not persistent across initialization continuations.

- [ ] **Step 3: Record terminal state and guard async boundaries**

Set the permanent closed/terminated state synchronously from the shared close and lease-loss paths. Check it before initialization begins and immediately after awaited boundaries that precede metrics-port or startup-reindex metadata mutations. Stop any already-started watcher during shutdown.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/server/runtime.test.ts tests/unit/server/runtime-auto-index.test.ts`
Expected: PASS.

### Task 6: Endpoint polling cancellation

**Files:**
- Modify: `src/server/project-connector.ts`
- Test: `tests/unit/server/project-connector.test.ts`

**Interfaces:**
- Consumes: existing endpoint polling and ownership preflight/wait path.
- Produces: private cancellation signal passed through preflight and endpoint polling; existing result behavior when not cancelled.

- [ ] **Step 1: Add failing child-failure cancellation test**

Make the child fail while health polling is waiting. Assert connector rejection occurs promptly, polling stops, and the outstanding timeout is cleared. Add cancellation during ownership preflight coverage if the path can be held at an await.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `npx vitest run tests/unit/server/project-connector.test.ts`
Expected: FAIL because polling is not cancelled when `childFailure` wins.

- [ ] **Step 3: Thread cancellation through polling**

Pass an `AbortSignal` to ownership preflight/wait and `waitForHealthyEndpoint`; implement abort-aware sleep with timer/listener cleanup on resolve, reject, and abort. Abort when child failure is definitive.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/server/project-connector.test.ts`
Expected: PASS.

### Task 7: Bounded startup-log tail reads

**Files:**
- Modify: `src/server/storage-ownership/startup-gate.ts`
- Test: `tests/unit/bin/http-bridge.test.ts` or a focused startup-gate test in `tests/unit/server/`.

**Interfaces:**
- Consumes: `readAttemptLog(path)` and its caller’s existing maximum output length.
- Produces: same string behavior, using only the bounded file tail.

- [ ] **Step 1: Add bounded-read tests**

Test a log shorter than the limit and a log larger than the limit, asserting the returned content matches the existing tail semantics. Verify the implementation reads no more than the configured limit plus only the minimum needed for UTF-8 boundary handling.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `npx vitest run tests/unit/bin/http-bridge.test.ts`
Expected: FAIL because `readAttemptLog` reads the entire file.

- [ ] **Step 3: Read from the end using a file descriptor**

Open the log, determine its size, read only the trailing bounded bytes, preserve UTF-8 decoding and missing-file behavior, and close the descriptor in all cases.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/bin/http-bridge.test.ts`
Expected: PASS.

### Task 8: Complexity-only helper extraction

**Files:**
- Modify: `src/server/storage-ownership/claims.ts`, `src/server/storage-ownership/preflight.ts`, `src/server/storage-ownership/witness.ts`
- Test: `tests/unit/server/storage-ownership-admission.test.ts`, `tests/unit/server/storage-ownership-preflight.test.ts`, `tests/unit/server/storage-ownership-witness.test.ts`

**Interfaces:**
- Consumes: functions and behavioral contracts established by Tasks 2–4.
- Produces: private helpers for `mkdirVerified` ancestor discovery/post-create verification, `/proc/locks` row matching, preflight sub-decisions, and witness bounded reading/JSON validation.

- [ ] **Step 1: Identify and add any missing behavior-locking tests**

Before refactoring, ensure existing tests cover ancestor search and create/verify sequencing, lock rows (holder vs waiter, type/mode/PID/device/inode), all current preflight verdicts, and witness size/shape/error behavior. Add only missing observable cases.

- [ ] **Step 2: Run all three focused suites**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts tests/unit/server/storage-ownership-preflight.test.ts tests/unit/server/storage-ownership-witness.test.ts`
Expected: PASS before refactoring.

- [ ] **Step 3: Extract helpers without changing behavior**

Separate the specified responsibilities into private helpers. Keep directory creation and verification sequential, `/proc/locks` retries unchanged, preflight verdict precedence unchanged, and witness limits and error results unchanged.

- [ ] **Step 4: Run focused suites**

Run: `npx vitest run tests/unit/server/storage-ownership-admission.test.ts tests/unit/server/storage-ownership-preflight.test.ts tests/unit/server/storage-ownership-witness.test.ts`
Expected: PASS with the same tested decisions.

### Task 9: Ownership contract documentation

**Files:**
- Modify: `SPEC.md`
- Test: `tests/unit/server/storage-ownership-admission.test.ts` (existing behavioral coverage; no prose assertion)

**Interfaces:**
- Consumes: admission semantics implemented in Tasks 1–4.
- Produces: corrected ownership contract distinguishing partial claims from empty unclaimed bootstrap directories.

- [ ] **Step 1: Update admission-failure wording**

State that partial claims for the same owner remain unavailable to a different owner. Separately state that unclaimed empty bootstrap directories remain ownership-neutral and may be obtained by another owner only after complete revalidation.

- [ ] **Step 2: Review the documentation against implementation**

Run: `git diff --check`
Expected: no whitespace errors; wording accurately reflects admission tests and code.

### Task 10: Full verification and delivery

**Files:**
- Verify all files changed in Tasks 1–9.

- [ ] **Step 1: Run full validation**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `npx vitest run`
Expected: all commands exit successfully.

- [ ] **Step 2: Review final diff and worktree**

Run: `git diff --check` and inspect `git status --short`, `git diff`, and `git log --oneline -10`.
Expected: only intended files changed; no generated local state or secrets included.

- [ ] **Step 3: Commit and push**

Stage only the approved design, plan, implementation, and test files. Commit using the repository’s Japanese Conventional Commit convention, then push the current branch to its configured upstream. Report commit hash and push result.
