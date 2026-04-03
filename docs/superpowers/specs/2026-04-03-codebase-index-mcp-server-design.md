# Local Codebase Index MCP Server - Design Specification

## Overview

A locally-complete codebase index MCP server inspired by Cursor IDE's advanced codebase indexing architecture, accessible cross-functionally from multiple AI agents. All data remains on the local machine (Zero Data Retention principle), with embedding inference handled by local endpoints such as Ollama.

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
| Embedding Default | Ollama (local) | Zero data retention, no external API calls by default |
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
│   │   ├── pipeline.ts              # Index pipeline integration
│   │   ├── event-queue.ts           # Async event queue
│   │   ├── merkle-tree.ts           # Merkle tree diff detection
│   │   ├── chunker.ts              # tree-sitter chunking integration
│   │   └── watcher.ts              # FS watcher
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
- **Backpressure**: Buffer watcher events when queue size exceeds threshold

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

```typescript
async function chunkFiles(files: FileToChunk[]): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];

  for (const file of files) {
    // 1. Parse AST (synchronous, unavoidable — but bounded per-file)
    const tree = parser.parse(file.content);

    // 2. Traverse and extract chunks with periodic yielding
    const chunks = await extractChunksWithYield(tree.rootNode, file);
    allChunks.push(...chunks);

    // 3. Yield between files to release event loop
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
```

**Design rationale:**

- `setImmediate` is preferred over `setTimeout(0)` — it fires at the end of the current I/O cycle
  without the minimum 1ms timer delay, giving other I/O callbacks a chance to run
- Per-file yielding is the primary protection (most files parse in < 10ms)
- Intra-file yielding (every 50 nodes) handles edge cases of very large files
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

```typescript
class GrepEngine {
  private readonly semaphore: pLimit.Limit;

  constructor(config: SearchConfig) {
    this.semaphore = pLimit(config.grepMaxConcurrency); // default: 4
  }

  async search(params: GrepParams): Promise<SearchResult[]> {
    return this.semaphore(() => this.executeRipgrep(params));
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

### Data Integrity

- LanceDB writes are atomic per file (delete old chunks -> insert new chunks as transaction)
- SQLite runs in WAL mode for concurrent read/write
- When embedding provider is down, events are held in queue and reprocessed on recovery

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
2. **Chunker**: Correct AST node chunking per language, large node re-splitting, event loop yielding under large files
3. **RRF Fusion**: Score calculation matches formula, handling of single-source results
4. **Event Queue**: Debounce, priority, concurrency limit correctness
5. **Search Orchestrator**: Semantic/grep parallel execution -> RRF fusion integration flow
6. **Grep Semaphore**: Concurrent request limiting, queue ordering, timeout enforcement
7. **Rename Pipeline**: Vector reuse on file rename (LanceDB filePath update without re-embedding)

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
  };
  embedding: {
    provider: string;              // default: "ollama"
    baseUrl: string;               // default: "http://host.docker.internal:11434"
    model: string;                 // default: "nomic-embed-text"
    dimensions: number;            // default: 768
    batchSize: number;             // default: 32
  };
  search: {
    defaultTopK: number;           // default: 20
    rrfK: number;                  // default: 60
    semanticWeight: number;        // default: 1.0
    grepWeight: number;            // default: 1.0
    grepMaxResults: number;        // default: 100
    grepMaxConcurrency: number;    // default: 4 (max concurrent ripgrep processes)
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
