# Ripgrep Quality Adapter Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the four confirmed quality-adapter findings without changing unrelated benchmark behavior.

**Architecture:** Keep the lazy ripgrep initialization and adapter API. Classify post-launch aborts from the request signal, expose the initialized digest dynamically, derive snapshot completeness without letting an uninitialized snapshot taint later evidence, and remove only the dead/unreferenced code identified in review.

**Tech Stack:** TypeScript, Node.js >=24, Vitest.

**Spec:** User-approved findings in the conversation on 2026-11-23.

## Global Constraints

- Limit code changes to `tests/benchmarks/quality/adapters.ts` and its unit test file.
- Preserve lazy initialization and the existing public return shapes.
- Keep pre-aborted signals spawn-free; classify timeout versus cancellation from the signal reason.
- Do not change unrelated quality benchmark behavior or generated state.
- Use Japanese Conventional Commit messages and push the existing branch as requested.

## Review Focus

- A timeout abort after ripgrep launches must produce `timeout` / `RG_TIMEOUT`.
- A non-timeout abort after ripgrep launches must produce `cancelled` / `REQUEST_CANCELLED`.
- A pre-invocation snapshot remains incomplete at that moment but must not taint evidence after successful initialization.
- The public execution-contract digest must equal the initialized digest after the first invocation.
- Default-root initialization and normalized argv must remain unchanged after dead-code cleanup.

---

### Task 1: Classify in-flight ripgrep aborts

**Files:**

- Modify: `tests/benchmarks/quality/adapters.ts`
- Test: `tests/unit/benchmarks/quality/adapters.test.ts`

**Interfaces:**

- Consumes: `spawnRg(..., signal)` and `isTimeoutSignal(signal)`.
- Produces: `invokeRgSearch()` observations with `timeout` or `cancelled` status when the signal aborts after launch.

- [x] **Step 1: Add failing integration tests**

Run a temporary executable that reports a valid ripgrep version, signals that its search has started, then remains active. Abort it once started with a `TimeoutError` and with a normal abort; assert respectively `timeout` / `RG_TIMEOUT` and `cancelled` / `REQUEST_CANCELLED`.

- [x] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/unit/benchmarks/quality/adapters.test.ts`
Expected: the new in-flight tests fail because they currently return `error` with `SPAWN_FAILED` or `RG_EXIT_2`.

- [x] **Step 3: Classify the completed spawn result using the signal**

After recording a launched spawn, check whether the supplied signal is aborted and return the matching timeout/cancelled observation before processing child error or exit-code branches.

- [x] **Step 4: Run the focused tests**

Run: `npx vitest run tests/unit/benchmarks/quality/adapters.test.ts`
Expected: PASS, including the pre-aborted signal regression test.

- [x] **Step 5: Commit**

Commit the adapter and test changes as `fix: ripgrep実行中の中断を正しく分類`.

### Task 2: Keep execution evidence accurate across snapshots

**Files:**

- Modify: `tests/benchmarks/quality/adapters.ts`
- Test: `tests/unit/benchmarks/quality/adapters.test.ts`

**Interfaces:**

- Consumes: the lazy `init()` state and `RgExecutionSnapshot`.
- Produces: a live `rgExecutionContractDigest` property and snapshots whose completeness reflects current evidence without mutating persistent evidence state.

- [x] **Step 1: Add failing regression tests**

Assert that `rgExecutionContractDigest` matches `snapshotRgExecution().initializedContractDigest` after the first successful invoke. Extend the zero-call snapshot test to assert it is incomplete before initialization but complete after a successful invoke.

- [x] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/unit/benchmarks/quality/adapters.test.ts`
Expected: the digest remains the uninitialized value and the post-invoke snapshot remains incomplete.

- [x] **Step 3: Publish and derive current evidence state**

Expose the digest through a getter that reads `initializedContractDigest`. Keep snapshot-time initialization/count checks local to the returned snapshot instead of latching them into `evidenceComplete`.

- [x] **Step 4: Run the focused tests**

Run: `npx vitest run tests/unit/benchmarks/quality/adapters.test.ts`
Expected: PASS, including existing invalid-trace fail-closed and zero-call snapshot assertions.

- [x] **Step 5: Commit**

Commit the adapter and test changes as `fix: quality adapterの実行証跡を正しく公開`.

### Task 3: Remove dead and unused ripgrep setup code

**Files:**

- Modify: `tests/benchmarks/quality/adapters.ts`
- Test: `tests/unit/benchmarks/quality/adapters.test.ts`

**Interfaces:**

- Consumes: the existing default root key, normalized ripgrep argv, and canonicalized root.
- Produces: unchanged behavior with no self-relative root check or unused declarations/parameters.

- [x] **Step 1: Confirm the existing behavior baseline**

Run the focused unit test before the cleanup. This task is a behavior-preserving deletion/unused-symbol cleanup, so no new runtime test can distinguish it from the existing implementation.

- [x] **Step 2: Implement the behavior-preserving cleanup**

Use `DEFAULT_ROOT_KEY` for the root-key fallback, remove the tautological `relative(resolved, resolved)` guard, and remove the unused `publicQuery` parameter from `sanitizedRgArgv`.

- [x] **Step 3: Run focused tests and static checks**

Run: `npx vitest run tests/unit/benchmarks/quality/adapters.test.ts && npx tsc --noEmit`
Expected: PASS; existing tests preserve default root and argv behavior.

- [ ] **Step 4: Commit**

Commit the adapter cleanup as `refactor: ripgrepアダプターの未使用処理を整理`.

### Final verification

- [ ] Run the complete project test suite with `npm test`.
- [ ] Run `npm run lint` and inspect the final diff and working-tree state.
- [ ] Push the committed changes to the existing branch's configured upstream without force-pushing.
