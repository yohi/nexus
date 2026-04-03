# Local Codebase Index MCP Server - Design Specification

## Overview

A locally-complete codebase index MCP server inspired by Cursor IDE's advanced codebase indexing architecture, accessible cross-functionally from multiple AI agents. All data remains on the local machine (Zero External Data Transmission — no data is sent to external servers; all index data is stored locally in `<projectRoot>/.codebase-index/`), with embedding inference handled by local endpoints such as Ollama.

## Architecture: Event-Driven Pipeline (Approach B)

Single-process architecture with the MCP server (Transport + Tool Handlers) and a background index pipeline separated by an async event queue within the same process. Components (Chunker, Embedder, Storage, Searcher) are loosely coupled via events.

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server Process                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │  Transport    │    │        Tool Handlers                 │   │
│  │  (SSE/HTTP)   │───>│  hybrid_search / semantic_search /   │   │
│  │              │    │  grep_search / get_context /          │   │
│  │  Multi-client │    │  index_status / reindex              │   │
│  └──────────────┘    └────────────┬─────────────────────────┘   │
│                                   │                             │
│                      ┌────────────v────────────┐                │
│                      │   Search Orchestrator    │                │
│                      │   (RRF Fusion Engine)    │                │
│                      └──┬─────────────────┬────┘                │
│                         │                 │                      │
│              ┌──────────v──┐    ┌────────v────────┐             │
│              │  Semantic    │    │  Grep Search     │             │
│              │  Search      │    │  (ripgrep)       │             │
│              │  (LanceDB)   │    │                  │             │
│              └──────────────┘    └─────────────────┘             │
│                                                                 │
│  ┌──────────────────────── Index Pipeline ────────────────────┐ │
│  │                                                            │ │
│  │  [FS Watcher] --> [Event Queue] --> [Diff Detector]        │ │
│  │  (chokidar)       (async queue)     (Merkle Tree)          │ │
│  │                                          │                 │ │
│  │                   [Vector Store] <-- [Embedder] <-- [Chunker] │
│  │                    (LanceDB)      (Plugin)     (tree-sitter)│ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌─────────────────────── Plugin Registry ───────────────────┐  │
│  │  - Language Plugins (tree-sitter grammars)                │  │
│  │  - Embedding Providers (Ollama, OpenAI-compat, HF TEI)    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Event-driven pipeline (single process) | Balances scalability and simplicity for local-complete use case |
| Vector Storage | LanceDB | Rust-based, fast, file-based serverless, scales linearly from small to large |
| Metadata Storage | better-sqlite3 | Merkle tree state + index stats, WAL mode for concurrent read/write |
| Grep Engine | ripgrep (child process) | Unmatched speed, .gitignore support, bundled in Devcontainer |
| Transport | SSE / StreamableHTTP | Multi-client support for simultaneous AI agent connections |
| Embedding Default | Ollama (local) | Zero external data transmission, no external API calls by default |
| Hash Algorithm | xxhash | Non-cryptographic, 10x+ faster than SHA-256, sufficient for diff detection |

## Directory Structure

```
multi-agent-codebase-index/
├── .devcontainer/
│   ├── devcontainer.json
│   └── Dockerfile
├── src/
│   ├── server/
│   │   ├── index.ts                 # MCP server entry point
│   │   ├── transport.ts             # SSE/StreamableHTTP transport config
│   │   └── tools/
│   │       ├── hybrid-search.ts     # Hybrid search tool
│   │       ├── semantic-search.ts   # Semantic search tool
│   │       ├── grep-search.ts       # Grep search tool
│   │       ├── get-context.ts       # File/symbol context retrieval
│   │       ├── index-status.ts      # Index status check
│   │       └── reindex.ts           # Manual reindex trigger
│   ├── indexer/
│   │   ├── pipeline.ts              # Index pipeline integration (with AsyncMutex)
│   │   ├── event-queue.ts           # Async event queue (with backpressure)
│   │   ├── dead-letter-queue.ts     # DLQ for failed embedding events
│   │   ├── merkle-tree.ts           # Merkle tree diff detection
│   │   ├── chunker.ts              # tree-sitter chunking integration (with failsafe)
│   │   └── watcher.ts              # FS watcher (with pause/resume)
│   ├── search/
│   │   ├── orchestrator.ts          # Search orchestrator
│   │   ├── semantic.ts              # Semantic search engine
│   │   ├── grep-interface.ts        # IGrepEngine interface (DI)
│   │   ├── grep.ts                  # RipgrepEngine (IGrepEngine impl)
│   │   └── rrf.ts                   # RRF fusion algorithm
│   ├── storage/
│   │   ├── vector-store.ts          # LanceDB wrapper
│   │   └── metadata-store.ts        # Merkle tree / metadata persistence (SQLite)
│   ├── plugins/
│   │   ├── registry.ts              # Plugin registry
│   │   ├── languages/
│   │   │   ├── interface.ts         # Language plugin interface
│   │   │   ├── typescript.ts        # TypeScript/JS parser
│   │   │   ├── python.ts            # Python parser
│   │   │   └── go.ts                # Go parser
│   │   └── embeddings/
│   │       ├── interface.ts         # Embedding provider interface
│   │       ├── ollama.ts            # Ollama provider
│   │       └── openai-compat.ts     # OpenAI-compatible provider
│   ├── config/
│   │   └── index.ts                 # Config management
│   └── types/
│       └── index.ts                 # Shared type definitions
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│       └── sample-project/
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── vitest.config.ts
```

## Index Pipeline

### Data Flow

```
File Change Detected
      │
      v
[FS Watcher] --> [Event Queue] --> [Diff Detector (Merkle)] --> [Chunker (tree-sitter)] --> [Embedder] --> [Vector Store]
 (chokidar)     (priority queue)   (xxhash comparison)         (AST-based splitting)      (plugin)      (LanceDB)
```

### Merkle Tree

- **Leaf nodes**: File content hash (xxhash)
- **Internal nodes**: Hash of concatenated child hashes
- **Update propagation**: Only recompute nodes on the path from changed leaf to root
- **Persistence**: SQLite flat table (`path, hash, parent_path, is_directory`)
- **Startup**: Restore in-memory tree from SQLite

```
                    [Root Hash]
                   /           \
          [src/ Hash]        [tests/ Hash]
          /        \              |
   [server/ Hash] [indexer/ Hash] [unit/ Hash]
      |               |
 [index.ts Hash]  [pipeline.ts Hash]
```

### Event Queue

- **Debounce**: 100ms debounce for consecutive changes to the same file
- **Concurrency limit**: `p-limit` with default concurrency of 4
- **Priority**: Manual `reindex` requests > FS watcher events
- **Backpressure**: Queue size is bounded by `maxQueueSize` (default: 10,000)
  - When queue size exceeds `fullScanThreshold` (default: 5,000), the watcher is paused and new incoming events are dropped
  - The pipeline drains the current queue, then triggers a **full-scan reindex** to reconcile any missed events
  - After full-scan completion, the watcher is resumed
  - This prevents OOM under branch-switch scenarios where thousands of inotify events fire simultaneously

#### Backpressure State Machine

```
                   queue.size < fullScanThreshold
  [Normal] ──────────────────────────────────────── events enqueued normally
     │
     │ queue.size >= fullScanThreshold
     v
  [Paused] ── watcher.pause(), drop new events
     │
     │ queue fully drained
     v
  [FullScan] ── watcher remains STOPPED, queue.clear()
     │           trigger merkle-tree full reconciliation
     │
     │ full-scan complete
     v
  [Normal] ── watcher.resume()
```

#### Full-Scan 中のデススパイラル防止

フルリインデックス（フルスキャン）実行中に Watcher が稼働し続けると、Mutex ロック中に
イベントキューへ変更イベントが蓄積し、フルスキャン完了直後に `fullScanThreshold` を
再超過して「さらなるフルスキャン」が即座にトリガーされる無限ループ（デススパイラル）が
発生するリスクがある。

これを防止するため、以下のルールを適用する:

1. **フルスキャン開始時に Watcher を停止する**（`[Paused]` 遷移時点で既に停止済みだが、
   手動 `reindex --fullRebuild` による直接フルスキャンでも同様に停止する）
2. **フルスキャン開始直前にイベントキューをクリアする** — フルスキャンの結果は
   ファイルシステム全体の最新状態を反映するため、蓄積済みイベントは安全に破棄可能
3. **フルスキャン完了後に Watcher を再開する** — 再開後の新規イベントのみが
   インクリメンタル処理の対象となる

```
デススパイラル防止の保証:

  [FullScan 開始]
       │
       ├── watcher.stop()          ← 新規イベント生成を完全停止
       ├── eventQueue.clear()      ← 蓄積済みイベントを安全に破棄
       ├── (フルスキャン実行)       ← FS全体の最新状態を反映
       │
  [FullScan 完了]
       │
       ├── assert(eventQueue.size === 0)  ← Watcher停止中のためキューは空
       └── watcher.start()         ← ここからのイベントのみ処理対象

  ∴ FullScan 完了直後に fullScanThreshold を超えることは構造的に不可能
```

**Watcher イベントがフルスキャン結果に包含される論拠:**

フルスキャンは Merkle Tree の全ノードをファイルシステムの実際の状態と突き合わせるため
（Startup Reconciliation と同等のロジック）、フルスキャン開始以前に発生したファイル変更は
すべてフルスキャンの差分検出でカバーされる。フルスキャン開始から完了までの間に発生した
変更は Watcher 停止中のため検出されないが、フルスキャン完了後の Watcher 再開により
次のインクリメンタルサイクルで捕捉される。

### File Rename Optimization (Vector Reuse)

When a file is renamed or moved without content changes, the content hash (xxhash) remains identical.
In this case, re-embedding via Ollama is skipped and existing vectors are remapped to the new path.

**Detection strategy:**

The Diff Detector emits three event types: `added`, `modified`, `deleted`.
A rename is detected as a simultaneous `deleted` + `added` pair within the same debounce window
where both share the same content hash.

```
[Event Queue] --> [Diff Detector]
                       │
                       ├── hash(deleted) == hash(added) ?
                       │      YES --> emit RenameEvent(oldPath, newPath, hash)
                       │      NO  --> emit DeleteEvent + AddEvent (normal flow)
                       │
                       v
                  [Pipeline]
                       │
                  RenameEvent:
                       ├── LanceDB: UPDATE filePath WHERE filePath = oldPath
                       ├── SQLite: UPDATE merkle_nodes SET path = newPath
                       └── Skip Chunker + Embedder entirely
```

**Data flow for rename:**

1. Merkle Tree detects one leaf removed and one added with identical hash
2. Pipeline receives `RenameEvent` instead of separate delete/add
3. LanceDB: batch update `filePath` column for all chunks of the old path
4. SQLite: update `merkle_nodes.path` and propagate parent hash changes
5. Embedding provider is never called — zero GPU cost for renames

### Chunker Event Loop Protection

web-tree-sitter's `parse()` is a synchronous WASM operation that blocks the Node.js event loop.
For large files (thousands of lines), this can block for 50-200ms+, disrupting SSE heartbeats
and client timeouts in the multi-client transport layer.

**Yield strategy:**

The chunker processes files sequentially with cooperative yielding between files.
Within a single file, AST parsing is atomic (tree-sitter requires the full source),
but post-parse traversal and chunk extraction yield periodically.

**AST Parse Failsafe:**

`parser.parse()` may throw or return an invalid tree under the following conditions:

- Corrupted or binary files misidentified by extension
- Files exceeding tree-sitter's internal memory limits
- WASM runtime errors (e.g., out-of-memory in the WASM heap)

When this occurs, the chunker catches the exception, logs a warning, and falls back
to the fixed-line sliding window strategy (same as unsupported languages).
This ensures the file is still indexed (at lower semantic quality) rather than silently dropped.

```typescript
async function chunkFiles(files: FileToChunk[]): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];

  for (const file of files) {
    try {
      // 1. Parse AST (synchronous, unavoidable — but bounded per-file)
      const tree = parser.parse(file.content);

      if (!tree || !tree.rootNode) {
        throw new Error(`tree-sitter returned invalid tree for ${file.filePath}`);
      }

      // 2. Traverse and extract chunks with periodic yielding
      const chunks = await extractChunksWithYield(tree.rootNode, file);
      allChunks.push(...chunks);
    } catch (error) {
      // 3. Failsafe: fall back to fixed-line sliding window chunking
      logger.warn(
        `AST parse failed for ${file.filePath}, falling back to line-based chunking`,
        { error: error instanceof Error ? error.message : String(error) }
      );
      const chunks = chunkByFixedLines(file, {
        windowSize: 50,
        overlap: 10,
      });
      allChunks.push(...chunks);
    }

    // 4. Yield between files to release event loop
    await yieldToEventLoop();
  }

  return allChunks;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function extractChunksWithYield(
  rootNode: SyntaxNode,
  file: FileToChunk,
  yieldEvery: number = 50  // yield every N nodes visited
): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = [];
  let visitCount = 0;

  for (const node of walkChunkableNodes(rootNode)) {
    chunks.push(nodeToChunk(node, file));
    visitCount++;

    if (visitCount % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }

  return chunks;
}

/**
 * Fixed-line sliding window chunking for unsupported languages
 * or when AST parsing fails.
 */
function chunkByFixedLines(
  file: FileToChunk,
  opts: { windowSize: number; overlap: number }
): CodeChunk[] {
  const lines = file.content.split('\n');
  const chunks: CodeChunk[] = [];
  const step = opts.windowSize - opts.overlap;

  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(i + opts.windowSize, lines.length);
    chunks.push({
      id: hashChunkId(file.filePath, 'unknown', i + 1),
      filePath: file.filePath,
      content: lines.slice(i, end).join('\n'),
      language: file.language,
      symbolName: `lines_${i + 1}_${end}`,
      symbolKind: 'unknown',
      startLine: i + 1,
      endLine: end,
    });
    if (end >= lines.length) break;
  }

  return chunks;
}
```

**Design rationale:**

- `setImmediate` is preferred over `setTimeout(0)` — it fires at the end of the current I/O cycle
  without the minimum 1ms timer delay, giving other I/O callbacks a chance to run
- Per-file yielding is the primary protection (most files parse in < 10ms)
- Intra-file yielding (every 50 nodes) handles edge cases of very large files
- **AST failsafe** ensures no file is silently dropped from the index due to parse errors
- Worker Threads were considered but rejected: WASM instance sharing across threads
  adds significant complexity with marginal benefit for this workload

### Chunking Strategy

| AST Node Type | Chunking Strategy |
|---|---|
| Function/method declaration | 1 function = 1 chunk (including doc comments) |
| Class/interface declaration | Signature + properties = 1 chunk; each method = separate chunk |
| Module-level variables/constants | Group consecutive declarations into 1 chunk |
| Import statements | All imports in a file = 1 chunk |
| Large nodes (> 200 lines) | Recursively split at child node level |
| Unsupported language files | Fixed 50-line sliding window with 10-line overlap |

### Chunk Schema

```typescript
interface CodeChunk {
  id: string;              // Hash of `${filePath}:${symbolName}:${startLine}`
  filePath: string;        // Relative path from project root
  content: string;         // Source code of the chunk
  language: string;        // Language identifier (e.g., "typescript")
  symbolName: string;      // Symbol name (e.g., "MyClass.myMethod")
  symbolKind: SymbolKind;  // function, class, interface, variable, imports, unknown
  startLine: number;
  endLine: number;
  embedding?: number[];    // Embedding vector
}

type SymbolKind = 'function' | 'class' | 'interface' | 'variable' | 'imports' | 'unknown';
```

## Search Engine and RRF Fusion

### MCP Tools

| Tool | Description | Key Parameters |
|---|---|---|
| `hybrid_search` | Combined semantic + grep search (recommended default) | `query`, `topK?`, `filePattern?`, `language?` |
| `semantic_search` | Vector similarity search only | `query`, `topK?`, `filePattern?`, `language?` |
| `grep_search` | ripgrep regex/literal search | `pattern`, `isRegex?`, `filePattern?`, `caseSensitive?` |
| `get_context` | Retrieve surrounding context for a file/symbol | `filePath`, `symbolName?`, `lineRange?` |
| `index_status` | Return index state and statistics | `projectPath?` |
| `reindex` | Manually trigger reindexing | `projectPath?`, `fullRebuild?` |

### Input Path Sanitization (Path Traversal Defense)

All MCP tool handlers that accept file path parameters (`filePath`, `filePattern`, `lineRange`
referencing files) MUST resolve and validate paths within the project root boundary before
any I/O operation. This prevents autonomous AI agents from accessing files outside the
project scope via crafted inputs like `../../../etc/passwd`.

**Sanitization layer:**

A shared `sanitizePath()` utility is applied at the **Tool Handler entry point** (before
the Search Orchestrator or any storage access), forming a security boundary.

```typescript
import path from 'node:path';

class PathSanitizer {
  private readonly projectRoot: string; // Absolute, normalized path
  private readonly projectRootWithSep: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectRootWithSep = this.projectRoot + path.sep;
  }

  /**
   * Resolve a user-provided path and verify it is within the project root.
   * Returns the resolved absolute path.
   * Throws if the path escapes the project boundary.
   */
  resolve(userPath: string): string {
    // Normalize and resolve against project root
    const resolved = path.resolve(this.projectRoot, userPath);

    // Allow exact match (projectRoot itself) or child paths
    if (resolved !== this.projectRoot && !resolved.startsWith(this.projectRootWithSep)) {
      throw new PathTraversalError(
        `Path '${userPath}' resolves outside project root`,
      );
    }

    return resolved;
  }

  /**
   * Resolve and return a relative path from project root.
   * Used for storage keys and display.
   */
  resolveRelative(userPath: string): string {
    const resolved = this.resolve(userPath);
    return path.relative(this.projectRoot, resolved);
  }

  /**
   * Validate a glob pattern does not escape project root.
   * Rejects patterns containing '..' segments.
   */
  validateGlob(pattern: string): string {
    if (pattern.includes('..')) {
      throw new PathTraversalError(
        `Glob pattern '${pattern}' contains directory traversal`,
      );
    }
    return pattern;
  }
}

class PathTraversalError extends Error {
  readonly code = 'PATH_TRAVERSAL';
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}
```

**Application points:**

```
[MCP Tool Handler] ─── sanitizer.resolve(filePath) ───→ [Search Orchestrator / Storage]
                   ─── sanitizer.validateGlob(filePattern) ───→ [Grep Engine]
                   ─── PathTraversalError? → return MCP error response (400)
```

| Tool | Sanitized Parameters | Notes |
|---|---|---|
| `get_context` | `filePath` → `sanitizer.resolve()` | Direct file read — highest risk |
| `grep_search` | `filePattern` → `sanitizer.validateGlob()` | ripgrep `cwd` is set to `projectRoot` as implicit jail |
| `hybrid_search` | `filePattern` → `sanitizer.validateGlob()` | Passed through to grep sub-query |
| `semantic_search` | `filePattern` → `sanitizer.validateGlob()` | Post-filter on LanceDB results |
| `reindex` | `projectPath` → `sanitizer.resolve()` | Prevents reindexing arbitrary directories |

**Additional hardening:**

- ripgrep is always spawned with `cwd: projectRoot`, providing an implicit OS-level path jail
  for `--glob` patterns. Even if glob validation is bypassed, ripgrep cannot access files
  outside its working directory.
- `PathSanitizer` is instantiated once at server startup and injected into all tool handlers
  via the dependency injection scope.

### Search Orchestrator Flow

```
hybrid_search(query)
      │
      v
┌─────────────────────────────────────────┐
│         Search Orchestrator              │
│  1. Receive query                       │
│  2. Run semantic + grep in parallel     │
│  3. Fuse results via RRF               │
│  4. Return top-K results               │
└──────┬──────────────────┬───────────────┘
       │ parallel          │ parallel
       v                  v
[Semantic Search]    [Grep Search]
 (LanceDB ANN)       (ripgrep)
       │                  │
       └────────┬─────────┘
                v
         [RRF Fusion]
```

### RRF Algorithm

Formula: `RRFscore(d) = SUM_{r in R} 1/(k + rank_r(d))`

- `k = 60` (constant)
- `R = {semantic_results, grep_results}`
- Results sorted by descending RRF score, top-K returned

```typescript
interface SearchResult {
  chunk: CodeChunk;
  score: number;
  source: 'semantic' | 'grep';
}

interface RankedResult {
  chunk: CodeChunk;
  rrfScore: number;
  sources: ('semantic' | 'grep')[];
}

function fuseResults(
  semanticResults: SearchResult[],
  grepResults: SearchResult[],
  k: number = 60,
  topK: number = 20
): RankedResult[] {
  const scoreMap = new Map<string, RankedResult>();

  for (const [results, source] of [
    [semanticResults, 'semantic'],
    [grepResults, 'grep']
  ] as const) {
    results.forEach((result, rank) => {
      const id = result.chunk.id;
      const existing = scoreMap.get(id);
      const rrfContribution = 1 / (k + rank + 1);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.sources.push(source);
      } else {
        scoreMap.set(id, {
          chunk: result.chunk,
          rrfScore: rrfContribution,
          sources: [source]
        });
      }
    });
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}
```

### Grep Process Resource Management

ripgrep is executed as a child process per search request. Under multi-client concurrent access,
uncontrolled spawning causes file descriptor exhaustion and OS process limits.

**Semaphore strategy:**

- `RipgrepEngine` (concrete `IGrepEngine` implementation) holds a module-level semaphore (`p-limit`) limiting concurrent ripgrep child processes
- Default limit: `search.grepMaxConcurrency` (default: 4)
- When all slots are occupied, additional requests queue and await an available slot
- The semaphore is shared across all callers (`grep_search` tool, `hybrid_search` via orchestrator)
- Each ripgrep process has a per-process timeout (default: 10s) to prevent zombie processes

**Zombie Process Prevention (AbortController):**

A per-request `AbortController` ensures deterministic child process cleanup on timeout or
caller cancellation. This prevents orphaned ripgrep processes from accumulating under
heavy concurrent load or when MCP clients disconnect mid-request.

- Each `executeRipgrep` call creates a dedicated `AbortController`
- The `signal` is passed to `spawn()` — Node.js automatically sends `SIGTERM` on abort
- A `setTimeout`-based watchdog aborts the controller after `grepTimeoutMs` (default: 10s)
- On abort, `SIGKILL` is sent as a fallback if the process doesn't exit within 1s grace period
- The caller's `AbortSignal` (from MCP request context) is chained via `AbortSignal.any()`
  to propagate client disconnection

