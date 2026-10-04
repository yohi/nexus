# Early structured parse failure abort for full rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `nexus/src/indexer/pipeline.ts` so that a structured full rebuild aborts on the first window containing a structured parse failure, before any embedding calls are made for that window.

**Architecture:** Add `parseFailures: string[]` and `shouldAbortStructuredFullRebuild: boolean` to `ProcessEventWindowResult`. Populate them inside `processEventWindow` after read-and-chunk. If the caller passed `structuredRebuildFiles` (full-rebuild mode) and the window has parse failures, return immediately before embedding or writes. `processEvents` checks `useStructuredFullRebuild && windowResult.shouldAbortStructuredFullRebuild` after each window and, if true, aborts the legacy shadow table and throws the existing error message.

**Tech Stack:** TypeScript, Node.js >=24, Vitest, `proper-lockfile`, Better-SQLite3.

**Spec:** `docs/superpowers/specs/2026-10-05-index-pipeline-early-parse-failure-design.md`

## Global Constraints

- Type error suppression (`as any`, `@ts-ignore`) is forbidden.
- Never leave code in a broken state after failures.
- Commit only when explicitly requested.
- Match existing test patterns in `tests/unit/indexer/`.

## Review Focus

- A non-full-rebuild run with the structured index coordinator active still routes parse failures to the DLQ and indexes other files.
- The final error message remains unchanged: `Structured full rebuild aborted: parsing failed for ...`.
- The embedding provider is not called for a window that contains a parse failure, and no later windows are processed.
- Multiple parse failures across one window are deduplicated in the error message.
- Legacy shadow table is aborted cleanly on early failure.

---

### Task 1: Return parse failures from each window

**Files:**
- Modify: `src/indexer/pipeline.ts:70-72` (`ProcessEventWindowResult` interface)
- Modify: `src/indexer/pipeline.ts:561-834` (`processEventWindow`)
- Modify: `src/indexer/pipeline.ts:348-371` (`processEvents` loop)

**Interfaces:**
- Consumes: existing `ProcessEventWindowResult` from `processEventWindow`.
- Produces: `ProcessEventWindowResult` with new fields `parseFailures: string[]` and `shouldAbortStructuredFullRebuild: boolean`.

- [ ] **Step 1: Add `parseFailures: string[]` and `shouldAbortStructuredFullRebuild: boolean` to `ProcessEventWindowResult`**

```typescript
interface ProcessEventWindowResult {
  chunksIndexed: number;
  embeddingFailures: string[];
  parseFailures: string[];
  /** Whether any parse failure should abort the full rebuild before embedding. */
  shouldAbortStructuredFullRebuild: boolean;
}
```

- [ ] **Step 2: Collect parse failures inside `processEventWindow`**

After the `works` array is produced, collect any `work.structuredParseFailed` file paths into a deduplicated array. Compute `shouldAbortStructuredFullRebuild` using the full-rebuild signal (`structuredRebuildFiles !== undefined`), not merely the presence of `structuredParseFailures`. If `shouldAbortStructuredFullRebuild` is true, return the window result immediately before building `toEmbed` or performing any embedding or writes. Otherwise continue as today and include the fields in the final return object:

```typescript
const parseFailures = [...new Set(
  works.filter((work) => work.structuredParseFailed).map((work) => work.event.filePath)
)];
const shouldAbortStructuredFullRebuild = structuredRebuildFiles !== undefined && parseFailures.length > 0;
const windowResult = {
  chunksIndexed,
  embeddingFailures: [...failedFilePaths],
  parseFailures,
  shouldAbortStructuredFullRebuild,
};
if (shouldAbortStructuredFullRebuild) {
  return windowResult;
}
// existing toEmbed construction, embedding, and writes continue below
```

- [ ] **Step 3: Update the `processEventWindow` call site in `processEvents`**

Read the new `parseFailures` and `shouldAbortStructuredFullRebuild` fields from `windowResult`.

- [ ] **Step 4: Run the indexer unit tests to confirm existing behavior is intact**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts tests/unit/indexer/pipeline-structured-lifecycle.test.ts`
Expected: pass (or existing failures unchanged), especially existing structured parse failure → DLQ tests.

- [ ] **Step 5: Commit when explicitly requested**

If the user explicitly requested a commit for this task, run:

```bash
git add src/indexer/pipeline.ts
git commit -m "feat(indexer): return structured parse failures per window"
```

---

### Task 2: Abort full rebuild early on parse failure

**Files:**
- Modify: `src/indexer/pipeline.ts:348-423` (`processEvents` window loop)

**Interfaces:**
- Consumes: `ProcessEventWindowResult.shouldAbortStructuredFullRebuild` and `parseFailures` from Task 1.
- Produces: unchanged public interface; internal early-throw behavior.

- [ ] **Step 1: Insert early-parse-failure check after each window result in `processEvents`**

Immediately after receiving `windowResult` inside the `for` loop, before aggregating per-window counts:

```typescript
if (useStructuredFullRebuild && windowResult.shouldAbortStructuredFullRebuild) {
  if (legacyShadow !== undefined) {
    await this.options.vectorStore.abortLegacyShadowTable(legacyShadow).catch(() => {});
    legacyShadow = undefined;
  }
  const filePaths = [...new Set(windowResult.parseFailures)].join(', ');
  throw new Error(`Structured full rebuild aborted: parsing failed for ${filePaths}`);
}

