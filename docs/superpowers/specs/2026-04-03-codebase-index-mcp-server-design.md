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
│   │   ├── grep.ts                  # ripgrep search engine
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
  [FullScan] ── trigger merkle-tree full reconciliation
     │
     │ full-scan complete
     v
  [Normal] ── watcher.resume()

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

- `GrepEngine` holds a module-level semaphore (`p-limit`) limiting concurrent ripgrep child processes
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

class GrepEngine {
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

**Compaction operations:**

```
[Pipeline idle / Reindex complete]
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
       └── Log compaction result (rows reclaimed, duration, new size)
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
   */
  scheduleIdleCompaction(): void {
    this.cancelIdleCompaction();
    this.compactionTimer = setTimeout(
      () => void this.compactIfNeeded(),
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
  parent_path TEXT,
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

    for (let i = 0; i < nodes.length; i += this.batchSize) {
      const batch = nodes.slice(i, i + this.batchSize);

      // Synchronous transaction — but bounded to batchSize rows
      const runBatch = this.db.transaction((rows: typeof batch) => {
        const now = Date.now();
        for (const node of rows) {
          upsertStmt.run(node.path, node.hash, node.parentPath, node.isDirectory ? 1 : 0, now);
        }
      });

      runBatch(batch);

      // Yield between batches to release event loop
      if (i + this.batchSize < nodes.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  /**
   * Bulk delete merkle nodes with batched transactions.
   */
  async bulkDeleteMerkleNodes(paths: string[]): Promise<void> {
    const deleteStmt = this.db.prepare('DELETE FROM merkle_nodes WHERE path = ?');

    for (let i = 0; i < paths.length; i += this.batchSize) {
      const batch = paths.slice(i, i + this.batchSize);

      const runBatch = this.db.transaction((rows: string[]) => {
        for (const path of rows) {
          deleteStmt.run(path);
        }
      });

      runBatch(batch);

      if (i + this.batchSize < paths.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
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
- When embedding provider is down, events are retried with exponential backoff (max 3 attempts)
- Events that exhaust all retry attempts are moved to the **Dead Letter Queue (DLQ)** rather than blocking the pipeline

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
                                    [Re-process batch]    [Skip, wait next sweep]
                                            │
                                            v
                                    Success: remove from DLQ
                                    Failure: increment retry, keep in DLQ
```

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

```
[reindex tool] ──> mutex.acquire() ──> [Pipeline Execution] ──> mutex.release()
[watcher event] ──> mutex.acquire() ──> [Pipeline Execution] ──> mutex.release()

Concurrent reindex:
  [Agent A: reindex] ──> mutex.acquire() ──> running...
  [Agent B: reindex] ──> mutex.tryAcquire() ──> FAIL ──> return { status: 'already_running' }
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

### Key Coverage Areas

1. **Merkle Tree**: Correct hash propagation on file add/change/delete, rename detection (same-hash delete+add pairs)
2. **Chunker**: Correct AST node chunking per language, large node re-splitting, event loop yielding under large files, **AST parse failsafe fallback to line-based chunking**
3. **RRF Fusion**: Score calculation matches formula, handling of single-source results
4. **Event Queue**: Debounce, priority, concurrency limit correctness, **backpressure threshold triggering, full-scan fallback on overflow**
5. **Search Orchestrator**: Semantic/grep parallel execution -> RRF fusion integration flow
6. **Grep Semaphore**: Concurrent request limiting, queue ordering, timeout enforcement, **AbortController signal propagation, process cleanup on client disconnection**
7. **Rename Pipeline**: Vector reuse on file rename (LanceDB filePath update without re-embedding)
8. **Dead Letter Queue**: Event retirement after retry exhaustion, periodic recovery sweep, DLQ purge after TTL
9. **Pipeline Mutex**: Concurrent reindex rejection (idempotent `already_running`), watcher event serialization, no deadlock under error conditions
10. **LanceDB Compaction**: Fragmentation threshold detection, post-reindex compaction trigger, idle-time scheduling, version retention
11. **SQLite Batched Writes**: Batch size boundary correctness, event loop yielding between batches, partial-failure atomicity

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

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | 22 LTS |
| Language | TypeScript | 5.x |
| MCP SDK | @modelcontextprotocol/sdk | latest |
| AST Parser | tree-sitter (web-tree-sitter) | latest |
| Vector Store | LanceDB (@lancedb/lancedb) | latest |
| Metadata Store | better-sqlite3 | latest |
| Grep Engine | ripgrep (child process) | latest |
| FS Watcher | chokidar | latest |
| Hash | xxhash (xxhash-wasm) | latest |
| Test Runner | Vitest | latest |
| Linter | ESLint (flat config) | latest |
| Formatter | Prettier | latest |
| Embedding (default) | Ollama (nomic-embed-text) | local |

## Implementation Plan (Phases)

Staged development milestones ordered by dependency chain.
Each phase produces a testable, demonstrable increment.

### Phase 1: Core Pipeline Foundation

**Goal:** End-to-end flow from file change detection to indexed vector storage.

| # | Task | Key Deliverables | Estimated Effort |
|---|------|-------------------|------------------|
| 1.1 | Project scaffold | `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, Devcontainer | 0.5d |
| 1.2 | Type definitions | `src/types/index.ts` — all shared interfaces | 0.5d |
| 1.3 | Metadata Store (SQLite) | `better-sqlite3` wrapper, schema migration, batched transaction API, WAL mode | 1d |
| 1.4 | Merkle Tree | In-memory tree + SQLite persistence, xxhash leaf nodes, diff detection | 1.5d |
| 1.5 | Chunker | tree-sitter integration, AST-based chunking, fixed-line fallback, event loop yielding | 1.5d |
| 1.6 | Embedding Provider (Ollama) | Plugin interface, Ollama provider, batch embed, health check, retry with backoff | 1d |
| 1.7 | Vector Store (LanceDB) | Table creation, upsert/delete/search, compaction scheduling | 1d |
| 1.8 | Event Queue | Priority queue, debounce, `p-limit` concurrency control | 1d |
| 1.9 | FS Watcher | chokidar wrapper, pause/resume for backpressure | 0.5d |
| 1.10 | Pipeline Integration | Wire all components, `AsyncMutex`, incremental + full reindex | 1.5d |

**Exit criteria:** `npm run test:unit` passes. Manual `reindex` on a sample project populates LanceDB.

### Phase 2: Search & MCP Server Layer

**Goal:** Functional MCP server with all 6 tools accessible by AI agents.

| # | Task | Key Deliverables | Estimated Effort |
|---|------|-------------------|------------------|
| 2.1 | Semantic Search | LanceDB ANN query wrapper, top-K retrieval | 0.5d |
| 2.2 | Grep Search (ripgrep) | `GrepEngine` with semaphore, `AbortController` timeout, keyword extraction | 1d |
| 2.3 | RRF Fusion | Score fusion algorithm, orchestrator (parallel semantic + grep) | 0.5d |
| 2.4 | MCP Server & Transport | SSE/StreamableHTTP transport, multi-client support | 1d |
| 2.5 | Tool Handlers | `hybrid_search`, `semantic_search`, `grep_search`, `get_context`, `index_status`, `reindex` | 1.5d |
| 2.6 | Plugin Registry | Language registry, embedding provider registry, dynamic registration | 0.5d |
| 2.7 | Configuration | Config loading (env → file → defaults), validation | 0.5d |
| 2.8 | Integration Tests | Pipeline E2E, search flow, MCP protocol tests with test embedding provider | 1.5d |

**Exit criteria:** MCP client can connect, call `hybrid_search`, and receive ranked results.

### Phase 3: Resilience & Edge Cases

**Goal:** Production-grade reliability under adversarial conditions.

| # | Task | Key Deliverables | Estimated Effort |
|---|------|-------------------|------------------|
| 3.1 | Dead Letter Queue | In-memory ring buffer + SQLite persistence, periodic recovery sweep | 1d |
| 3.2 | Backpressure | Queue threshold detection, watcher pause/resume, full-scan fallback state machine | 1d |
| 3.3 | File Rename Optimization | Same-hash detection in debounce window, vector reuse without re-embedding | 0.5d |
| 3.4 | LanceDB Compaction | Fragmentation monitoring, idle-time + post-reindex compaction triggers | 0.5d |
| 3.5 | SQLite Batched Writes | Bulk upsert/delete with cooperative yielding, performance benchmarking | 0.5d |
| 3.6 | Grep Zombie Prevention | `AbortController` + `AbortSignal.any()` integration, process tree cleanup | 0.5d |
| 3.7 | Additional Language Plugins | Python, Go tree-sitter grammars | 1d |
| 3.8 | Stress Testing | Branch-switch simulation (10k+ events), concurrent multi-agent access, large repo (100k files) | 1d |
| 3.9 | Documentation & Release | README, configuration reference, MCP tool documentation | 0.5d |

**Exit criteria:** All unit/integration/E2E tests pass. System survives branch-switch flood and concurrent reindex without OOM, zombie processes, or data corruption.

### Phase Dependency Graph

```
Phase 1 (Core Pipeline)
  │
  ├──→ Phase 2 (Search & MCP)     ← depends on storage + pipeline from Phase 1
  │         │
  └──→ Phase 3 (Resilience)        ← depends on both Phase 1 and Phase 2
```

**Total estimated effort:** ~22 developer-days (single developer).
