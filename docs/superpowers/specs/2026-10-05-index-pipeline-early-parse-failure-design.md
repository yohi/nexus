# Design: Structured full rebuild aborts before expensive embedding

## Goal

Change `nexus/src/indexer/pipeline.ts` so that a `fullRebuild` stops as soon as any windowed file fails structured parsing, before it calls the embedding provider. This avoids long, wasted Ollama calls on large repositories when a single file makes the structured rebuild impossible.

## Current state

`IndexPipeline.processEvents` runs windows of files through `processEventWindow`. Each window first reads and chunks all of its files, then checks `structuredParseFailed` to collect failures, then performs embedding for the surviving chunks, and finally writes vectors/structured data.

Only after all windows complete does `processEvents` check `structuredParseFailures.length > 0` and throw:

```text
Structured full rebuild aborted: parsing failed for spikes/review-artifact-linux/probe.c
```

At that point the `legacyShadow` table is aborted, so all embedding work done across the entire rebuild is discarded.

In `justice-v4` this manifested as:

- `index_status` showing `indexStats.totalFiles: 0`, `totalChunks: 0`, `lastIndexedAt: null`, `lastError` set to the abort message.
- `vectorStats` still holding `383` files / `7105` chunks from a previous index.
- Ollama lock contention/timeouts (`GlobalLockTimeoutError` after 300000ms) while the wasted embedding ran.

## Design

### Approach: early window-level abort

For `fullRebuild === true` only, make `processEventWindow` return immediately when it detects a structured parse failure, before building the embed batch, calling the embedding provider, or writing anything for that window. `processEvents` then aborts the legacy shadow table and throws, so no later windows run.

1. Keep `processEventWindow` unchanged for non-full-rebuild cases so incremental indexing continues to route parse failures to the DLQ.
2. Add a `parseFailures: string[]` field and a `shouldAbortStructuredFullRebuild` flag to `ProcessEventWindowResult`. Populate them from the window's `works` right after read-and-chunk completes. If `useStructuredFullRebuild` is true and the window has parse failures, return from `processEventWindow` immediately, before any embedding or writes.
3. In `processEvents`, after each window returns, if `useStructuredFullRebuild` and `windowResult.shouldAbortStructuredFullRebuild` are true, abort the legacy shadow table immediately and throw `Structured full rebuild aborted: parsing failed for ...`. No embedding call or later window runs.
   This avoids throwing inside `processEventWindow` for non-full-rebuild paths and keeps DLQ routing isolated to `processEvents`.

### Data flow

```text
processEvents
  for each window:
    windowResult = processEventWindow(window)
      readAndChunkFile (may set structuredParseFailed)
      compute parseFailures and shouldAbortStructuredFullRebuild
      if shouldAbortStructuredFullRebuild:
        return early result:
          chunksIndexed = 0
          embeddingFailures = []
          parseFailures = deduplicated paths in encounter order
          shouldAbortStructuredFullRebuild = true
      otherwise:
        perform cache lookup
        perform embedding
        perform vector / structured writes
        return normal window result
    if useStructuredFullRebuild and windowResult.shouldAbortStructuredFullRebuild:
      abort legacyShadow -> throw Structured full rebuild aborted
    aggregate successful window result
```

### Interface change

Add `parseFailures: readonly string[]` and `shouldAbortStructuredFullRebuild: boolean` to `ProcessEventWindowResult`. `shouldAbortStructuredFullRebuild` is `true` only when this window is part of a structured full rebuild (i.e., the caller passed `structuredRebuildFiles`) and the window contains at least one parse failure. The early result is constructed immediately after Stage 1 using only values available there: `chunksIndexed: 0`, `embeddingFailures: []`, the deduplicated parse-failure paths in encounter order, and `shouldAbortStructuredFullRebuild: true`. The normal result is constructed after Stage 3 using the actual indexed count and embedding failures, with the same parse-failure list and a `false` abort flag.

No other public interfaces change.

## Tests

Add or extend unit tests in the indexer test suite. The primary regression test is written and observed failing before production implementation, then rerun after the minimum implementation. It asserts:

- A full rebuild with one unparseable file fails before its window is embedded.
- The embedding provider is not called for the window that contains the parse failure, and no later windows are processed.
- A non-full-rebuild run with the same unparseable file still routes it to the DLQ and indexes the other files normally.
- A full-rebuild failure aborts the legacy shadow table, retains pre-existing legacy vectors, Merkle state, and active structured generations, and preserves the exact error message.

If existing tests assert the exact failure message, keep the message unchanged to avoid breaking callers.

## Out of scope

- Changing how parsing failures are reported to the user or stored in `lastError`.
- Adding retries or recovery for unparseable files.
- Changing the normal incremental indexing path.

## Risks and mitigations

| Risk                                                 | Mitigation                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Returning early changes observable progress metrics. | Only affects the already-failing full-rebuild path; progress was going to be discarded anyway.                                                                                                                |
| Tests rely on the old late-abort behavior.           | Keep the final error message identical; update only tests that assert call counts or intermediate progress.                                                                                                   |
| Non-full-rebuild DLQ routing regresses.              | Gate the early return in `processEventWindow` on the caller passing `structuredRebuildFiles` (or an equivalent full-rebuild flag), and gate the early throw in `processEvents` on `useStructuredFullRebuild`. |

## Acceptance criteria

- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] A new or updated test verifies the embedding provider is not called for the window that contains a structured parse failure and that later windows are not processed.
- [ ] The final error message remains `Structured full rebuild aborted: parsing failed for <file>`.