// Existing per-window result aggregation (unchanged):
chunksIndexed += windowResult.chunksIndexed;
embeddingFailures.push(...windowResult.embeddingFailures);
```

- [ ] **Step 2: Keep the existing late parse-failure check as a safety net**

The late check at lines ~372-380 is now unreachable in normal full-rebuild flows, but retaining it prevents a future code path from silently committing a partial structured rebuild if `structuredParseFailures` is populated without the full-rebuild flag. Do not remove it.

- [ ] **Step 3: Run type check and linter**

Run: `npx tsc --noEmit`
Expected: no type errors.
Run: `npm run lint`
Expected: no lint errors.

- [ ] **Step 4: Run the indexer unit tests**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts tests/unit/indexer/pipeline-structured-lifecycle.test.ts`
Expected: pass.

- [ ] **Step 5: Commit when explicitly requested**

If the user explicitly requested a commit for this task, run:

```bash
git add src/indexer/pipeline.ts
git commit -m "feat(indexer): abort structured full rebuild on first parse failure"
```

---

### Task 3: Add test verifying shadow table discard and no later-window processing

**Files:**
- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `createStructuredPipeline`, `CountingEmbeddingProvider`, `indexContent`, `createEvent`, and event helpers from the test file.
- Produces: a new test case that asserts early abort behavior and shadow table cleanup.

- [ ] **Step 1: Locate the existing test for structured parse failures and full rebuild**

Use grep:

```bash
grep -n "structuredParseFailed\|parseFailure\|fullRebuild" tests/unit/indexer/pipeline-structured-lifecycle.test.ts
```

- [ ] **Step 2: Write a failing test that asserts the shadow table is discarded for a later-window parse failure**

Seed an existing index first so the test can distinguish between a clean store and a properly aborted shadow table. Use `embedBatchWindowSize: 2` so the first window of healthy files completes and writes to the legacy shadow table, while the parse-failing file lands in a second window and triggers the abort. Ensure there is also a third window by adding one more healthy file after the broken file; that third-window file must remain unread and unembedded. Assert:

- `processEvents` rejects with the exact message `Structured full rebuild aborted: parsing failed for ${brokenFilePath}`.
- The legacy shadow table is aborted (`abortLegacyShadowTable` is called).
- The counting embedding provider is called exactly once (for the first healthy window only).
- The third-window file is never read.
- The pre-existing index remains unchanged: vector store stats, Merkle state, and active structured generations match the seeded state.

Example:

```typescript
it('aborts a full rebuild and discards the shadow table when a later window has a parse failure', async () => {
  const {
    metadataStore,
    vectorStore,
    pluginRegistry,
    coordinator,
    pipeline: seedPipeline,
  } = await createStructuredPipeline();
  const brokenFilePath = resolve('tests/fixtures/structured/typescript/malformed.ts');
  const brokenContent = await readFile(brokenFilePath, 'utf8');
  const stablePath = 'src/stable.ts';
  const stableContent = 'export function stable(): number { return 1; }\n';
  const okPath = 'src/ok.ts';
  const okContent = 'export const ok = 1;\n';
  const laterPath = 'src/later.ts';
  const laterContent = 'export const later = 2;\n';

  const plugin = pluginRegistry.getLanguagePlugin(brokenFilePath);
  if (plugin?.createStructuredParser === undefined) {
    throw new Error('TypeScript structured parser is unavailable');
  }

  await indexContent(seedPipeline, 'added', stablePath, stableContent);
  const statsBefore = await vectorStore.getStats();
  const merkleBefore = await metadataStore.getAllNodes();
  const generationsBefore = [...(await metadataStore.getStructuredIndexState()).activeGenerations.entries()];
  const abortLegacyShadowTableSpy = vi.spyOn(vectorStore, 'abortLegacyShadowTable');

  const countingProvider = new CountingEmbeddingProvider();
  const customPipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    embeddingProvider: countingProvider,
    pluginRegistry,
    structuredIndexCoordinator: coordinator,
    embedBatchWindowSize: 2,
  });

  const readFiles: string[] = [];
  const readFileForPipeline = async (filePath: string) => {
    readFiles.push(filePath);
    if (filePath === brokenFilePath) return brokenContent;
    if (filePath === stablePath) return stableContent;
    if (filePath === okPath) return okContent;
    return laterContent;
  };

  await expect(
    customPipeline.processEvents(
      [
        createEvent('added', stablePath, stableContent),
        createEvent('added', okPath, okContent),
        createEvent('added', brokenFilePath, brokenContent),
        createEvent('added', laterPath, laterContent),
        createEvent('added', 'src/after.ts', 'export const after = 3;\n'),
      ],
      readFileForPipeline,
      { fullRebuild: true, trackProgress: false },
    ),
  ).rejects.toThrow(`Structured full rebuild aborted: parsing failed for ${brokenFilePath}`);

  expect(abortLegacyShadowTableSpy).toHaveBeenCalledOnce();
  expect(countingProvider.calls).toBe(1);
  expect(readFiles).not.toContain('src/after.ts');
  expect(await vectorStore.getStats()).toEqual(statsBefore);
  expect(await metadataStore.getAllNodes()).toEqual(merkleBefore);
  expect([...(await metadataStore.getStructuredIndexState()).activeGenerations.entries()]).toEqual(generationsBefore);
});
```

