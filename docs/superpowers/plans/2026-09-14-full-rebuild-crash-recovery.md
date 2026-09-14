# Full Rebuild Crash Recovery Implementation Plan

> **For agentic workers:** Execute inline in this session. No subagents are used.

**Goal:** Persist full-rebuild commit phases and recover SQLite, LanceDB, and Merkle state to one generation after restart.

**Architecture:** Extend the existing SQLite rebuild-backup record into a durable journal containing phase, deterministic LanceDB artifact names, and Merkle backup rows. The coordinator advances the journal after each external-store boundary. Startup reconciliation uses the journal to either restore every store or finish the new generation, then cleans all temporary artifacts.

**Tech Stack:** TypeScript, better-sqlite3, LanceDB, Vitest.

## Global Constraints

- Use Node.js >=24 and the repository `package-lock.json`.
- Preserve existing in-process rollback behavior.
- Do not delete a journal-referenced backup before recovery resolves it.
- Add regression tests before production changes.
- Do not modify unrelated worktree changes.

---

### Task 1: Durable journal types and schema

**Files:**
- Modify: `src/storage/interfaces/structured-catalog.ts`
- Modify: `src/storage/metadata-store.ts`
- Test: `tests/unit/storage/sqlite-structured-catalog.test.ts`

- [ ] Add typed phase and recovery-record interfaces, including epoch, phase, vector artifact names, and Merkle snapshot rows.
- [ ] Add schema migration for the journal phase/artifact columns and a keyed Merkle backup table.
- [ ] Add tests proving a prepared journal survives store close/reopen and stale rows from older epochs are removed when a new rebuild is prepared.
- [ ] Run `npx vitest run tests/unit/storage/sqlite-structured-catalog.test.ts` and confirm the new tests fail before implementation, then pass after implementation.

### Task 2: Vector artifact lifecycle and startup cleanup

**Files:**
- Modify: `src/storage/interfaces/vector-store.ts`
- Modify: `src/storage/vector-store.ts`
- Test: `tests/unit/storage/vector-store-orphan-shadow.test.ts`

- [ ] Make shadow, replacement, and backup names deterministic from the rebuild token while retaining the six reserved prefixes.
- [ ] Add vector recovery operations that restore or finalize the exact journal-referenced legacy and structured backups.
- [ ] Make `initialize()` delete only unreferenced temporary tables and preserve artifacts supplied by the active recovery record.
- [ ] Add tests for all six prefixes and assert `chunks` and `structured_chunks` remain intact.
- [ ] Run the focused vector tests and confirm they pass.

### Task 3: Coordinator phase persistence

**Files:**
- Modify: `src/indexer/pipeline.ts`
- Modify: `src/indexer/structured-index-coordinator.ts`
- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`
- Modify: `tests/unit/structured/structured-index-coordinator.test.ts`

- [ ] Pass a rebuild token and Merkle snapshot into the coordinator journal.
- [ ] Record phases after legacy swap, structured swap, catalog activation, Merkle activation, and successful finalization.
- [ ] Keep cleanup failures from converting a finalized generation into a rollback candidate.
- [ ] Add failure-injection tests for each phase boundary and finalization failure.
- [ ] Run both focused lifecycle suites.

### Task 4: Coordinated startup recovery

**Files:**
- Modify: `src/indexer/pipeline.ts`
- Modify: `src/storage/metadata-store.ts`
- Modify: `src/server/factory.ts`
- Modify: `src/server/index.ts`
- Test: `tests/integration/pipeline.test.ts`

- [ ] Resolve the durable journal only after metadata and vector stores are initialized.
- [ ] Roll back all three stores for pre-Merkle phases and finish cleanup for post-Merkle phases.
- [ ] Invoke structured row reconciliation after recovery.
- [ ] Add restart integration coverage for mixed-state crash windows.
- [ ] Run the integration test and verify the active generation, vector rows, and Merkle root agree.

### Task 5: Full verification and delivery

**Files:**
- Modify only files listed above.

- [ ] Run `npx vitest run`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Inspect `git diff`, `git status`, and recent history.
- [ ] Commit the intended changes with a Japanese Conventional Commit message.
- [ ] Push the current branch to its configured upstream.
