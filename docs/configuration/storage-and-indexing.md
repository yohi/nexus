# Storage, Watcher, and Indexing Configuration

This document is part of the canonical Nexus configuration reference. See [Configuration](../configuration.md) for resolution rules.

## Storage

| Field | Default | Environment variable | Purpose |
| --- | --- | --- | --- |
| `storage.rootDir` | `<projectRoot>/.nexus` | `NEXUS_STORAGE_ROOT_DIR` | Root for Nexus-managed local state. |
| `storage.metadataDbPath` | `<projectRoot>/.nexus/metadata.db` | `NEXUS_STORAGE_METADATA_DB_PATH` | SQLite metadata database. |
| `storage.vectorDbPath` | `<projectRoot>/.nexus/vectors` | `NEXUS_STORAGE_VECTOR_DB_PATH` | LanceDB vector store. |
| `storage.batchSize` | `1000` | `NEXUS_STORAGE_BATCH_SIZE` | SQLite bulk-operation batch size. |

Each persistent storage target (`rootDir`, `metadataDbPath`, and `vectorDbPath` unless it is exactly `memory://`) is owned by one canonical project root. A writer is refused if it reuses another root's target, if it reuses a populated target that has no owner claim, or if it would become a second live writer on a target. Custom paths must therefore be disjoint across projects and Git worktrees. The ownership, admission and limitation contract (including Linux-only admission) is defined in [SPEC.md §10.1](../../SPEC.md#101-git-worktree-isolation-and-storage-ownership).

## Watcher

| Field | Default | Environment variable | Purpose |
| --- | --- | --- | --- |
| `watcher.debounceMs` | `100` | `NEXUS_WATCHER_DEBOUNCE_MS` | Coalescing delay for filesystem events. |
| `watcher.maxQueueSize` | `10000` | `NEXUS_WATCHER_MAX_QUEUE_SIZE` | Queue length before overflow handling. |
| `watcher.fullScanThreshold` | `5000` | `NEXUS_WATCHER_FULL_SCAN_THRESHOLD` | Threshold for broader scan recovery. |
| `watcher.ignorePaths` | see below | `NEXUS_WATCHER_IGNORE_PATHS` | Paths excluded from watching/indexing. |

Default exclusions include:

```text
node_modules
.agents/
AGENTS.md
.git
.claude
.worktrees
.nexus
.nexus/
dist
build
out
coverage
.cache
.parcel-cache
venv
.venv
env
.idea
.vscode
.DS_Store
package-lock.json
pnpm-lock.yaml
yarn.lock
bun.lockb
*.lock
__pycache__
*.pyc
.pytest_cache
.mypy_cache
.ruff_cache
```

`.env` and `.env.*` are always excluded even when `watcher.ignorePaths` is overridden. These secret-file exclusions cannot be re-enabled by configuration.

## Indexing

| Field | Default | Environment variable | Purpose |
| --- | --- | --- | --- |
| `indexing.maxFileBytes` | `1048576` | `NEXUS_INDEXING_MAX_FILE_BYTES` | Maximum UTF-8 file size eligible for embedding. Larger files are skipped and reported, not sent to the DLQ. |
| `indexing.maxChunkChars` | `6000` | `NEXUS_INDEXING_MAX_CHUNK_CHARS` | Maximum characters per search chunk. `0` means unlimited. |
| `indexing.chunkConcurrency` | `2` | `NEXUS_INDEXING_CHUNK_CONCURRENCY` | Parallel file-read/chunking count. |
| `indexing.embedBatchWindowSize` | `16` | `NEXUS_INDEXING_EMBED_BATCH_WINDOW_SIZE` | Number of chunks combined across files into one embedding batch window. |

## Project process lock

Nexus uses a file-based `proper-lockfile` lock to prevent conflicting processes from using the same `storage.rootDir`.

- The lock file is `nexus.pid` under `storage.rootDir`.
- Failure to acquire the lock stops startup.
- Normal shutdown releases the lock.
- Stale locks from crashes are recovered through `proper-lockfile` stale detection. A stale `nexus.pid` is reclaimed only by a process holding writer admission for that `storage.rootDir`.
- `nexus dashboard` does not index data and does not acquire this project lock.