```
[MCP Request] ──→ GrepEngine.search(params, requestSignal)
                    │
                    ├─ semaphore.acquire()
                    ├─ AbortController created (per-request)
                    ├─ signal = AbortSignal.any([timeoutSignal, requestSignal])
                    ├─ spawn('rg', args, { signal })
                    │    │
                    │    ├─ Normal completion → resolve results
                    │    ├─ Timeout (10s) → controller.abort() → SIGTERM → 1s grace → SIGKILL
                    │    └─ Client disconnect → requestSignal aborted → SIGTERM
                    │
                    └─ semaphore.release()
```

```typescript
import { spawn } from 'node:child_process';

class RipgrepEngine implements IGrepEngine {
  private readonly semaphore: pLimit.Limit;
  private readonly timeoutMs: number;

  constructor(config: SearchConfig) {
    this.semaphore = pLimit(config.grepMaxConcurrency); // default: 4
    this.timeoutMs = config.grepTimeoutMs ?? 10_000;
  }

  async search(
    params: GrepParams,
    requestSignal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return this.semaphore(() => this.executeRipgrep(params, requestSignal));
  }

  private async executeRipgrep(
    params: GrepParams,
    requestSignal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const controller = new AbortController();

    // Combine timeout + caller signal
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const combinedSignal = requestSignal
      ? AbortSignal.any([controller.signal, requestSignal])
      : controller.signal;

    try {
      const child = spawn('rg', this.buildArgs(params), {
        signal: combinedSignal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return await this.collectOutput(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        return []; // Timeout or client disconnection — return empty
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
```

### Grep Keyword Extraction Strategy

1. **Literal detection**: If query contains `camelCase` or `snake_case` tokens, use as literal search
2. **Natural language fallback**: Remove stop words, OR-join remaining words
3. **Regex mode**: When `isRegex: true`, pass pattern directly to ripgrep

### Search Response Schema

```typescript
interface SearchResponse {
  results: {
    filePath: string;
    symbolName: string;
    symbolKind: SymbolKind;
    content: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    sources: ('semantic' | 'grep')[];
  }[];
  metadata: {
    totalResults: number;
    searchTimeMs: number;
    indexAge: string;
    queryExpansion?: string;
  };
}
```

## Plugin System

### Language Plugin Interface

```typescript
interface LanguagePlugin {
  readonly languageId: string;
  readonly extensions: string[];
  initParser(): Promise<Parser>;
  getChunkableNodeTypes(): string[];
  extractSymbolName(node: SyntaxNode): string;
  classifySymbol(node: SyntaxNode): SymbolKind;
}
```

### Language Registry

```typescript
class LanguageRegistry {
  private plugins = new Map<string, LanguagePlugin>();
  private extensionMap = new Map<string, string>();

  register(plugin: LanguagePlugin): void;
  resolve(filePath: string): LanguagePlugin | undefined;
  listSupported(): string[];
}
```

- **Core bundle**: TypeScript/JavaScript, Python, Go
- **Dynamic addition**: Call `LanguageRegistry.register()` to add new languages
- **Fallback**: Unsupported files use fixed-line sliding window chunking

### Embedding Provider Interface

```typescript
interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelName: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}
```

### Embedding Configuration

```typescript
interface EmbeddingConfig {
  provider: string;       // "ollama" | "openai-compat"
  baseUrl: string;        // "http://localhost:11434"
  model: string;          // "nomic-embed-text"
  dimensions: number;     // 768
  batchSize: number;      // 32
  timeoutMs: number;      // 30000
}
```

### Ollama Provider Behavior

- Endpoint: `POST http://localhost:11434/api/embed`
- Retry: 3 attempts with exponential backoff
- Timeout: 30s per request
- Batch size: 32 texts per request

### Plugin Registry

```typescript
class PluginRegistry {
  readonly languages: LanguageRegistry;
  readonly embeddings: EmbeddingProviderRegistry;
  async initialize(config: Config): Promise<void>;
  async healthCheck(): Promise<HealthStatus>;
}
```

## Storage Layer

### Dual-Store Architecture

| Store | Technology | Purpose | Location |
|---|---|---|---|
| Vector Store | LanceDB | Embedding vectors + chunk content storage, ANN search | `<dataDir>/vectors/` |
| Metadata Store | better-sqlite3 | Merkle tree state, index stats, config persistence | `<dataDir>/metadata.db` |

`<dataDir>` defaults to `<projectRoot>/.codebase-index/`, added to `.gitignore`.

### Storage Interfaces (TDD / Dependency Injection)

ストレージ層および検索エンジン層の具象クラスに対してインターフェースを定義し、
パイプライン・オーケストレーターの単体テストで In-Memory モックによる高速な
I/O レスなテスト（Red/Green TDD）を可能にする。
これは既存のプラグインインターフェース（`EmbeddingProvider`, `LanguagePlugin`）と
同一の DI パターンを採用しており、設計の一貫性を保つ。

```typescript
/**
 * Vector Store interface for dependency injection.
 * Concrete implementation: LanceDB wrapper.
 * Test implementation: In-memory Map-based mock.
 */
interface IVectorStore {
  /** Insert or update chunks with their embedding vectors */
  upsertChunks(chunks: CodeChunk[]): Promise<void>;

  /** Delete all chunks associated with a file path */
  deleteByFilePath(filePath: string): Promise<number>;

  /** Delete all chunks matching a file path prefix (directory deletion) */
  deleteByPathPrefix(prefix: string): Promise<number>;

  /** ANN search for similar vectors */
  search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]>;

  /** Run compaction if fragmentation exceeds threshold */
  compactIfNeeded(): Promise<CompactionResult>;

  /** Get storage statistics */
  getStats(): Promise<VectorStoreStats>;
}

interface VectorFilter {
  filePath?: string;   // glob pattern
  language?: string;
}

interface VectorSearchResult {
  chunk: CodeChunk;
  distance: number;
}

interface VectorStoreStats {
  totalChunks: number;
  totalFiles: number;
  storageSizeBytes: number;
  fragmentationRatio: number;
}

/**
 * Metadata Store interface for dependency injection.
 * Concrete implementation: better-sqlite3 wrapper.
 * Test implementation: In-memory Map-based mock.
 */
interface IMetadataStore {
  /** Bulk upsert Merkle nodes with batched transactions */
  bulkUpsertMerkleNodes(
    nodes: Array<{ path: string; hash: string; parentPath: string | null; isDirectory: boolean }>,
  ): Promise<void>;

  /** Bulk delete Merkle nodes with batched transactions */
  bulkDeleteMerkleNodes(paths: string[]): Promise<void>;

  /** Get a single Merkle node by path */
  getMerkleNode(path: string): MerkleNodeRow | undefined;

  /** Get all file (non-directory) Merkle nodes */
  getAllFileNodes(): MerkleNodeRow[];

  /** Get all Merkle node paths */
  getAllPaths(): string[];

  /** Delete a single Merkle node */
  deleteMerkleNode(path: string): void;

  /** Delete a subtree by path prefix */
  deleteSubtree(directoryPath: string): Promise<number>;

  /** Get/set index stats */
  getIndexStats(projectPath: string): IndexStatsRow | undefined;
  setIndexStats(stats: IndexStatsRow): void;
}

interface MerkleNodeRow {
  path: string;
  hash: string;
  parentPath: string | null;
  isDirectory: boolean;
  updatedAt: number;
}

interface IndexStatsRow {
  projectPath: string;
  totalFiles: number;
  totalChunks: number;
  lastIndexed: number;
  rootHash: string;
}
```

### Search Engine Interface (TDD / Dependency Injection)

`GrepEngine` は外部プロセス（ripgrep）に直接依存しており、`SearchOrchestrator` の
純粋な単体テストが困難である。`IGrepEngine` インターフェースを定義し、具象クラス
（Ripgrep 実装）とテスト用 In-Memory モック（`TestGrepEngine`）を分離することで、
ripgrep バイナリなしでもオーケストレーターの RRF 統合ロジックをテスト可能にする。

これは `IVectorStore`/`IMetadataStore` と同一の DI パターンであり、設計の一貫性を保つ。

```typescript
/**
 * Grep Engine interface for dependency injection.
 * Concrete implementation: ripgrep child process wrapper.
 * Test implementation: In-memory pattern matching mock.
 */
interface IGrepEngine {
  /** Execute a grep search and return ranked results */
  search(
    params: GrepParams,
    requestSignal?: AbortSignal,
  ): Promise<SearchResult[]>;
}

interface GrepParams {
  pattern: string;
  isRegex?: boolean;
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}
```

**具象クラスとモックの対応:**

| Role | Class | Description |
|---|---|---|
| Production | `RipgrepEngine implements IGrepEngine` | ripgrep 子プロセスを spawn し、semaphore + AbortController で管理 |
| Test | `TestGrepEngine implements IGrepEngine` | In-memory の文字列パターンマッチング。プロセス spawn なし |

```typescript
/**
 * In-memory mock for IGrepEngine.
 * Uses simple string matching for deterministic test results.
 * No child process spawning — pure unit test compatible.
 */
class TestGrepEngine implements IGrepEngine {
  private files = new Map<string, string>(); // filePath → content

  /** Populate test data */
  addFile(filePath: string, content: string): void {
    this.files.set(filePath, content);
  }

  async search(
    params: GrepParams,
    _requestSignal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const [filePath, content] of this.files) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = params.isRegex
          ? new RegExp(params.pattern).test(lines[i])
          : lines[i].includes(params.pattern);

        if (match) {
          results.push({
            chunk: {
              id: `${filePath}:${i + 1}`,
              filePath,
              content: lines[i],
              language: 'unknown',
              symbolName: `line_${i + 1}`,
              symbolKind: 'unknown',
              startLine: i + 1,
              endLine: i + 1,
            },
            score: 1.0,
            source: 'grep',
          });
        }
      }
    }

    return results.slice(0, params.maxResults ?? 100);
  }
}
```

**Pipeline / Orchestrator での利用:**

```typescript
class IndexPipeline {
  constructor(
    private readonly vectorStore: IVectorStore,     // ← interface
    private readonly metadataStore: IMetadataStore,  // ← interface
    private readonly embeddingProvider: EmbeddingProvider,
    // ...
  ) {}
}

class SearchOrchestrator {
  constructor(
    private readonly semanticSearch: SemanticSearch,
    private readonly grepEngine: IGrepEngine,       // ← interface (not concrete GrepEngine)
    private readonly rrfK: number,
  ) {}
}
```

**利用例（オーケストレーター単体テスト）:**

```typescript
describe('SearchOrchestrator', () => {
  let orchestrator: SearchOrchestrator;
  let grepEngine: TestGrepEngine;

  beforeEach(() => {
    grepEngine = new TestGrepEngine();
    grepEngine.addFile('src/utils.ts', 'export function parseConfig() {}\n');
    orchestrator = new SearchOrchestrator(
      new TestSemanticSearch(),
      grepEngine,        // IGrepEngine — ripgrep バイナリ不要
      60,
    );
  });

  it('should fuse semantic and grep results via RRF', async () => {
    // Red → Green → Refactor without ripgrep binary
  });
});
```

### LanceDB Table Schema

| Column | Type | Description |
|---|---|---|
| id | string | Chunk ID (PK) |
| filePath | string | Relative file path |
| content | string | Source code |
| language | string | Language identifier |
| symbolName | string | Symbol name |
| symbolKind | string | Symbol kind |
| startLine | uint32 | Start line |
| endLine | uint32 | End line |
| vector | float32[] | Embedding vector (fixed-size-list) |

### LanceDB Compaction Strategy

