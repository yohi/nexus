# Ollama CPU Mitigation Design

## Purpose

Nexus currently performs local embedding generation through Ollama during indexing. When several Nexus MCP server processes run at the same time, embedding requests can compete for CPU and make the host machine unresponsive. This design covers the approved Phase 1 and Phase 2 scope: immediate CPU spike mitigation plus verification and reinforcement of the existing cache and Merkle-based skip paths.

The design intentionally excludes the longer-term daemon architecture. The goal is to reduce CPU pressure with minimal risk while preserving the current single-process MCP server architecture.

## Scope

In scope:

- Add per-request Ollama thread limiting with a configurable default.
- Keep the existing process-wide Ollama lock and verify its behavior.
- Verify and, where necessary, reinforce that L1 in-memory and L2 SQLite embedding caches prevent unnecessary embedding calls.
- Verify that the Merkle Tree path avoids unnecessary file-level work where applicable.
- Add regression tests around the CPU-intensive paths.

Out of scope:

- Replacing the current embedding provider architecture with a new coordinator layer.
- Implementing Nexus daemon mode or one-server/multiple-client RPC architecture.
- Adding external infrastructure such as Redis.
- Adding unstable CPU-load assertions to CI.

## Existing Context

The current codebase already contains several relevant protections:

- `src/plugins/embeddings/ollama.ts` uses `acquireGlobalLock('ollama')` around embedding calls.
- `src/utils/global-lock.ts` implements a `proper-lockfile` based global file lock under the OS temporary directory. This is an OS-level file lock, not an in-process `async-mutex`, so it is intended to serialize Ollama access across separately running Nexus MCP server processes.
- `src/indexer/pipeline.ts` has an L1 `Map` cache with an `embeddingCacheSize` bound and an L2 persistent cache through `metadataStore.getEmbeddings()` and `metadataStore.setEmbeddings()`.
- `src/storage/metadata-store.ts` persists embedding vectors in the `embedding_cache` SQLite table.
- `src/indexer/merkle-tree.ts` persists Merkle nodes and supports rename candidate detection.

The main missing immediate control is that Ollama `/api/embed` requests do not currently include `options.num_thread` in the JSON payload.

## Design

### 1. Configurable Ollama thread limit

Add an Ollama-specific numeric setting to the embedding configuration. The setting should default to `2` and should be configurable through environment or project configuration. A value of `1` should be supported for low-power machines or emergency mitigation.

Recommended naming:

- Runtime config property: `ollamaNumThread`
- Environment variable: `NEXUS_OLLAMA_NUM_THREAD`

The config loader should normalize invalid or missing values before the provider sees them. The accepted range should be positive integers from `1` through `16`. In `src/config/index.ts`, this can reuse the existing positive-integer parsing pattern (`asPositiveInt` for environment variables and `validatePositiveInt` for file config), but must add an Ollama-specific upper-bound check. Values such as `0`, negative numbers, decimals, empty strings, non-numeric strings, and values greater than `16` must fall back to the safe default `2`.

### 2. Ollama request payload

Update the Ollama embed request body to include the configured thread limit:

```json
{
  "model": "nomic-embed-text",
  "input": ["export function example() { return true; }"],
  "truncate": true,
  "options": {
    "num_thread": 2
  }
}
```

This belongs only in the Ollama provider. OpenAI-compatible embedding providers must not receive Ollama-specific options.

### 3. Process-level locking

Keep the existing `acquireGlobalLock('ollama')` behavior. The design does not replace it because the current implementation uses `proper-lockfile` on a lock file in the OS temporary directory, which matches the required responsibility: serialize Ollama access across separate Nexus MCP server processes.

The verification focus is that the lock is acquired before embed requests and released in `finally`, including error paths. Lock acquisition failure should remain observable as an error rather than becoming an indefinite wait. The expected lock behavior is the current bounded policy: stale locks become recoverable after `60_000ms`, and acquisition retries are bounded to 10 attempts with `100ms` minimum and `1000ms` maximum retry delays. This gives crashed processes time to be detected through `proper-lockfile`'s mtime-based stale detection while still ensuring later processes fail visibly instead of waiting forever. Tests should explicitly guard against accidentally replacing this with an in-process-only mutex, because that would not protect the reported three-process MCP server scenario.

