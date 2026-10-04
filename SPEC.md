# Nexus Technical Specification

This document is the canonical source for **current** Nexus architecture invariants and behavioral contracts. It does not define future roadmap targets; see [ROADMAP.md](ROADMAP.md) for planned work. Detailed MCP tool inputs, outputs, and status fields belong in [docs/mcp-tools.md](docs/mcp-tools.md).

## 1. Product Boundary

Nexus is a local-first code indexing and retrieval service exposed through Model Context Protocol (MCP). It combines:

- file watching and incremental indexing;
- semantic vector search;
- ripgrep text search;
- AST-aware chunking and a structured symbol catalog;
- exact symbol retrieval from the current working tree;
- SQLite metadata and LanceDB vector storage;
- stdio and local Streamable HTTP transport;
- optional observability and aggregation services.

The default storage root is project-local (`<projectRoot>/.nexus`).

## 2. Data and Provider Boundary

With a local-only embedding provider such as Ollama, source-derived index data remains on the host. Configuring an external embedding provider such as `openai-compat` or `bedrock` can transmit source-derived text to that configured service.

Local HTTP v2 rejects external embedding providers through the transport constraint checks. Do not infer that all Nexus operating modes are zero-transmission when an external provider is configured.

## 3. Runtime Architecture

A Nexus runtime owns the indexing/search state for a project. The principal data flow is:

```text
File watcher
  -> event queue / reconciliation
  -> file diff and chunking
  -> embedding provider
  -> LanceDB search vectors

                       -> SQLite metadata / structured catalog
```