LanceDB uses the Lance v2 columnar format, which is append-only by design.
Deletion is implemented as tombstone markers (logical delete), meaning the physical
storage is never reclaimed automatically. Without periodic compaction, disk usage
grows monotonically over time as files are modified and re-indexed.

**Compaction trigger points:**

1. **Post-reindex compaction**: After a full or incremental reindex completes, run compaction
   if the number of accumulated delete tombstones exceeds a threshold
2. **Idle-time compaction**: When the pipeline has been idle for `compactionIdleThresholdMs`
   (default: 300,000ms = 5 minutes), trigger a background compaction pass
3. **Manual compaction**: Exposed via the `index_status` tool response as a recommendation
   when fragmentation ratio exceeds a warning threshold

**Compaction and Pipeline Mutex Integration:**

Compaction is I/O intensive (LanceDB's Rust-based napi-rs bindings consume `libuv`
thread pool slots for file rewriting). Running compaction concurrently with pipeline
index writes causes:

1. `libuv` thread pool exhaustion (default 4 threads) — stalling all async I/O
2. Lance v2 manifest lock contention — triggering internal retries and throughput collapse
3. Disk I/O spikes — degrading ripgrep search latency for concurrent MCP clients

To prevent this, **compaction MUST acquire the Pipeline `AsyncMutex`** before execution.
This ensures mutual exclusion between:

- Watcher-triggered incremental index updates
- Manual `reindex` tool calls
- Background compaction passes

```
[Idle timer fires] ──→ mutex.acquire() ──→ compactIfNeeded() ──→ mutex.release()
[Post-reindex]     ──→ (already holding mutex) ──→ compactIfNeeded() ──→ (continues)

Concurrent scenario:
  [Watcher events]   ──→ mutex.acquire() ──→ processing...
  [Idle compaction]   ──→ mutex.acquire() ──→ WAIT (queued behind pipeline)
                                            ──→ pipeline completes ──→ compaction runs
```

Post-reindex compaction is called **within** the mutex-held reindex execution, so no
additional lock acquisition is needed. Idle-time compaction acquires the mutex independently,
which naturally serializes it against any in-flight pipeline work.

**Compaction operations:**

```
[Pipeline idle / Reindex complete]
       │
       v
  mutex.acquire()  ← required for idle-time compaction; already held for post-reindex
       │
       v
  fragmentation = table.stats().numDeletedRows / table.stats().numRows
       │
       ├── fragmentation < 0.2 → skip (acceptable overhead)
       ├── fragmentation >= 0.2 → trigger compaction
       │     │
       │     ├── table.optimize.compact()       ← merge small fragments
       │     ├── table.optimize.prune()         ← remove tombstoned rows
       │     └── table.cleanupOldVersions()     ← delete old manifest versions
       │
       ├── Log compaction result (rows reclaimed, duration, new size)
       │
       └── mutex.release()  ← for idle-time compaction only
```

```typescript
interface CompactionConfig {
  /** Fragmentation ratio threshold to trigger compaction (default: 0.2 = 20%) */
  fragmentationThreshold: number;
  /** Idle time before background compaction fires (default: 300000ms = 5min) */
  idleThresholdMs: number;
  /** Minimum number of versions to retain (default: 2) */
  minRetainedVersions: number;
}

class VectorStore {
  private compactionTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Run compaction if fragmentation exceeds threshold.
   * Called after reindex completion or on idle timer.
   */
  async compactIfNeeded(): Promise<CompactionResult> {
    const stats = await this.table.stats();
    const fragmentation = stats.numDeletedRows / Math.max(stats.numRows, 1);

    if (fragmentation < this.config.fragmentationThreshold) {
      return { skipped: true, fragmentation };
    }

    const before = await this.getStorageSize();

    // 1. Merge small data fragments into larger files
    await this.table.optimize({ cleanupOlderThan: new Date() });

    // 2. Delete old manifest versions (keep last N)
    await this.table.cleanupOldVersions(
      undefined, // olderThan
      this.config.minRetainedVersions,
    );

    const after = await this.getStorageSize();

    return {
      skipped: false,
      fragmentation,
      bytesReclaimed: before - after,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Schedule compaction after pipeline idle period.
   * Reset the timer whenever new pipeline activity occurs.
   * Idle-time compaction acquires the pipeline mutex to prevent
   * I/O contention with concurrent index writes.
   */
  scheduleIdleCompaction(pipelineMutex: Mutex): void {
    this.cancelIdleCompaction();
    this.compactionTimer = setTimeout(
      () => void pipelineMutex.runExclusive(() => this.compactIfNeeded()),
      this.config.idleThresholdMs,
    );
    if (this.compactionTimer.unref) {
      this.compactionTimer.unref(); // Don't prevent process exit
    }
  }

  cancelIdleCompaction(): void {
    if (this.compactionTimer) {
      clearTimeout(this.compactionTimer);
      this.compactionTimer = null;
    }
  }
}

interface CompactionResult {
  skipped: boolean;
  fragmentation: number;
  bytesReclaimed?: number;
  durationMs?: number;
}
```

### SQLite Metadata Schema

```sql
CREATE TABLE merkle_nodes (
  path        TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  parent_path TEXT REFERENCES merkle_nodes(path),
  is_directory INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_merkle_parent ON merkle_nodes(parent_path);

CREATE TABLE index_stats (
  project_path  TEXT PRIMARY KEY,
  total_files   INTEGER NOT NULL DEFAULT 0,
  total_chunks  INTEGER NOT NULL DEFAULT 0,
  last_indexed  INTEGER NOT NULL,
  root_hash     TEXT NOT NULL
);
```

> **Note:** `parent_path` has a self-referential `REFERENCES` constraint for documentation
> and data integrity validation purposes. However, `ON DELETE CASCADE` is **not** relied upon
> as the primary deletion mechanism — see "Orphan Node Cleanup" below for rationale.

### Orphan Node Cleanup (Merkle Tree Garbage Collection)

When a directory is deleted from the filesystem, all descendant nodes (files and
subdirectories) in the Merkle tree become orphans — they reference a `parent_path`
that no longer exists. Without cleanup, these stale rows accumulate indefinitely,
causing hash inconsistencies and wasted storage.

**Two-tier cleanup strategy:**

#### Tier 1: Application-Level Cascading Delete (Primary)

When the Diff Detector emits a `DeleteEvent` for a directory, the `MetadataStore`
performs a prefix-match deletion of all descendant nodes. This approach is preferred
over SQLite `ON DELETE CASCADE` because:

1. CASCADE on self-referential FKs executes row-by-row recursively, blocking the
   event loop for deep directory trees (unbounded synchronous work)
2. Application-level deletion uses the existing batched transaction pattern with
   cooperative yielding, maintaining event loop responsiveness
3. `better-sqlite3` requires `PRAGMA foreign_keys = ON` per connection (default OFF),
   making CASCADE fragile if accidentally omitted

```typescript
class MetadataStore {
  /**
   * Delete a directory node and all its descendants from the Merkle tree.
   * Uses prefix matching on path for efficient subtree removal.
   * Batched with cooperative yielding to protect the event loop.
   */
  async deleteSubtree(directoryPath: string): Promise<number> {
    // Ensure trailing separator for correct prefix matching
    const prefix = directoryPath.endsWith('/')
      ? directoryPath
      : directoryPath + '/';

    // 1. Collect all descendant paths (single SELECT, no event loop impact)
    const descendants = this.db
      .prepare('SELECT path FROM merkle_nodes WHERE path LIKE ? OR path = ?')
      .all(prefix + '%', directoryPath)
      .map((row: { path: string }) => row.path);

    if (descendants.length === 0) return 0;

    // 2. Batch delete with yielding (reuses existing pattern)
    await this.bulkDeleteMerkleNodes(descendants);

    // 3. Also delete corresponding vectors from LanceDB
    //    (handled by the pipeline's delete flow, not here)

    return descendants.length;
  }
}
```

```
[FS Watcher: directory deleted "src/old-module/"]
       │
       v
  [Diff Detector] ── emit DeleteEvent(path="src/old-module/", isDirectory=true)
       │
       v
  [Pipeline]
       ├── metadataStore.deleteSubtree("src/old-module/")
       │     ├── SELECT paths LIKE 'src/old-module/%'
       │     ├── Batch 1: DELETE 100 rows → COMMIT → yield
       │     ├── Batch 2: DELETE 100 rows → COMMIT → yield
       │     └── ... until all descendants removed
       │
       ├── vectorStore.deleteByPathPrefix("src/old-module/")
       │     └── DELETE FROM chunks WHERE filePath LIKE 'src/old-module/%'
       │
       └── Propagate Merkle hash changes up to root
```

#### Tier 2: Full-Scan Garbage Collection (Safety Net)

During a full reindex (`reindex --fullRebuild`), a GC phase reconciles the
SQLite Merkle tree against the actual filesystem state. This catches any orphans
that may have been missed due to:

- Rapid watcher events being dropped during backpressure mode
- Edge cases in rename detection (partial debounce window)
- External filesystem modifications while the server was stopped

```typescript
/**
 * Garbage-collect orphan Merkle nodes that no longer correspond
 * to files/directories on the filesystem.
 * Called as a final phase of full reindex.
 */
async function gcOrphanNodes(
  metadataStore: MetadataStore,
  projectRoot: string,
): Promise<{ purged: number }> {
  const allNodes = metadataStore.getAllPaths();
  const orphans: string[] = [];

  for (const nodePath of allNodes) {
    const absolutePath = path.resolve(projectRoot, nodePath);
    try {
      await fs.access(absolutePath);
    } catch {
      orphans.push(nodePath);
    }
  }

  if (orphans.length > 0) {
    await metadataStore.bulkDeleteMerkleNodes(orphans);
    logger.info(`GC: purged ${orphans.length} orphan Merkle nodes`);
  }

  return { purged: orphans.length };
}
```

**Design rationale (two-tier approach):**

- Tier 1 handles the common case (explicit delete events) with minimal latency
- Tier 2 handles the edge cases and acts as a consistency checkpoint
- Together they provide **eventual consistency** guarantees — the Merkle tree
  is always consistent after a full reindex, and best-effort consistent during
  incremental updates

### SQLite Event Loop Protection (Batched Transactions)


`better-sqlite3` is a synchronous native addon — every `INSERT`, `UPDATE`, and `SELECT`
blocks the Node.js event loop for the duration of the underlying SQLite C call.
While individual operations complete in microseconds, bulk Merkle tree updates during
branch switching (thousands of nodes) can accumulate into 100-500ms+ of continuous blocking,
disrupting SSE heartbeats and MCP client timeouts.

**Batched transaction strategy:**

Instead of wrapping all updates in a single large transaction (which blocks for the entire
duration), the MetadataStore splits bulk writes into fixed-size batches with cooperative
yielding between them.

```
[Merkle Tree Update: 2,000 nodes]
       │
       ├── Batch 1: BEGIN → 100 INSERTs → COMMIT    (~2ms)
       ├── setImmediate() yield                       ← event loop breathes
       ├── Batch 2: BEGIN → 100 INSERTs → COMMIT    (~2ms)
       ├── setImmediate() yield
       ├── ... (20 batches total)
       └── Batch 20: BEGIN → 100 INSERTs → COMMIT

   Total wall time: ~40ms + 20 yields ≈ ~45ms
   Max continuous block: ~2ms per batch (well within SSE heartbeat tolerance)
```

**Generic Batch Execution Helper (DRY):**

