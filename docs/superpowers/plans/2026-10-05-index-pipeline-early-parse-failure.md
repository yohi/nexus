# Early structured parse failure abort for full rebuild — Implementation Plan

> **For agentic workers:** Execute tasks in order. The primary regression test must be observed failing before production code is changed. Do not skip RED verification if implementation already exists; investigate and restore the pre-change baseline in an isolated worktree or equivalent before proceeding. Commit only when explicitly requested by the task owner.

**Goal:** Change `src/indexer/pipeline.ts` so a structured full rebuild aborts on the first window containing a structured parse failure, before embedding that window.

**Architecture:** `processEventWindow` detects parse failures after Stage 1 (read and chunk). When `structuredRebuildFiles !== undefined` and failures exist, it returns an explicit early result without entering embedding or write stages. `processEvents` owns legacy shadow abort and throws the unchanged error before aggregating the failed window. Incremental processing continues its existing DLQ behavior.

**Spec:** `docs/superpowers/specs/2026-10-05-index-pipeline-early-parse-failure-design.md`

**Global constraints:** Do not change public interfaces or the final error string. Deduplicate parse-failure paths while preserving encounter order. Do not introduce `as any` or `@ts-ignore`. Do not commit unless explicitly requested.

**Final error:** `Structured full rebuild aborted: parsing failed for <file>` (comma-and-space separated paths for multiple failures).

---

## Task 1: RED — Add the primary later-window full-rebuild regression test

**Dependency:** None. Must finish RED verification before Task 2 starts.

**Files:**

- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

**Interfaces / types:**

- Consume existing `IndexPipeline`, `createStructuredPipeline`, `TestEmbeddingProvider`, `Chunker`, `createEvent`, `indexContent`, metadata/vector store APIs, and `vi` from the target test file/imports.
- Produce a test-local `CountingEmbeddingProvider extends TestEmbeddingProvider` with a `calls` counter and `override async embed(texts: string[]): Promise<number[][]>` that increments once per invocation before delegating to `super.embed(texts)`.
- Do not rely on the file-local `CountingEmbeddingProvider` in `pipeline.test.ts` or `pipeline-windowed.test.ts`; neither is exported to this test module.

**RED test:** Add a test that seeds an existing index, then runs a structured full rebuild with `embedBatchWindowSize: 2`: two healthy files occupy the first window, a parse-failing file and a healthy file occupy the failing second window, and another healthy file is in a third window. Track calls to the read callback and spy on `abortLegacyShadowTable`. Assert all of the following:

- Rejects with the exact error `Structured full rebuild aborted: parsing failed for ${brokenFilePath}`.
- `embed()` is called exactly once, for the first healthy window; it is not called for the failing window.
- The third-window file is never read, proving later windows are not processed.
- `abortLegacyShadowTable` is called exactly once.
- Pre-existing legacy vectors (`vectorStore.getStats()`), Merkle state (`metadataStore.getAllNodes()`), and active structured generations are unchanged from their seeded snapshots.

**RED command:**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "aborts a full rebuild and discards the shadow table when a later window has a parse failure"
```

**Expected failure:** The current implementation reaches embedding for the parse-failing window (or fails one of the associated assertions); it must fail because the early-abort behavior is absent, not because the test cannot compile or its fixture/setup is invalid. Fix test setup errors until this specific behavioral failure is observed. Record the failure before implementing production changes.

**Minimum GREEN:** None in this task; do not modify production files.

**GREEN command:** The RED command above, rerun after Task 2.

**Expected success:** Task 1 test passes after Task 2 and reports no test compilation/setup errors.

**REFACTOR:** Keep the helper local and minimal; avoid unrelated test cleanup. Any test-only refactor must retain the observed RED evidence and pass the GREEN command.

**Commit boundary:** Test-only commit is optional and only when explicitly requested; otherwise include this test with the implementation commit at Task 2.

---

## Task 2: GREEN — Return an explicit early result and abort the structured rebuild

**Dependency:** Task 1 completed with the expected behavioral RED observed.

**Files:**

- Modify: `src/indexer/pipeline.ts` (`ProcessEventWindowResult`, `processEventWindow`, and `processEvents` window loop)

**Interfaces / types:**

- Consume the existing `ProcessEventWindowResult`, `structuredRebuildFiles?: FullRebuildFile[]`, `works`, and legacy shadow lifecycle.
- Add `parseFailures: readonly string[]` and `shouldAbortStructuredFullRebuild: boolean` to the internal `ProcessEventWindowResult`; do not change public interfaces.
- Produce a result with the new fields on every return path.

**Minimum GREEN implementation:**

1. Immediately after Stage 1 produces `works`, compute deduplicated parse-failure paths in encounter order and set `shouldAbortStructuredFullRebuild` to `structuredRebuildFiles !== undefined && parseFailures.length > 0`.
2. If true, return immediately at that point with exactly `chunksIndexed: 0`, `embeddingFailures: []`, `parseFailures`, and `shouldAbortStructuredFullRebuild: true`. Do not reference `chunksIndexed` or `failedFilePaths` here: their declarations occur later in the normal Stage 3 / Stage 2 path.
3. On the normal path, include `parseFailures` and `shouldAbortStructuredFullRebuild: false` in the final result alongside the existing `chunksIndexed` and `[...failedFilePaths]` values.
4. Immediately after `processEvents` receives a window result, check `!this.abortController.signal.aborted && useStructuredFullRebuild && windowResult.shouldAbortStructuredFullRebuild`; on true, attempt to abort `legacyShadow` once when present, treating abort rejection as best-effort, clear the local shadow reference, and then throw the unchanged error using the deduplicated paths. Do this before aggregating the window result or entering any later window. If cancellation has already been requested, skip this early parse-failure throw so `stop()` retains precedence; preserve the existing shadow-abort cleanup for non-parse-failure cancellation.
5. Preserve the existing late parse-failure safety check.

**RED test:** Task 1 regression test.

**RED command:** Task 1 focused Vitest command; required observed failure is recorded in Task 1.

**Expected failure:** Before implementation, the test fails because embedding occurs for the parse-failing window or another early-abort assertion fails.

**GREEN command:**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "aborts a full rebuild and discards the shadow table when a later window has a parse failure"
```