- [ ] **Step 3: Run the new test and verify it fails before Task 2 is implemented (or passes if Task 2 is already done)**

Run: `npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "aborts a full rebuild and discards the shadow table when a later window has a parse failure"`
Expected: after Task 2, PASS.

- [ ] **Step 4: Run the full indexer test suite**

Run: `npx vitest run tests/unit/indexer/`
Expected: all pass.

- [ ] **Step 5: Commit when explicitly requested**

If the user explicitly requested a commit for this task, run:

```bash
git add tests/unit/indexer/pipeline-structured-lifecycle.test.ts
git commit -m "test(indexer): full rebuild discards shadow table on later parse failure"
```

---

### Task 4: Verify non-full-rebuild DLQ behavior still works

**Files:**
- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

**Interfaces:**
- Consumes: existing DLQ test helpers.
- Produces: a test asserting incremental path is unchanged.

- [ ] **Step 1: Write a test for the non-full-rebuild path**

Use the same parse-failing fixture but with `fullRebuild: false` (default) and the same structured index coordinator used in full rebuild tests. Assert:

- The non-failing file is indexed.
- The failing file is enqueued to the dead-letter queue because the structured parser detected the parse error.
- `processEvents` does not throw.

Example:

```typescript
it('routes parse failure to DLQ in incremental indexing with structured indexing enabled', async () => {
  const { metadataStore, vectorStore, pluginRegistry, coordinator } = await createStructuredPipeline();
  const brokenFilePath = resolve('tests/fixtures/structured/typescript/malformed.ts');
  const brokenContent = await readFile(brokenFilePath, 'utf8');
  const okFilePath = 'src/ok.ts';
  const okContent = 'export const ok = 1;\n';

  const plugin = pluginRegistry.getLanguagePlugin(brokenFilePath);
  if (plugin?.createStructuredParser === undefined) {
    throw new Error('TypeScript structured parser is unavailable');
  }

  const countingProvider = new CountingEmbeddingProvider();
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    embeddingProvider: countingProvider,
    pluginRegistry,
    structuredIndexCoordinator: coordinator,
    embedBatchWindowSize: 2,
  });

  const result = await pipeline.processEvents(
    [
      createEvent('added', okFilePath, okContent),
      createEvent('added', brokenFilePath, brokenContent),
    ],
    async (filePath) => {
      if (filePath === brokenFilePath) return brokenContent;
      return okContent;
    },
    { fullRebuild: false, trackProgress: false },
  );

  expect(result.chunksIndexed).toBeGreaterThan(0);
  expect(countingProvider.calls).toBeGreaterThan(0);
  const dlq = await metadataStore.getDeadLetterEntries();
  expect(dlq).toHaveLength(1);
  expect(dlq[0]?.filePath).toBe(brokenFilePath);
  expect(dlq[0]?.errorMessage).toMatch(/parsing/i);
});
```

- [ ] **Step 2: Run the new test**

Run: `npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "routes parse failure to DLQ in incremental indexing"`
Expected: PASS.

- [ ] **Step 3: Run full repository checks**

Run:
- `npx tsc --noEmit`
- `npm run lint`
- `npx vitest run`

Expected: all pass.

- [ ] **Step 4: Commit when explicitly requested**

If the user explicitly requested a commit for this task, run:

```bash
git add tests/unit/indexer/pipeline-structured-lifecycle.test.ts
git commit -m "test(indexer): incremental path still routes parse failures to DLQ"
```

---

## Self-review coverage

- Spec requirement "fullRebuild aborts before embedding" → Task 2.
- Spec requirement "non-full-rebuild behavior unchanged" → Task 4.
- Spec requirement "shadow table is discarded on later-window parse failure" → Task 3.
- Spec requirement "no later windows are processed" → Task 3.
- Spec requirement "error message unchanged" → Task 2 step 1.
- Spec requirement "lint/type/tests pass" → verification steps in each task.