バッチ分割・トランザクション化・yield ロジックは `bulkUpsertMerkleNodes` と `bulkDeleteMerkleNodes`
で完全に重複していたため、汎用ヘルパー関数 `executeBatchedWithYield` に抽出する。
新しいバルク操作（例: DLQ エントリの一括削除）でもこのヘルパーを再利用できる。

```typescript
/**
 * Execute a batched operation with cooperative yielding between batches.
 * Prevents event loop starvation for bulk synchronous SQLite operations.
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items per transaction batch
 * @param action - Synchronous function executed within a transaction per batch
 */
async function executeBatchedWithYield<T>(
  items: T[],
  batchSize: number,
  action: (batch: T[]) => void,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    action(batch);

    // Yield between batches to release event loop
    if (i + batchSize < items.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
```

```typescript
class MetadataStore {
  private readonly db: BetterSqlite3.Database;
  private readonly batchSize: number; // default: 100

  /**
   * Bulk upsert merkle nodes with batched transactions.
   * Yields to the event loop between batches to prevent starvation.
   */
  async bulkUpsertMerkleNodes(
    nodes: Array<{ path: string; hash: string; parentPath: string | null; isDirectory: boolean }>,
  ): Promise<void> {
    const upsertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO merkle_nodes (path, hash, parent_path, is_directory, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    await executeBatchedWithYield(nodes, this.batchSize, (batch) => {
      const runBatch = this.db.transaction((rows: typeof batch) => {
        const now = Date.now();
        for (const node of rows) {
          upsertStmt.run(node.path, node.hash, node.parentPath, node.isDirectory ? 1 : 0, now);
        }
      });
      runBatch(batch);
    });
  }

  /**
   * Bulk delete merkle nodes with batched transactions.
   */
  async bulkDeleteMerkleNodes(paths: string[]): Promise<void> {
    const deleteStmt = this.db.prepare('DELETE FROM merkle_nodes WHERE path = ?');

    await executeBatchedWithYield(paths, this.batchSize, (batch) => {
      const runBatch = this.db.transaction((rows: string[]) => {
        for (const p of rows) {
          deleteStmt.run(p);
        }
      });
      runBatch(batch);
    });
  }
}
```

**Design rationale (Worker Thread rejection):**

`better-sqlite3` does not support sharing a database connection across threads.
Using Worker Threads would require a message-passing proxy pattern (serialize query →
post to worker → deserialize result), adding significant latency and complexity for
operations that complete in microseconds individually. The batched transaction approach
achieves the goal — preventing event loop starvation — with far less overhead.


### Data Integrity

- LanceDB writes are atomic per file (delete old chunks -> insert new chunks as transaction)
- SQLite runs in WAL mode for concurrent read/write
- SQLite bulk writes use batched transactions with cooperative yielding (see above)
- SQLite WAL ファイルの肥大化防止のため、`MetadataStore` 初期化時に `PRAGMA wal_autocheckpoint = 1000`（デフォルト値）を明示設定する。大量ファイルのインデックス作成時（ブランチスイッチ等）でも WAL ファイルが無制限に成長することを防ぎ、チェックポイントを自動的にトリガーする。カスタム値が必要な場合は `metadataStore.walAutocheckpoint` 設定で変更可能。
- When embedding provider is down, events are retried with exponential backoff (max 3 attempts)
- Events that exhaust all retry attempts are moved to the **Dead Letter Queue (DLQ)** rather than blocking the pipeline
  - **Phase 1 fallback (DLQ未実装時):** リトライ上限到達時はエラーログを出力しイベントをスキップする（下記「Retry Exhaustion Fallback」セクション参照）

### Crash Recovery Sequence (Dual-Store Consistency)

LanceDB（ベクトル）とSQLite（Merkleメタデータ）の更新は2つの独立したアトミック操作であり、
プロセスが両操作の間で異常終了した場合（SIGKILL等）、起動時にデータストア間の不整合が発生する。

**不整合パターン:**

| Scenario | LanceDB State | SQLite State | Symptom |
|---|---|---|---|
| Crash after LanceDB write, before SQLite commit | New vectors exist | Merkle hash stale | Orphan vectors (LanceDB has chunks for old hash) |
| Crash after SQLite commit, before LanceDB write | Vectors missing | Merkle hash updated | Phantom entries (SQLite says indexed, vectors absent) |
| Crash during batched SQLite transaction | Vectors exist | Partial Merkle update | Inconsistent subtree hashes |

**Recovery strategy: Startup Reconciliation（起動時突き合わせ）**

~~WAM (Write-Ahead Marker)~~ を廃止し、サーバー起動時に軽量な Reconciliation フェーズを
実行する設計に変更する。WAMは全ファイル保存ごとに SQLite INSERT/DELETE を強制するもので、
ローカルインデクサーとしてはオーバーエンジニアリング（YAGNI違反）であった。

Reconciliation はファイルシステムの実際のハッシュと SQLite 上の Merkle ハッシュを比較し、
不整合がある場合にのみ LanceDB/SQLite をクリーンアップして再インデックスする。
このアプローチは既存の Tier 2 GC (`gcOrphanNodes`) と自然に統合される。

**Reconciliation flow (server startup):**

```
[Server Startup]
       │
       v
  [Reconciliation Phase]
       │
       ├── 1. Load all Merkle nodes from SQLite
       │     └── Map<filePath, storedHash>
       │
       ├── 2. Scan filesystem (respecting .gitignore / ignorePaths)
       │     └── Map<filePath, currentHash>  (xxhash via streaming)
       │
       ├── 3. Compare and classify:
       │     │
       │     ├── In SQLite, NOT on filesystem → ORPHAN
       │     │     ├── Delete from LanceDB (vectors)
       │     │     └── Delete from SQLite (merkle_nodes)
       │     │
       │     ├── On filesystem, NOT in SQLite → MISSING
       │     │     └── Queue for re-indexing (chunk → embed → insert)
       │     │
       │     ├── Both exist, hash MISMATCH → STALE
       │     │     ├── Delete existing vectors from LanceDB
       │     │     └── Queue for re-indexing
       │     │
       │     └── Both exist, hash MATCH → CONSISTENT (skip)
       │
       ├── 4. Execute queued re-indexing (batched, with yielding)
       │
       ├── 5. Log reconciliation summary
       │     └── { consistent, orphaned, missing, stale, reindexed }
       │
       └── Resume normal operation (start watcher, etc.)
```

**Reconciliation implementation:**

```typescript
interface ReconciliationResult {
  consistent: number;
  orphaned: number;
  missing: number;
  stale: number;
  reindexed: number;
  durationMs: number;
}

class IndexPipeline {
  /**
   * Reconcile Dual-Store consistency on server startup.
   * Compares SQLite Merkle hashes against filesystem state
   * and repairs any inconsistencies.
   *
   * This replaces the WAM (Write-Ahead Marker) approach.
   * Rationale: WAM forced per-file INSERT/DELETE on every save,
   * which is YAGNI for a local indexer where crashes are rare.
   * Startup reconciliation is simpler, zero-overhead during
   * normal operation, and handles all inconsistency patterns.
   */
  async reconcileOnStartup(): Promise<ReconciliationResult> {
    const startTime = Date.now();

    // 1. Load stored state from SQLite
    const storedNodes = this.metadataStore.getAllFileNodes(); // non-directory nodes
    const storedMap = new Map(storedNodes.map(n => [n.path, n.hash]));

    // 2. Scan filesystem for current state
    const currentFiles = await this.scanProjectFiles(); // respects ignorePaths
    const currentMap = new Map<string, string>();

    for (const filePath of currentFiles) {
      const hash = await this.computeFileHashStreaming(filePath);
      currentMap.set(filePath, hash);
    }

    // 3. Classify discrepancies
    const orphaned: string[] = [];
    const toReindex: string[] = [];
    let consistent = 0;

    // Files in SQLite but not on filesystem → orphans
    for (const [path, _hash] of storedMap) {
      if (!currentMap.has(path)) {
        orphaned.push(path);
      }
    }

    // Files on filesystem
    for (const [path, currentHash] of currentMap) {
      const storedHash = storedMap.get(path);
      if (!storedHash) {
        // Missing from SQLite → needs indexing
        toReindex.push(path);
      } else if (storedHash !== currentHash) {
        // Hash mismatch → stale, needs re-indexing
        toReindex.push(path);
      } else {
        consistent++;
      }
    }

    // 4. Cleanup orphans
    if (orphaned.length > 0) {
      for (const filePath of orphaned) {
        await this.vectorStore.deleteByFilePath(filePath);
      }
      await this.metadataStore.bulkDeleteMerkleNodes(orphaned);
      logger.info(`Reconciliation: purged ${orphaned.length} orphan entries`);
    }

    // 5. Re-index inconsistent files (batched)
    let reindexed = 0;
    for (const filePath of toReindex) {
      try {
        // delete-before-insert ensures idempotency
        await this.vectorStore.deleteByFilePath(filePath);
        await this.executeStages({
          filePath,
          type: storedMap.has(filePath) ? 'modified' : 'added',
          contentHash: currentMap.get(filePath)!,
        });
        await this.updateMerkleTree({
          filePath,
          type: storedMap.has(filePath) ? 'modified' : 'added',
          contentHash: currentMap.get(filePath)!,
        });
        reindexed++;
      } catch (error) {
        // Non-fatal: log and continue. Will be retried on next startup
        // or picked up by the watcher during normal operation.
        logger.warn(`Reconciliation: failed to re-index ${filePath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result: ReconciliationResult = {
      consistent,
      orphaned: orphaned.length,
      missing: toReindex.filter(p => !storedMap.has(p)).length,
      stale: toReindex.filter(p => storedMap.has(p)).length,
      reindexed,
      durationMs: Date.now() - startTime,
    };

    logger.info('Startup reconciliation complete', result);
    return result;
  }
}
```

**Idempotency mechanism:**

| Recovery scenario | Reconciliation action | Result |
|---|---|---|
| Crash after LanceDB write, before SQLite commit | Hash mismatch detected → delete vectors → re-index | Consistent state restored |
| Crash after SQLite commit, before LanceDB write | Hash match but missing vectors (detected by future search miss) → re-index on next full reconciliation or watcher event | Eventually consistent |
| Crash during batched SQLite transaction | Partial Merkle state → some hashes match, some missing → reconcile each file individually | Consistent state restored |
| Normal shutdown | All hashes match → no action needed (fast path) | No overhead |

**Performance characteristics:**

- **正常時（クラッシュなし）:** 全ファイルのハッシュが一致し、Reconciliation は比較のみで完了。
  ファイル数 N に対して O(N) のハッシュ比較だが、xxhash のストリーミング計算は高速
  （10,000ファイルで約1-3秒程度）
- **クラッシュ後:** 不整合のあるファイルのみ再インデックス。大半のファイルは consistent で
  スキップされるため、全件リビルドに比べて大幅に高速
- **通常運用中のオーバーヘッド:** WAM と異なり、ファイル保存ごとの追加 SQLite I/O は **ゼロ**
- フルスキャンGC（Tier 2）と統合可能。`reconcileOnStartup()` を Tier 2 GC の上位互換として
  位置づけることで、`gcOrphanNodes` を Reconciliation の orphan 検出に統合できる

**Design rationale (WAM廃止の理由):**

- WAM はファイル保存ごとに SQLite INSERT + 正常完了時 DELETE を強制し、ローカルインデクサーとしてはオーバーエンジニアリング
- プロセスクラッシュ自体がレアケースであり、発生しても起動時 Reconciliation で十分にカバー可能
- Reconciliation は通常運用中のオーバーヘッドがゼロ（WAM の INSERT/DELETE が不要）
- 既存の Tier 2 GC や backpressure 後のフルスキャンリコンサイルと自然に統合される

### Retry Exhaustion Fallback (Pre-DLQ)

DLQが未実装の開発初期段階（Phase 1-2）において、エンベディングのリトライが上限に達した
イベントに対する安全なフォールバック挙動を定義する。

**Fallback behavior:**

1. 構造化エラーログを出力（ファイルパス、エラー内容、リトライ回数）
2. イベントをスキップし、パイプラインの処理を継続
3. `index_status` ツールのレスポンスに `skippedFiles` カウンタを追加し、可視化

```typescript
class IndexPipeline {
  private skippedFiles: Map<string, { error: string; timestamp: number }> = new Map();