**Expected success:** The regression test passes; no embedding call occurs for the failing window, later windows are not read, the shadow is aborted, and seeded state remains unchanged.

**REFACTOR:** Once GREEN, simplify only local result construction if it remains explicit about early versus normal values. Preserve the stage boundary, order-preserving deduplication, and safety-net check. Rerun the GREEN command after any refactor.

**Commit boundary:** One implementation-and-regression-test commit, only if explicitly requested. Stage only `src/indexer/pipeline.ts` and `tests/unit/indexer/pipeline-structured-lifecycle.test.ts` for that commit.

---

## Task 3: Verify incremental DLQ behavior with structured indexing enabled

**Dependency:** Task 2 GREEN.

**Files:**

- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

**Interfaces / types:**

- Consume existing `createStructuredPipeline`, `IndexPipeline`, `Chunker`, `TestEmbeddingProvider`, event helpers, and `metadataStore.getDeadLetterEntries()`.
- Produce an incremental-path regression test; do not add another provider helper unless the assertion needs an embed count.

**RED test:** Run this test against the pre-change baseline before relying on it as regression coverage. If the existing behavior already passes, record the baseline as a passing characterization rather than claiming a RED; Task 1 remains the mandatory RED gate for this behavior change. The test uses a parse-failing fixture and a healthy file with `fullRebuild: false`, and asserts `processEvents` resolves without throwing, the healthy file is indexed, and exactly the failing file is in the DLQ with a parse-related error.

**RED command:**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "routes parse failure to DLQ in incremental indexing"
```

**Expected failure:** If behavior regresses, the test fails on throw, missing healthy indexing, or missing/incorrect DLQ entry. On the current baseline it may pass; that pass is a characterization and does not replace Task 1's required RED.

**Minimum GREEN:** Keep the full-rebuild early-abort condition gated by `structuredRebuildFiles !== undefined`; incremental processing must continue through existing DLQ handling and healthy-file indexing.

**GREEN command:** The same focused command above.

**Expected success:** `processEvents` does not throw, the healthy file is indexed, and the parse-failing file is enqueued to DLQ.

**REFACTOR:** Keep assertions limited to the stated incremental contract; rerun the focused command after changes.

**Commit boundary:** Test-only commit is optional and only when explicitly requested; otherwise include it with the related implementation/test commit. Stage only the target test file.

---

## Task 4: Full verification and final review

**Dependency:** Tasks 1–3 complete; Tasks 1 and 2's RED/GREEN evidence recorded.

**Files:** No additional files; verify the changes from Tasks 1–3.

**Interfaces / types:** Verify internal `ProcessEventWindowResult` fields, unchanged public API, unchanged error contract, and consistent spec/plan terminology and test requirements.

**RED test:** The required RED was observed in Task 1 before production changes. Do not rerun the test against the completed implementation and label a pass as RED.

**RED command:** Task 1 focused Vitest command, as recorded before Task 2.

**Expected failure:** The recorded pre-implementation run fails specifically on the missing early-abort behavior.

**Minimum GREEN:** No further implementation. Run the checks below and correct any failures within the approved source/test scope only when executing the implementation plan; this document-only review task itself must not change source/test files.

**GREEN commands (run all):**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "aborts a full rebuild and discards the shadow table when a later window has a parse failure"
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "routes parse failure to DLQ in incremental indexing"
npx tsc --noEmit
npm run lint
npx vitest run tests/unit/indexer/
npm test
```

**Expected success:** Each command exits successfully; both focused contracts, the indexer suite, type check, lint, and final repository test command pass.

**REFACTOR:** No further code refactor in this verification task. If implementation refactoring was necessary earlier, rerun the relevant focused tests and all full checks.

**Commit boundary:** After verification, create commits only when explicitly requested. Keep documentation-only review-gate corrections separate from any later source/test implementation commits.

---

## Self-review coverage

- Full-rebuild early return uses only values available after Stage 1 and returns zero indexed chunks with no embedding failures: Task 2.
- RED observed before production implementation; no optional “already implemented” escape: Task 1, enforced by Task 2 dependency.
- Failing-window embedding avoidance, no later windows, exact error, shadow abort, legacy vectors, Merkle state, and active generations: Task 1.
- Incremental parse failure goes to DLQ, healthy file indexes, and `processEvents` does not throw: Task 3.
- Type check, lint, indexer suite, and final `npm test`: Task 4.
- Design flow and implementation responsibility agree: spec Data flow and Tasks 1–4.