### 4. Cache-aware embedding path

Keep the existing three-stage pipeline:

1. Read and chunk files with bounded concurrency.
2. Resolve embeddings through L1 memory cache, then L2 SQLite cache, then Ollama only for true misses.
3. Persist vectors and update Merkle state serially.

The key behavioral requirement is that cache hits do not call `embeddingProvider.embed()`. The existing `Map`-based L1 cache may remain in place if it preserves LRU semantics by deleting and re-inserting a key on every hit before evicting the oldest insertion-order entry. L2 hits should populate L1 and use the same bounded insertion path. The L1 cache must remain bounded by `embeddingCacheSize`; inserting more entries than the configured limit should evict the least-recently-used entry so a full scan of a large repository cannot grow the Node.js heap without bound. If tests show the `Map` behavior is FIFO rather than LRU, reinforcing this path is in scope; replacing it with an external LRU package is not required unless the minimal `Map` implementation cannot satisfy the tests.

### 5. Merkle Tree verification

Keep the existing database-backed Merkle Tree design. Verification should focus on practical skip behavior:

- Rename candidates with matching content hashes should move vector paths instead of recomputing embeddings.
- Deletes should remove vector and Merkle state without embedding calls.
- Directory hash updates should remain consistent after add, modify, delete, and move operations.

If tests reveal that unchanged modified events still reach chunking unnecessarily, that should be treated as a targeted follow-up fix, not a broad redesign.

## Error Handling

- Ollama HTTP 400 remains non-retryable and should continue to route through the existing `NonRetryableEmbeddingError` and DLQ behavior.
- Timeout and transient failures continue through the existing retry path and eventually become `RetryExhaustedError`.
- Global lock release must be attempted in `finally`. Release failure should not mask the original embedding error.
- Cache read/write failures from SQLite should surface through the pipeline's existing error behavior; they should not silently fall back to unbounded embedding work unless the existing metadata-store contract already defines that behavior.

## Testing Strategy

### Unit tests

- Ollama provider sends `options.num_thread` with the default value `2`.
- Ollama provider sends configured values such as `1` when supplied by config.
- Config parsing accepts positive integer `NEXUS_OLLAMA_NUM_THREAD` values from `1` through `16` and falls back to `2` for `0`, negative, decimal, empty, non-numeric, and greater-than-`16` values.
- Ollama-specific options are isolated to the Ollama provider.
- Global lock acquisition happens before the fetch call and release is attempted after success and failure.
- The global lock implementation remains backed by `proper-lockfile` on a filesystem path, not by process-local `async-mutex` state.
- Stale-lock and retry behavior remains bounded: stale timeout `60_000ms`, 10 retries, `100ms` minimum retry delay, and `1000ms` maximum retry delay.

### Pipeline tests

- L1 cache hit skips `embeddingProvider.embed()`.
- L1 cache hit refreshes `Map` insertion order through delete-and-set before eviction decisions.
- L2 SQLite cache hit skips `embeddingProvider.embed()` and hydrates L1.
- L2 hydration respects `embeddingCacheSize` and evicts old L1 entries when the cache is full.
- True misses call `embeddingProvider.embed()` once per miss batch and persist fresh vectors to L2.
- Shared embedding failure routes affected files to DLQ without corrupting successful cached resolutions.

### Merkle tests

- Rename candidate detection matches deleted and added events with the same content hash.
- Rename handling updates vector paths and Merkle state without recomputing embeddings.
- Delete handling removes vector and Merkle state.
- Directory root hashes remain stable for unchanged content and change when content changes.

### Verification commands

Run these after implementation:

```bash
npm test
npm run build
npm run lint
```

Manual CPU observation with tmux and htop is useful for local validation, but it should not be part of CI because CPU scheduling and host load are unstable across environments.

## Success Criteria

- Ollama embed requests include `options.num_thread` by default.
- Users can reduce the thread limit to `1` without changing code.
- Users cannot accidentally bypass CPU mitigation with excessive thread counts; values above `16` fall back to `2`.
- Multiple Nexus processes do not call Ollama concurrently through the provider path.
- Reprocessing unchanged chunks uses L1 or L2 cache and avoids embedding calls.
- Rename and delete paths avoid unnecessary embedding recomputation.
- Tests and build pass without adding external services or changing the public MCP tool contract.