  private async embedWithRetry(chunks: CodeChunk[], maxRetries: number): Promise<number[][]> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.embeddingProvider.embedBatch(
          chunks.map(c => c.content)
        );
      } catch (error) {
        if (attempt === maxRetries) {
          // Fallback: log and skip (DLQ will replace this in Phase 3)
          logger.error('Embedding failed after all retries, skipping file', {
            filePath: chunks[0]?.filePath,
            error: error instanceof Error ? error.message : String(error),
            retries: maxRetries,
          });
          this.skippedFiles.set(chunks[0]?.filePath ?? 'unknown', {
            error: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          });
          throw new RetryExhaustedError(chunks[0]?.filePath ?? 'unknown', error);
        }
        // Exponential backoff
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 10_000));
      }
    }
    throw new Error('Unreachable');
  }
}

class RetryExhaustedError extends Error {
  readonly code = 'RETRY_EXHAUSTED';
  constructor(public readonly filePath: string, public readonly cause: unknown) {
    super(`Retry exhausted for ${filePath}`);
    this.name = 'RetryExhaustedError';
  }
}
```

**DLQ導入時の移行:**

Phase 3でDLQが実装された際、`RetryExhaustedError` の `catch` ブロックを
「エラーログ＋スキップ」から「DLQへのenqueue」に差し替えるだけで移行が完了する。
`skippedFiles` マップも DLQ のクエリに置き換わる。

### Dead Letter Queue (DLQ)

The DLQ provides an escape hatch for events that cannot be processed due to persistent embedding provider failures.
This prevents the main pipeline from stalling while preserving failed events for later recovery.

**Design:**

- In-memory ring buffer (max 1,000 entries) + SQLite persistence for durability
- Each DLQ entry stores: original event, failure reason, timestamp, retry count
- Events are moved to DLQ only after exhausting all retry attempts (3 retries with exponential backoff)
- A periodic recovery sweep (default: every 60s) attempts to re-process DLQ entries when the embedding provider becomes healthy
- DLQ entries older than 24 hours are automatically purged (configurable)

**DLQ Recovery Flow:**

```
[Pipeline] ── embed fails after 3 retries ──> [DLQ (in-memory + SQLite)]
                                                      │
                                                      │ periodic sweep (60s)
                                                      v
                                               [Health Check: Ollama]
                                                      │
                                         healthy ─────┤───── unhealthy
                                            │                    │
                                            v                    v
                                     [Stale Check]        [Skip, wait next sweep]
                                            │
                                   ┌────────┼────────────────┐
                                   │        │                │
                                file       hash            hash
                                deleted    mismatch        match
                                   │     (file updated)      │
                                   v        v                v
                             [Discard]  [Discard]    [Re-process entry]
                             [log:      [log:               │
                              stale]     superseded]        v
                                                    Success: remove from DLQ
                                                    Failure: increment retry, keep in DLQ
```

**DLQ Stale Entry Detection:**

DLQ エントリがキューに入った後にファイルが更新または削除されている場合、そのエントリは
「stale（陳腐化）」しており、再処理すると最新のインデックス状態を破壊する可能性がある。
スイープ実行時に各エントリの鮮度を検証し、stale エントリを安全に破棄する。

**イベントループ保護 (Streaming Hash):**

`computeFileHash()` は内部でファイル全体を読み込み xxhash を計算する。
DLQ エントリに巨大ファイル（バイナリファイルの誤検出等）が残っている場合、
同期的なハッシュ計算がイベントループをブロックする恐れがある。

この問題を防ぐため、DLQ スイープでは **ストリームベースのハッシュ計算**
(`computeFileHashStreaming()`) を使用する。ストリーム処理により、
ファイルサイズに関わらずイベントループを定期的にyieldする。

```typescript
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Compute file hash using streaming to prevent event loop blocking.
 * For files larger than LARGE_FILE_THRESHOLD, uses partial hashing
 * (first + last chunks) as a fast approximation.
 */
async function computeFileHashStreaming(
  filePath: string,
  opts: { largeFileThreshold?: number } = {},
): Promise<string> {
  const threshold = opts.largeFileThreshold ?? 10 * 1024 * 1024; // 10MB default
  const fileStats = await stat(filePath);

  if (fileStats.size > threshold) {
    // Partial hash for very large files: first 64KB + last 64KB + file size
    // This avoids reading the entire file while still detecting changes
    return computePartialHash(filePath, fileStats.size);
  }

  // Stream-based full hash for normal files
  return new Promise((resolve, reject) => {
    const hasher = createXXHash64();
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

    stream.on('data', (chunk: Buffer) => {
      hasher.update(chunk);
    });
    stream.on('end', () => {
      resolve(hasher.digest('hex'));
    });
    stream.on('error', reject);
  });
}

/**
 * Partial hash: read first 64KB + last 64KB + encode file size.
 * Provides a fast approximation for change detection on very large files.
 */
async function computePartialHash(
  filePath: string,
  fileSize: number,
): Promise<string> {
  const CHUNK_SIZE = 64 * 1024;
  const hasher = createXXHash64();

  // Read first chunk
  const fd = await open(filePath, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize));
    await fd.read(headBuf, 0, headBuf.length, 0);
    hasher.update(headBuf);

    // Read last chunk (if file is large enough to have distinct tail)
    if (fileSize > CHUNK_SIZE) {
      const tailBuf = Buffer.alloc(Math.min(CHUNK_SIZE, fileSize));
      await fd.read(tailBuf, 0, tailBuf.length, fileSize - tailBuf.length);
      hasher.update(tailBuf);
    }

    // Include file size to differentiate files with identical head/tail
    hasher.update(Buffer.from(fileSize.toString()));

    return hasher.digest('hex');
  } finally {
    await fd.close();
  }
}
```

```typescript
class DeadLetterQueue {
  /**
   * Periodic recovery sweep with stale entry detection.
   * Compares DLQ content_hash against current filesystem state
   * to prevent re-processing outdated events.
   *
   * Uses streaming hash computation to prevent event loop blocking
   * for large files that may exist in DLQ entries.
   */
  async recoverySweep(
    pipeline: IndexPipeline,
    metadataStore: MetadataStore,
    embeddingProvider: EmbeddingProvider,
  ): Promise<DLQSweepResult> {
    // 1. Health check — skip sweep entirely if provider is down
    const healthy = await embeddingProvider.healthCheck();
    if (!healthy) {
      return { skipped: true, reason: 'provider_unhealthy' };
    }

    const entries = this.getEntries();
    let processed = 0;
    let discardedStale = 0;
    let discardedDeleted = 0;
    let failed = 0;

    for (const entry of entries) {
      // 2. File existence check
      const fileExists = await pipeline.fileExists(entry.filePath);
      if (!fileExists) {
        // File was deleted after DLQ entry was created — discard safely
        logger.info('DLQ: discarding entry for deleted file', {
          filePath: entry.filePath,
          dlqContentHash: entry.contentHash,
        });
        this.removeEntry(entry.id);
        discardedDeleted++;
        continue;
      }

      // 3. Hash freshness check (using streaming to protect event loop)
      const currentHash = await computeFileHashStreaming(entry.filePath);
      if (currentHash !== entry.contentHash) {
        // File was modified after DLQ entry was created.
        // The normal pipeline has already processed (or will process) the
        // newer version, so this DLQ entry is superseded.
        logger.info('DLQ: discarding superseded entry (hash mismatch)', {
          filePath: entry.filePath,
          dlqContentHash: entry.contentHash,
          currentHash,
        });
        this.removeEntry(entry.id);
        discardedStale++;
        continue;
      }

      // 4. Hash matches — safe to re-process
      try {
        await pipeline.reprocessFromDlq(entry);
        this.removeEntry(entry.id);
        processed++;
      } catch (error) {
        entry.retryCount++;
        entry.updatedAt = Date.now();
        this.updateEntry(entry);
        failed++;
      }
    }

    return {
      skipped: false,
      processed,
      discardedStale,
      discardedDeleted,
      failed,
    };
  }
}