Search combines semantic and/or textual retrieval through the search orchestrator. Structured retrieval uses the structured catalog to identify logical declarations and the current working tree to return verified source. The responsibilities and boundaries of these retrieval layers, including source files as the only source of truth, are defined in [§6 Retrieval Architecture Boundaries and Source of Truth](#6-retrieval-architecture-boundaries-and-source-of-truth).

Runtime storage resources are shared within a runtime rather than recreated for each MCP request.

## 4. Indexing Invariants

### 4.1 Background initial indexing

Normal server startup begins a full scan in the background when no completed usable index exists. Runtime initialization does not wait for the full scan before accepting tool requests.

`index_status` is the canonical public way to observe indexing state.

A completed usable index requires:

- `indexStats.lastIndexedAt` to be non-null; and
- `pipelineProgress.lastError` to be absent.

A stale but previously successful index is not automatically rebuilt solely because it is old.

### 4.2 Event queue and recovery

File-system changes are buffered and debounced. Overflow/reconciliation paths preserve eventual consistency instead of silently dropping changes. Dead-letter/recovery state prevents retry exhaustion from stopping the indexing pipeline.

A full reindex is not considered successful while unresolved dead-letter work remains.

### 4.3 Storage

SQLite is the metadata and structured-catalog store. LanceDB stores vector-search data. Batch mutation paths use transactional/atomic activation boundaries where required so readers do not observe partially activated structured generations.

### 4.4 Full rebuild commit protocol and crash recovery

A clean full rebuild (`nexus --reindex --full`) enforces an all-or-nothing transactional boundary across SQLite metadata, LanceDB vector storage, and the Merkle tree:

- During full rebuild, legacy chunks and path deletions are staged in a legacy shadow table (`legacy_shadow_*`) and Merkle tree mutations are deferred. To avoid long, wasted embedding calls when a rebuild cannot succeed, any structured parse failure aborts early at the window boundary immediately after file read and chunking (Stage 1), before building embed batches, calling the embedding provider, or writing vector/Merkle data. When aborted early, staged shadow data is discarded, no subsequent windows are processed, and live vector tables, Merkle metadata, and active structured catalog generations remain unchanged. The pipeline throws `Structured full rebuild aborted: parsing failed for <filePaths>` (deduplicated in encounter order, comma-and-space separated) and persists the error in `indexStats.lastError`. If pipeline cancellation (`stop()`) occurs during Stage 1, cancellation retains precedence over the parse-failure error while preserving shadow cleanup.
- Multi-store commits follow a durable six-phase journal in SQLite (`structured_rebuild_backup_runs` and `structured_rebuild_backup_vectors`):
  1. `building` (`prepared`): catalog backup and pre-rebuild Merkle snapshot are persisted.
  2. `legacy-swapped`: live legacy `chunks` are backed up (`legacy_bak_*`) and the atomic replacement is promoted.
  3. `structured-swapped`: live `structured_chunks` are backed up (`struct_bak_*`) and the atomic replacement is promoted.
  4. `catalog-activated`: SQLite active generations are promoted.
  5. `merkle-activated`: deferred Merkle mutations are committed to the Merkle tree.
  6. `idle` (`finalized`): backup tables and journal records are removed.
- An interruption before `merkle-activated` triggers a coordinated rollback across all three stores upon startup reconciliation, restoring the SQLite catalog, LanceDB vector tables, and Merkle state from the recorded snapshot.
- An interruption at or after `merkle-activated` preserves the new generation and finalizes temporary artifact cleanup.
- The journal records deterministic names for vector shadow, replacement, and
  backup artifacts. A journal-referenced artifact is retained until coordinated
  reconciliation completes; standalone cleanup removes only unreferenced artifacts.
- Startup reconciliation deletes unreferenced shadow (`legacy_shadow_*`, `struct_shadow_*`), replacement (`legacy_rep_*`, `struct_rep_*`), and backup (`legacy_bak_*`, `struct_bak_*`) tables while strictly preserving live `chunks` and `structured_chunks`.

## 5. Search

### 5.1 Semantic and hybrid search

`semantic_search` performs vector similarity search.

`hybrid_search` combines semantic results and ripgrep results using Reciprocal Rank Fusion (RRF). Search chunks are ranking/retrieval units and must not be treated as complete logical declarations.

### 5.2 Exact text search

`grep_search` uses ripgrep for exact string/regex-oriented lookup.

### 5.3 Bounded file context

`get_context` retrieves an explicit file range or, when no range is supplied in eager mode, the file content according to the tool contract. Its deferred mode provides a bounded preview and a hint for subsequent range retrieval.

## 6. Retrieval Architecture Boundaries and Source of Truth

This section defines the responsibility of each retrieval layer and the source-of-truth rules that apply across them. It constrains retrieval architecture; concrete tool inputs, outputs, and status fields are defined in [docs/mcp-tools.md](docs/mcp-tools.md).

### 6.1 Source files are the only source of truth

Source files are the authoritative source of truth. In retrieval, the only source of truth is the current working tree, and every index, catalog, and derived search result is derived data. The semantic index, the structured catalog, and any other derived state are not authoritative source content and do not override the current working tree for exact or current-source retrieval.

Text search (`grep_search`) operates directly against source files and is not a persistent text search index.

### 6.2 Retrieval layers and responsibilities

- **Semantic index** — a derived cache for meaning-based discovery of candidate code locations.
- **Text search (`grep_search`)** — exact string/regex discovery performed directly against source files.
- **Structured Catalog** — a persistent symbol locator and identity catalog for logical declarations, including the metadata needed to verify freshness.
- **Current working tree** — the authoritative source content that exact and structured retrieval read from.
- **LSP** — on-demand semantic relationships derived from the current working tree, computed live rather than persisted as authoritative state.

### 6.3 Approximate discovery vs verified/current-source retrieval

- **Approximate discovery.** `semantic_search` and `hybrid_search` may identify candidates from derived index state; their results can reflect stale or incomplete index state. `grep_search` searches source files directly, so its candidates are line-oriented matches read directly from the source files rather than from derived index state; they remain approximate discovery and must be verified before being treated as authoritative declarations. Discovery results serve to locate code; they do not by themselves establish that a retrieved declaration is current.
- **Verified/current-source retrieval.** Exact and structured retrieval verify the requested identity against current source before returning it as fresh/current. When verification cannot establish current-source correctness, the response uses an explicit status (`stale`, `stale_identity`, `degraded`, `index_incomplete`, `unsupported`, `not_indexed`) rather than presenting stale or guessed source as current.

### 6.4 Search chunks and logical symbols are distinct units

Search chunks are ranking/retrieval units. Chunk boundaries must not become authoritative declaration boundaries. Logical symbols are identified by a stable `symbolId` and verified against current source.

### 6.5 Structured Catalog persistence boundaries

The Structured Catalog owns:

- stable `symbolId` identity;
- language, kind, logical name, and qualified name;
- file path and declaration range;
- declaration and file hashes;
- structured generation and retirement state;
- parser coverage and status.

The Structured Catalog does not own, and must never be treated as the source of truth for:

- references;
- definition edges;
- implementations;
- caller/callee graphs;
- inheritance and type hierarchies;
- resolved import graphs;
- inferred type information.

When these relationships are needed, they should be derived from the current working tree through LSP or other live analysis rather than read from the Structured Catalog as authoritative state.

### 6.6 LSP-backed semantic navigation role

LSP results are live semantic observations of the current working tree. They are not persisted as authoritative reference/call/type graphs, in the Structured Catalog or elsewhere. When an LSP capability is unavailable, the response reports that limitation explicitly instead of falling back to stale persisted edges.

(Concrete LSP-backed tools are future work tracked in [yohi/nexus#298](https://github.com/yohi/nexus/issues/298); this section defines the architectural role, not a tool contract.)

### 6.7 Architecture non-goals

Nexus does not pursue persistent reference, call, or type graphs. The Structured Catalog must not become a persistent semantic graph. These are retrieval architecture non-goals, each not pursued unless future evidence justifies it, and any exception requires explicit evidence:

- Turning the Structured Catalog into a persistent semantic graph.
- Persisting reference, call, or type graphs.
- Reimplementing language-server semantics inside Nexus language adapters.

### 6.8 Language adapter expectations

Language adapters are responsible for declaration discovery, stable identity, declaration range, and parser coverage/status reporting. They are not required or expected to resolve references, build call graphs, reconstruct type hierarchies, or infer types.

## 7. Structured Symbol Retrieval <a name="6-structured-symbol-retrieval"></a>

### 7.1 Logical symbols are independent of search chunks <a name="61-logical-symbols-are-independent-of-search-chunks"></a>

A logical declaration and a search chunk are separate retrieval units. Large declarations can be split into multiple search chunks for ranking while remaining one logical symbol in the structured catalog.

Exact symbol retrieval returns the complete verified logical declaration, not the search chunk that happened to identify it.

### 7.2 Supported languages and extensions <a name="62-supported-languages-and-extensions"></a>

The structured parser supports:

- TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`) via the TypeScript compiler API;
- Python (`.py`, `.pyi`) via tree-sitter;
- Go (`.go`) via tree-sitter;
- Rust (`.rs`) via tree-sitter;
- Java (`.java`) via tree-sitter;
- C# (`.cs`) via tree-sitter;
- C (`.c`) via tree-sitter;
- C++ (`.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`) via tree-sitter (`.h` is explicitly parsed as C++).

Unsupported or partially parsed files must report explicit status rather than being presented as exact structured coverage.

### 7.3 Symbol identity and AST parsing contracts <a name="63-symbol-identity-and-ast-parsing-contracts"></a>

`symbolId` is a stable logical identity generated from declaration identity inputs (`filePath`, `qualifiedName`, `kind`, `signatureDiscriminator`, `occurrence`) rather than body text or source line numbers. Moving a declaration without changing its logical identity does not by itself require a new ID; identity-changing signature/name changes can.

Core and additive language-specific `SymbolKind` values are supported (`struct`, `trait`, `impl`, `record`, `field`). The canonical `qualifiedName` uses `.` as the separator across all language catalogs (e.g. Rust `module.Trait`, `Type.method`).

AST traversal guarantees:

- **Error isolation:** A declaration is emitted only when its declaration, range, and scope nodes are free of syntax errors (`ERROR` / `MISSING`). Descendants of a broken container are skipped and never flattened into the parent scope.
- **Lexical ownership:** Parent-child links are established using lexical descriptor keys (`declarationKey` and `ownerKey`) rather than name-based reverse lookup. Rust `impl` method ownership resolves to the uniquely identified target type rather than the `impl` block.
- **Import-only preservation:** A valid parse with `status === 'ok'`, zero declarations, and non-empty imports preserves its import records in the structured catalog.

Retired identities are tracked so stale IDs fail explicitly rather than resolving to a guessed replacement.

### 7.4 Freshness and fail-closed verification <a name="64-freshness-and-fail-closed-verification"></a>

Structured retrieval compares the indexed file identity/hash with the current working-tree file before returning exact source. It also verifies the requested symbol slice against the indexed symbol hash. These checks implement the verified/current-source retrieval boundary defined in [§6 Retrieval Architecture Boundaries and Source of Truth](#6-retrieval-architecture-boundaries-and-source-of-truth).

If the current file, structured generation, parser coverage, or symbol hash does not satisfy the exactness contract, the request fails closed with an explicit structured status/error. It must not silently return stale or guessed source as exact. During indexing, a degraded parse with zero declarations is classified internally as `StructuredReadResult.kind === 'parse-failed'` regardless of import count. Incremental processing records this through `structuredParseFailed` and routes the file to the dead-letter queue; a full rebuild aborts early at the window boundary before embedding or storage writes. This internal marker is not part of the public MCP retrieval contract. The parser result contract uses `status: 'failed'` plus `failure.reasonCode` (including `parse_error` where applicable), while public retrieval tools expose only their documented `status`/`reasonCode` values.

For example, a current file hash mismatch returns `stale` with reason code `INDEX_FILE_HASH_MISMATCH`, while a retired symbol identity returns `stale_identity` with reason code `SYMBOL_RETIRED`.

### 7.5 Embedding independence <a name="65-embedding-independence"></a>

Once a structured catalog generation exists, `get_file_outline`, `get_symbol_source`, and `get_symbol_context` do not require semantic-search or embedding availability to retrieve structured data. They use the structured catalog plus the current working tree.

### 7.6 Repository scope and exclusions <a name="66-repository-scope-and-exclusions"></a>

Structured indexing follows the same project scope and exclusion policy as the main Nexus indexing pipeline. Paths excluded from indexing are not independently indexed for structured retrieval and are reported as excluded when queried.

### 7.7 Context token budget <a name="67-context-token-budget"></a>

`get_symbol_context` always preserves the complete symbol source. Its token budget is used to select related validated imports/context; budget pressure may omit related imports but does not truncate the symbol declaration itself. The response reports requested/actual budget usage and whether related context was omitted for budget.

## 8. Local HTTP v2 <a name="7-local-http-v2"></a>

`nexus serve` exposes Streamable HTTP MCP using the v2 protocol implementation.

### 8.1 Loopback-only binding <a name="71-loopback-only-binding"></a>

The server accepts loopback hosts only (`127.0.0.1`, `localhost`, or `::1`). Non-loopback binding fails closed. Hostname input is resolved/validated so a non-loopback address cannot bypass this restriction.

Origin and Host validation is enforced in the application layer as protection against DNS rebinding.

### 8.2 Stateless transport <a name="72-stateless-transport"></a>

Direct `nexus serve` requests use stateless v2 handling and do not keep legacy server-side MCP session maps. Each HTTP request can create the request-scoped MCP transport/server state needed to process that request while sharing the project runtime.

### 8.3 Health <a name="73-health"></a>

The server exposes health/readiness endpoints as implemented by the current HTTP transport. Readiness reflects whether required runtime storage is available rather than pretending an unavailable runtime is healthy.

## 9. HTTP Bridge and Managed Project Server <a name="8-http-bridge-and-managed-project-server"></a>

`nexus http-bridge` is a stdio-facing MCP bridge for clients that cannot connect directly to Streamable HTTP.

Without an explicit URL, the bridge discovers a healthy project-scoped local server from the storage descriptor or launches a managed loopback server. Managed discovery validates project identity and health before reuse.

Multiple bridge clients for the same project can share the managed runtime while keeping client-side MCP transport state isolated.

Managed servers can shut down automatically after the configured idle period when no clients remain.

## 10. Process Coordination <a name="9-process-coordination"></a>

Nexus uses project-level process locking to prevent conflicting runtime/index writers for the same project.

Ollama embedding calls use a machine-global lock to prevent multiple Nexus processes from oversubscribing the same local provider. Lock acquisition supports cancellation and bounded waiting according to configuration, and lock release is guaranteed on success and failure paths.

## 11. Package Mode <a name="10-package-mode"></a>

`packageMode` / `NEXUS_PACKAGE_MODE=1` enables distribution-specific constraints.

In package mode:

- the embedding provider is required to be `bedrock`;
- model, dimensions, and region remain deployment-configurable where supported;
- local metrics/dashboard behavior remains available;
- external aggregator registration is skipped.

The operational packaging workflow and deployment prerequisites are documented in [docs/distribution.md](docs/distribution.md).

## 12. Observability <a name="11-observability"></a>

Nexus records MCP tool calls, latency, search hit counts, context lines, embedding requests, and structured-retrieval outcomes through the metrics collector.

A metrics HTTP server exposes Prometheus and JSON metrics. The dashboard/aggregator can discover and aggregate multiple Nexus processes. See [docs/observability/README.md](docs/observability/README.md) for operational setup.

## 13. Security and Path Handling <a name="12-security-and-path-handling"></a>

Tool paths are sanitized against project boundaries and symlink traversal. Source retrieval must not traverse outside the configured project root.

Secrets and credentials are configuration inputs and must not be written into repository documentation, generated index data, or logs.

## 14. Compatibility and Source of Truth <a name="13-compatibility-and-source-of-truth"></a>

- Current public MCP schemas and response fields: [docs/mcp-tools.md](docs/mcp-tools.md)
- Structured index languages and limitations: [docs/structured-index.md](docs/structured-index.md)
- Runtime configuration: [docs/configuration.md](docs/configuration.md)
- Future target state: [ROADMAP.md](ROADMAP.md)
- Released history: [CHANGELOG.md](CHANGELOG.md)

Data-layer source of truth for retrieval — source files as the only authoritative content — is defined in [§6 Retrieval Architecture Boundaries and Source of Truth](#6-retrieval-architecture-boundaries-and-source-of-truth). This section governs document authority only.

When prose conflicts with implementation-backed protocol schemas or tests, fix the prose; do not preserve duplicate normative contracts in multiple documents.