interface DLQSweepResult {
  skipped: boolean;
  reason?: string;
  processed?: number;
  discardedStale?: number;
  discardedDeleted?: number;
  failed?: number;
}
```

**Stale entry determination logic:**

| Condition | Action | Rationale |
|---|---|---|
| File does not exist on disk | Discard DLQ entry | 通常パイプラインの `deleted` イベントで既にクリーンアップ済み |
| File exists, hash mismatch | Discard DLQ entry | ファイルが更新済み。通常パイプラインが最新バージョンを処理済み or 処理予定 |
| File exists, hash match | Re-process DLQ entry | DLQ 登録時と同一のファイル状態。安全に再処理可能 |

**ハッシュ不一致時に「破棄」を選択する理由:**

1. ファイルが更新された場合、Watcher が新しい `modified` イベントを発行し、通常パイプラインで処理される
2. その通常処理も失敗した場合は、**新しい DLQ エントリが新しい `content_hash` で作成される**
3. したがって古い DLQ エントリの再処理は不要であり、むしろ最新状態を上書きするリスクがある
4. 「最新の状態として処理を統合する」選択肢は、DLQ の責務（失敗したイベントのリカバリ）を超えるため採用しない

**SQLite DLQ Schema:**

```sql
CREATE TABLE dead_letter_queue (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,           -- 'added' | 'modified'
  file_path   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  error_message TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_dlq_created ON dead_letter_queue(created_at);
```

### Pipeline Mutex (Reindex Exclusion Control)

The index pipeline uses an `AsyncMutex` to serialize all mutation operations, preventing
corruption from concurrent reindex requests or overlapping watcher-triggered updates.

**Design:**

- A single `Mutex` instance (from `async-mutex` library) guards the entire pipeline execution path
- Both watcher-triggered incremental updates and manual `reindex` tool calls acquire the mutex
- If a `reindex` is requested while another is in progress, the server returns `{ status: 'already_running' }` immediately (non-blocking, idempotent)
- Watcher events that arrive during a locked pipeline are buffered in the event queue (bounded by `maxQueueSize`)
- Lock granularity is intentionally coarse (pipeline-level) — fine-grained locking adds complexity disproportionate to the benefit in a single-process local server
- **フルスキャン実行時は Watcher を停止し、キューをクリアする**（「Full-Scan 中のデススパイラル防止」セクション参照）。これにより、Mutex ロック中にイベントが蓄積して完了直後に再度フルスキャンがトリガーされる無限ループを構造的に排除する

```
[reindex tool] ──> mutex.acquire() ──> [Pipeline Execution] ──> mutex.release()
[watcher event] ──> mutex.acquire() ──> [Pipeline Execution] ──> mutex.release()

Concurrent reindex:
  [Agent A: reindex] ──> mutex.acquire() ──> running...
  [Agent B: reindex] ──> mutex.tryAcquire() ──> FAIL ──> return { status: 'already_running' }

Full-scan reindex (backpressure or manual --fullRebuild):
  [FullScan trigger] ──> watcher.stop() ──> eventQueue.clear()
                     ──> mutex.acquire() ──> [Full Reconciliation]
                     ──> mutex.release() ──> watcher.start()
```

```typescript
import { Mutex } from 'async-mutex';

class IndexPipeline {
  private readonly mutex = new Mutex();

  async reindex(opts: ReindexOptions): Promise<ReindexResult> {
    if (this.mutex.isLocked()) {
      return { status: 'already_running', message: 'Reindex is already in progress' };
    }

    return this.mutex.runExclusive(async () => {
      return this.executeFullReindex(opts);
    });
  }

  async processEvents(events: IndexEvent[]): Promise<void> {
    await this.mutex.runExclusive(async () => {
      for (const event of events) {
        await this.processEvent(event);
      }
    });
  }
}
```

## Devcontainer Setup

### Network Architecture

```
┌─────────────────┐         ┌──────────────────┐
│  Devcontainer    │         │  Host Machine     │
│                  │  HTTP   │                  │
│  MCP Server      │────────>│  Ollama          │
│  (Node.js)       │  :11434 │  (LLM Runtime)   │
│                  │         │                  │
│  ripgrep         │         └──────────────────┘
│  tree-sitter     │
│  LanceDB         │
│  SQLite          │
└─────────────────┘
```

### devcontainer.json

- Base: Node.js 22 LTS
- Features: ripgrep
- Extensions: ESLint, Prettier, Vitest
- Ollama connection: `host.docker.internal:11434` (default)

### Dockerfile

- Base: `node:22-bookworm-slim`
- Install: ripgrep (apt), build-essential + python3 (for better-sqlite3 native build)
- Run as non-root user (`node`)

## Testing Strategy

### Test Layers

| Layer | Type | Target | Tool |
|---|---|---|---|
| Unit | Unit tests | RRF algorithm, Merkle tree, Chunker, Plugin registry | Vitest |
| Integration | Integration tests | Pipeline (Chunker -> Embedder -> LanceDB), full search flow | Vitest + test embedding provider |
| E2E | MCP protocol tests | MCP client tool calls -> response validation | Vitest + MCP SDK client |

### Test Embedding Provider

Deterministic mock provider for external-dependency-free testing:

```typescript
class TestEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'test';
  readonly modelName = 'test-deterministic';
  readonly dimensions = 64;
  // Generates deterministic vectors from text hash
  // Same text always produces same vector -> reproducible test results
}
```

### In-Memory Mocks for Unit Testing (TDD)

`IVectorStore` / `IMetadataStore` インターフェースに基づく In-Memory モックを提供し、
実際のDB接続なしで高速な Red/Green TDD サイクルを実現する。

```typescript
/**
 * In-memory mock for IVectorStore.
 * Uses Map<string, CodeChunk[]> keyed by filePath.
 */
class InMemoryVectorStore implements IVectorStore {
  private store = new Map<string, CodeChunk[]>();

  async upsertChunks(chunks: CodeChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const existing = this.store.get(chunk.filePath) ?? [];
      existing.push(chunk);
      this.store.set(chunk.filePath, existing);
    }
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    const count = this.store.get(filePath)?.length ?? 0;
    this.store.delete(filePath);
    return count;
  }

  async deleteByPathPrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const [key, chunks] of this.store) {
      if (key.startsWith(prefix)) {
        count += chunks.length;
        this.store.delete(key);
      }
    }
    return count;
  }

  async search(
    queryVector: number[],
    topK: number,
    _filter?: VectorFilter,
  ): Promise<VectorSearchResult[]> {
    // Simplified: return first topK chunks with distance=0
    const all = [...this.store.values()].flat();
    return all.slice(0, topK).map(chunk => ({ chunk, distance: 0 }));
  }

  async compactIfNeeded(): Promise<CompactionResult> {
    return { skipped: true, fragmentation: 0 };
  }

  async getStats(): Promise<VectorStoreStats> {
    const allChunks = [...this.store.values()].flat();
    return {
      totalChunks: allChunks.length,
      totalFiles: this.store.size,
      storageSizeBytes: 0,
      fragmentationRatio: 0,
    };
  }
}

/**
 * In-memory mock for IMetadataStore.
 * Uses Map<string, MerkleNodeRow> keyed by path.
 */
class InMemoryMetadataStore implements IMetadataStore {
  private nodes = new Map<string, MerkleNodeRow>();
  private stats = new Map<string, IndexStatsRow>();

  async bulkUpsertMerkleNodes(
    nodes: Array<{ path: string; hash: string; parentPath: string | null; isDirectory: boolean }>,
  ): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.path, {
        ...node,
        updatedAt: Date.now(),
      });
    }
  }

  async bulkDeleteMerkleNodes(paths: string[]): Promise<void> {
    for (const path of paths) {
      this.nodes.delete(path);
    }
  }

  getMerkleNode(path: string): MerkleNodeRow | undefined {
    return this.nodes.get(path);
  }

  getAllFileNodes(): MerkleNodeRow[] {
    return [...this.nodes.values()].filter(n => !n.isDirectory);
  }

  getAllPaths(): string[] {
    return [...this.nodes.keys()];
  }

  deleteMerkleNode(path: string): void {
    this.nodes.delete(path);
  }

  async deleteSubtree(directoryPath: string): Promise<number> {
    const prefix = directoryPath.endsWith('/') ? directoryPath : directoryPath + '/';
    let count = 0;
    for (const key of this.nodes.keys()) {
      if (key === directoryPath || key.startsWith(prefix)) {
        this.nodes.delete(key);
        count++;
      }
    }
    return count;
  }

  getIndexStats(projectPath: string): IndexStatsRow | undefined {
    return this.stats.get(projectPath);
  }

  setIndexStats(stats: IndexStatsRow): void {
    this.stats.set(stats.projectPath, stats);
  }
}
```

**利用例（パイプライン単体テスト）:**

```typescript
describe('IndexPipeline', () => {
  let pipeline: IndexPipeline;
  let vectorStore: InMemoryVectorStore;
  let metadataStore: InMemoryMetadataStore;

  beforeEach(() => {
    vectorStore = new InMemoryVectorStore();
    metadataStore = new InMemoryMetadataStore();
    pipeline = new IndexPipeline(
      vectorStore,     // IVectorStore
      metadataStore,   // IMetadataStore
      new TestEmbeddingProvider(),
    );
  });

  it('should index a file and store chunks', async () => {
    // Red → Green → Refactor without any DB setup
  });
});
```

### Key Coverage Areas

1. **Merkle Tree**: Correct hash propagation on file add/change/delete, rename detection (same-hash delete+add pairs), **subtree deletion cascading (directory delete → all descendants removed)**
2. **Chunker**: Correct AST node chunking per language, large node re-splitting, event loop yielding under large files, **AST parse failsafe fallback to line-based chunking**
3. **RRF Fusion**: Score calculation matches formula, handling of single-source results
4. **Event Queue**: Debounce, priority, concurrency limit correctness, **backpressure threshold triggering, full-scan fallback on overflow**, **フルスキャン中の Watcher 停止＋キュークリアによるデススパイラル防止**
5. **Search Orchestrator**: Semantic/grep parallel execution -> RRF fusion integration flow, **`IGrepEngine` モック注入による ripgrep 不要な RRF 統合テスト**
6. **Grep Semaphore**: Concurrent request limiting, queue ordering, timeout enforcement, **AbortController signal propagation, process cleanup on client disconnection**
7. **Rename Pipeline**: Vector reuse on file rename (LanceDB filePath update without re-embedding)
8. **Dead Letter Queue**: Event retirement after retry exhaustion, periodic recovery sweep, DLQ purge after TTL, **stale entry detection（ファイル削除済みエントリの安全な破棄）**, **hash mismatch handling（DLQ `content_hash` と現在のファイルハッシュ不一致時のエントリ破棄＋ログ記録）**, **hash match re-processing（ハッシュ一致時のみ再処理が実行され成功時に DLQ から除去）**, **race condition safety（DLQ スイープ中のファイル削除/更新に対する防御的ハンドリング）**
9. **Pipeline Mutex**: Concurrent reindex rejection (idempotent `already_running`), watcher event serialization, no deadlock under error conditions, **compaction serialization with index writes**, **フルスキャン時の Watcher 停止・キュークリア・再開のライフサイクル検証**
10. **LanceDB Compaction**: Fragmentation threshold detection, post-reindex compaction trigger, idle-time scheduling, version retention, **mutex acquisition before compaction execution**
11. **SQLite Batched Writes**: Batch size boundary correctness, event loop yielding between batches, partial-failure atomicity, **WAL autocheckpoint 設定の初期化検証**
12. **Path Sanitization**: Path traversal rejection (`../` escape), glob pattern validation, `PathTraversalError` response for all tool handlers
13. **Orphan Node GC**: Full-scan GC reconciles SQLite Merkle tree against filesystem, purging stale nodes after missed events
14. **Startup Reconciliation**: SQLite Merkle ハッシュ vs ファイルシステムハッシュの突き合わせ検証、orphan 検出と LanceDB/SQLite クリーンアップ、hash mismatch ファイルの再インデックス、正常終了時の fast-path（全 consistent で処理ゼロ）、**シミュレート SIGKILL 後の Dual-Store 整合性復元**、**部分書き込み状態からのリカバリ後 vector 数一致**、**Reconciliation 中の Watcher イベント到着に対する Mutex 排他制御**
15. **Retry Exhaustion Fallback**: `RetryExhaustedError` propagation, `skippedFiles` tracking, error log output on retry exhaustion, graceful pipeline continuation
16. **License Audit**: `npm run license:check` rejects disallowed licenses, `NOTICE` file generation accuracy
17. **Storage / Search Interface Mocks**: `InMemoryVectorStore` / `InMemoryMetadataStore` / `TestGrepEngine` による I/O レスな単体テスト、DI 経由のモック注入でパイプライン・オーケストレーターロジックのみを分離テスト

### Test Fixtures

```
tests/fixtures/
├── sample-project/          # Small sample project
│   ├── src/
│   │   ├── auth.ts          # TypeScript: functions, classes, interfaces
│   │   ├── utils.py         # Python: functions, decorators
│   │   └── handler.go       # Go: struct, methods
│   └── package.json
└── large-project/           # Large-scale test (generated by script)
```

## Configuration

```typescript
interface Config {
  server: {
    transport: 'sse' | 'streamable-http';
    port: number;                  // default: 3399
    host: string;                  // default: "localhost"
  };
  indexer: {
    dataDir: string;               // default: ".codebase-index"
    watchEnabled: boolean;         // default: true
    debounceMs: number;            // default: 100
    concurrency: number;           // default: 4
    maxChunkLines: number;         // default: 200
    ignorePaths: string[];         // default: ["node_modules", ".git", "dist", ...]
    maxQueueSize: number;          // default: 10000 (max events in queue before rejection)
    fullScanThreshold: number;     // default: 5000 (trigger full-scan fallback)
    maxRetries: number;            // default: 3 (embedding retry attempts)
  };
  embedding: {
    provider: string;              // default: "ollama"
    baseUrl: string;               // default: "http://host.docker.internal:11434"
    model: string;                 // default: "nomic-embed-text"
    dimensions: number;            // default: 768
    batchSize: number;             // default: 32
  };
  dlq: {
    maxSize: number;               // default: 1000 (max DLQ entries in memory)
    recoverySweepIntervalMs: number; // default: 60000 (recovery sweep interval)
    ttlMs: number;                 // default: 86400000 (24h TTL for DLQ entries)
  };
  search: {
    defaultTopK: number;           // default: 20
    rrfK: number;                  // default: 60
    semanticWeight: number;        // default: 1.0
    grepWeight: number;            // default: 1.0
    grepMaxResults: number;        // default: 100
    grepMaxConcurrency: number;    // default: 4 (max concurrent ripgrep processes)
    grepTimeoutMs: number;         // default: 10000 (per-process timeout for ripgrep)
  };
  compaction: {
    fragmentationThreshold: number; // default: 0.2 (trigger compaction at 20% tombstones)
    idleThresholdMs: number;       // default: 300000 (5min idle before background compaction)
    minRetainedVersions: number;   // default: 2 (Lance manifest versions to keep)
  };
  metadataStore: {
    batchSize: number;             // default: 100 (rows per SQLite batched transaction)
    walAutocheckpoint: number;     // default: 1000 (WAL auto-checkpoint threshold in pages)
  };
  languages: {
    builtIn: string[];             // default: ["typescript", "python", "go"]
  };
}
```

### Config Loading Priority

1. Environment variables (`CODEBASE_INDEX_*`)
2. Project root config file (`.codebase-index.json`)
3. Default values

## Technology Stack Summary

| Component | Technology | Version | License |
|---|---|---|---|
| Runtime | Node.js | 22 LTS | MIT |
| Language | TypeScript | 5.x | Apache-2.0 |
| MCP SDK | @modelcontextprotocol/sdk | latest | MIT |
| AST Parser | tree-sitter (web-tree-sitter) | latest | MIT |
| Vector Store | LanceDB (@lancedb/lancedb) | latest | Apache-2.0 |
| Metadata Store | better-sqlite3 | latest | MIT |
| Grep Engine | ripgrep (child process) | latest | Unlicense/MIT |
| FS Watcher | chokidar | latest | MIT |
| Hash | xxhash (xxhash-wasm) | latest | MIT |
| Test Runner | Vitest | latest | MIT |
| Linter | ESLint (flat config) | latest | MIT |
| Formatter | Prettier | latest | MIT |
| Embedding (default) | Ollama (nomic-embed-text) | local | MIT |

## Third-Party License Management

MITライセンスで提供される本プロジェクトでは、サードパーティの依存関係およびバンドルバイナリの
ライセンス互換性を継続的に管理する。

### License Compatibility Policy

| Category | Allowed Licenses | Restricted Licenses |
|---|---|---|
| npm dependencies | MIT, ISC, BSD-2, BSD-3, Apache-2.0, Unlicense, CC0 | GPL-2.0, GPL-3.0, AGPL (copyleft — バンドル不可) |
| Bundled binaries | MIT, Unlicense, Apache-2.0, BSD | GPL (動的リンクのみ許可、静的バンドル禁止) |
| WASM modules | MIT, Apache-2.0, BSD | GPL (WASMは静的リンク相当のため不可) |

### Automated License Audit

`license-checker` をCIパイプラインに統合し、ビルド時にライセンス互換性を自動検証する。

```json
// package.json (scripts)
{
  "scripts": {
    "license:check": "license-checker --production --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0;Unlicense;CC0-1.0;0BSD' --excludePrivatePackages",
    "license:report": "license-checker --production --csv --out THIRD_PARTY_LICENSES.csv",
    "license:notice": "generate-license-file --input package.json --output NOTICE --overwrite"
  }
}
```

**CI integration:**

```
[CI Pipeline]
       │
       ├── npm ci
       ├── npm run license:check    ← 禁止ライセンスの検出で build fail
       ├── npm run license:notice   ← NOTICE ファイルの自動生成
       └── npm run build
```

### NOTICE File

プロジェクトルートに `NOTICE` ファイルを配置し、バンドルされる全サードパーティコンポーネントの
ライセンス表記をまとめる。`generate-license-file` により自動生成し、リリース時にパッケージに同梱する。

```
NOTICE
======

This product includes software developed by third parties.
See below for their respective license terms.

---
ripgrep (https://github.com/BurntSushi/ripgrep)
License: The Unlicense / MIT
Copyright (c) Andrew Gallant

---
tree-sitter (https://github.com/tree-sitter/tree-sitter)
License: MIT
Copyright (c) Tree-sitter contributors

---
... (auto-generated by generate-license-file)
```

### Bundled Binary Tracking

Devcontainerに同梱されるネイティブバイナリ（ripgrep等）は、Dockerfileの
インストールステップにライセンス確認コメントを付記する。

```dockerfile
# ripgrep — License: Unlicense/MIT (compatible with MIT project license)
# See: https://github.com/BurntSushi/ripgrep/blob/master/LICENSE-MIT
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep
```

npmパッケージとして配布する場合、`postinstall` スクリプトでダウンロードする
外部バイナリがあれば、そのライセンス情報を `NOTICE` ファイルに含める。

## Implementation Plan (Phases)

Staged development milestones ordered by dependency chain.
Each phase produces a testable, demonstrable increment.

### Phase 1: Core Pipeline Foundation

**Goal:** End-to-end flow from file change detection to indexed vector storage.

| # | Task | Key Deliverables | Estimated Effort |
|---|------|-------------------|------------------|
| 1.1 | Project scaffold | `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, Devcontainer, **license audit script** | 0.5d |
| 1.2 | Type definitions | `src/types/index.ts` — all shared interfaces, **`RetryExhaustedError`** | 0.5d |
| 1.3 | Metadata Store (SQLite) | `better-sqlite3` wrapper, schema migration, batched transaction API (`executeBatchedWithYield`), WAL mode, **`IMetadataStore` インターフェース** | 1d |
| 1.4 | Merkle Tree | In-memory tree + SQLite persistence, xxhash leaf nodes, diff detection | 1.5d |
| 1.5 | Chunker | tree-sitter integration, AST-based chunking, fixed-line fallback, event loop yielding | 1.5d |
| 1.6 | Embedding Provider (Ollama) | Plugin interface, Ollama provider, batch embed, health check, retry with backoff, **リトライ上限フォールバック（ログ出力＋スキップ）** | 1d |
| 1.7 | Vector Store (LanceDB) | Table creation, upsert/delete/search, compaction scheduling, **`IVectorStore` インターフェース** | 1d |
| 1.8 | Event Queue | Priority queue, debounce, `p-limit` concurrency control | 1d |
| 1.9 | FS Watcher | chokidar wrapper, pause/resume for backpressure | 0.5d |
| 1.10 | Pipeline Integration | Wire all components, `AsyncMutex`, incremental + full reindex, **起動時 Reconciliation（Dual-Store 整合性チェック）** | 1.5d |

**Exit criteria:** `npm run test:unit` passes. Manual `reindex` on a sample project populates LanceDB. **リトライ上限イベントはエラーログに記録されスキップされる。異常終了テスト後の再起動で Reconciliation が Dual-Store の不整合を検出・修復する。** `InMemoryVectorStore` / `InMemoryMetadataStore` による I/O レス単体テストが動作する。

### Phase 2: Search & MCP Server Layer

**Goal:** Functional MCP server with all 6 tools accessible by AI agents.

| # | Task | Key Deliverables | Estimated Effort |
|---|------|-------------------|------------------|
| 2.1 | Semantic Search | LanceDB ANN query wrapper, top-K retrieval | 0.5d |
| 2.2 | Grep Search (ripgrep) | **`IGrepEngine` インターフェース**, `RipgrepEngine` with semaphore, `AbortController` timeout, keyword extraction, **`TestGrepEngine` モック** | 1d |
| 2.3 | RRF Fusion | Score fusion algorithm, orchestrator (parallel semantic + grep) | 0.5d |
| 2.4 | MCP Server & Transport | SSE/StreamableHTTP transport, multi-client support | 1d |
| 2.5 | Tool Handlers | `hybrid_search`, `semantic_search`, `grep_search`, `get_context`, `index_status`, `reindex` | 1.5d |
| 2.6 | Plugin Registry | Language registry, embedding provider registry, dynamic registration | 0.5d |
| 2.7 | Configuration | Config loading (env → file → defaults), validation | 0.5d |
| 2.8 | Integration Tests | Pipeline E2E, search flow, MCP protocol tests with test embedding provider | 1.5d |

**Exit criteria:** MCP client can connect, call `hybrid_search`, and receive ranked results. **`TestGrepEngine` を用いた `SearchOrchestrator` の単体テストが ripgrep バイナリなしで動作する。**

### Phase 3: Resilience & Edge Cases

**Goal:** Production-grade reliability under adversarial conditions.

| # | Task | Key Deliverables | Estimated Effort |
|---|------|-------------------|------------------|
| 3.1 | Dead Letter Queue | In-memory ring buffer + SQLite persistence, periodic recovery sweep, **Phase 1の `RetryExhaustedError` catch をDLQ enqueueに差し替え** | 1d |
| 3.2 | Backpressure | Queue threshold detection, watcher pause/resume, full-scan fallback state machine, **フルスキャン中の Watcher 停止＋キュークリアによるデススパイラル防止** | 1d |
| 3.3 | File Rename Optimization | Same-hash detection in debounce window, vector reuse without re-embedding | 0.5d |
| 3.4 | LanceDB Compaction | Fragmentation monitoring, idle-time + post-reindex compaction triggers, **Pipeline Mutex integration for I/O exclusion** | 0.5d |
| 3.5 | SQLite Batched Writes | Bulk upsert/delete with cooperative yielding, performance benchmarking | 0.5d |
| 3.6 | Grep Zombie Prevention | `AbortController` + `AbortSignal.any()` integration, process tree cleanup | 0.5d |
| 3.7 | Additional Language Plugins | Python, Go tree-sitter grammars | 1d |
| 3.8 | Stress Testing | Branch-switch simulation (10k+ events), concurrent multi-agent access, large repo (100k files), **クラッシュリカバリシナリオテスト** | 1d |
| 3.9 | Documentation & Release | README, configuration reference, MCP tool documentation, **NOTICE ファイル同梱** | 0.5d |
| 3.10 | Input Path Sanitization | `PathSanitizer` utility, tool handler integration, path traversal error handling | 0.5d |
| 3.11 | Merkle Tree Orphan Cleanup | Subtree prefix-match deletion, full-scan GC reconciliation phase | 0.5d |

**Exit criteria:** All unit/integration/E2E tests pass. System survives branch-switch flood and concurrent reindex without OOM, zombie processes, or data corruption. Path traversal attacks return appropriate error responses. Full reindex leaves zero orphan Merkle nodes. **DLQ導入によりPhase 1の `skippedFiles` フォールバックが完全に置換されている。** **フルスキャン後に fullScanThreshold を超えるイベント蓄積が発生しないことがストレステストで検証されている（デススパイラル防止）。**

### Phase Dependency Graph

```
Phase 1 (Core Pipeline)
  │
  ├──→ Phase 2 (Search & MCP)     ← depends on storage + pipeline from Phase 1
  │         │
  └──→ Phase 3 (Resilience)        ← depends on both Phase 1 and Phase 2
```

**Total estimated effort:** ~22 developer-days (single developer).
