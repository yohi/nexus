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

Search combines semantic and/or textual retrieval through the search orchestrator. Structured retrieval uses the structured catalog to identify logical declarations and the current working tree to return verified source.

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

- During full rebuild, legacy chunks and path deletions are staged in a legacy shadow table (`legacy_shadow_*`) and Merkle tree mutations are deferred. Any structured parse failure immediately aborts the rebuild, discarding staged shadow data and leaving live vector tables, Merkle metadata, and active structured catalog generations unchanged.
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

## 6. Structured Symbol Retrieval

### 6.1 Logical symbols are independent of search chunks

A logical declaration and a search chunk are separate retrieval units. Large declarations can be split into multiple search chunks for ranking while remaining one logical symbol in the structured catalog.

Exact symbol retrieval returns the complete verified logical declaration, not the search chunk that happened to identify it.

### 6.2 Supported languages and extensions

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

### 6.3 Symbol identity and AST parsing contracts

`symbolId` is a stable logical identity generated from declaration identity inputs (`filePath`, `qualifiedName`, `kind`, `signatureDiscriminator`, `occurrence`) rather than body text or source line numbers. Moving a declaration without changing its logical identity does not by itself require a new ID; identity-changing signature/name changes can.

Core and additive language-specific `SymbolKind` values are supported (`struct`, `trait`, `impl`, `record`, `field`). The canonical `qualifiedName` uses `.` as the separator across all language catalogs (e.g. Rust `module.Trait`, `Type.method`).

AST traversal guarantees:

- **Error isolation:** A declaration is emitted only when its declaration, range, and scope nodes are free of syntax errors (`ERROR` / `MISSING`). Descendants of a broken container are skipped and never flattened into the parent scope.
- **Lexical ownership:** Parent-child links are established using lexical descriptor keys (`declarationKey` and `ownerKey`) rather than name-based reverse lookup. Rust `impl` method ownership resolves to the uniquely identified target type rather than the `impl` block.
- **Import-only preservation:** A valid parse with `status === 'ok'`, zero declarations, and non-empty imports preserves its import records in the structured catalog.

Retired identities are tracked so stale IDs fail explicitly rather than resolving to a guessed replacement.

### 6.4 Freshness and fail-closed verification

Structured retrieval compares the indexed file identity/hash with the current working-tree file before returning exact source. It also verifies the requested symbol slice against the indexed symbol hash.

If the current file, structured generation, parser coverage, or symbol hash does not satisfy the exactness contract, the request fails closed with an explicit structured status/error. It must not silently return stale or guessed source as exact. During indexing, a degraded parse with zero declarations is classified internally as `StructuredReadResult.kind === 'parse-failed'` regardless of import count. Incremental processing records this through `structuredParseFailed` and routes the file to the dead-letter queue; a full rebuild aborts. This internal marker is not part of the public MCP retrieval contract. The parser result contract uses `status: 'failed'` plus `failure.reasonCode` (including `parse_error` where applicable), while public retrieval tools expose only their documented `status`/`reasonCode` values.

For example, a current file hash mismatch returns `stale` with reason code `INDEX_FILE_HASH_MISMATCH`, while a retired symbol identity returns `stale_identity` with reason code `SYMBOL_RETIRED`.

### 6.5 Embedding independence

Once a structured catalog generation exists, `get_file_outline`, `get_symbol_source`, and `get_symbol_context` do not require semantic-search or embedding availability to retrieve structured data. They use the structured catalog plus the current working tree.

### 6.6 Repository scope and exclusions

Structured indexing follows the same project scope and exclusion policy as the main Nexus indexing pipeline. Paths excluded from indexing are not independently indexed for structured retrieval and are reported as excluded when queried.

### 6.7 Context token budget

`get_symbol_context` always preserves the complete symbol source. Its token budget is used to select related validated imports/context; budget pressure may omit related imports but does not truncate the symbol declaration itself. The response reports requested/actual budget usage and whether related context was omitted for budget.

## 7. Local HTTP v2

`nexus serve` exposes Streamable HTTP MCP using the v2 protocol implementation.

### 7.1 Loopback-only binding

The server accepts loopback hosts only (`127.0.0.1`, `localhost`, or `::1`). Non-loopback binding fails closed. Hostname input is resolved/validated so a non-loopback address cannot bypass this restriction.

Origin and Host validation is enforced in the application layer as protection against DNS rebinding.

### 7.2 Stateless transport

Direct `nexus serve` requests use stateless v2 handling and do not keep legacy server-side MCP session maps. Each HTTP request can create the request-scoped MCP transport/server state needed to process that request while sharing the project runtime.

### 7.3 Health

The server exposes health/readiness endpoints as implemented by the current HTTP transport. Readiness reflects whether required runtime storage is available rather than pretending an unavailable runtime is healthy.

## 8. HTTP Bridge and Managed Project Server

`nexus http-bridge` is a stdio-facing MCP bridge for clients that cannot connect directly to Streamable HTTP.

Without an explicit URL, the bridge discovers a healthy project-scoped local server from the storage descriptor or launches a managed loopback server. Managed discovery validates project identity and health before reuse.

Multiple bridge clients for the same project can share the managed runtime while keeping client-side MCP transport state isolated.

Managed servers can shut down automatically after the configured idle period when no clients remain.

## 9. Process Coordination

Nexus uses project-level process locking to prevent conflicting runtime/index writers for the same project.

Ollama embedding calls use a machine-global lock to prevent multiple Nexus processes from oversubscribing the same local provider. Lock acquisition supports cancellation and bounded waiting according to configuration, and lock release is guaranteed on success and failure paths.

## 10. Package Mode

`packageMode` / `NEXUS_PACKAGE_MODE=1` enables distribution-specific constraints.

In package mode:

- the embedding provider is required to be `bedrock`;
- model, dimensions, and region remain deployment-configurable where supported;
- local metrics/dashboard behavior remains available;
- external aggregator registration is skipped.

The operational packaging workflow and deployment prerequisites are documented in [docs/distribution.md](docs/distribution.md).

## 11. Observability

Nexus records MCP tool calls, latency, search hit counts, context lines, embedding requests, and structured-retrieval outcomes through the metrics collector.

A metrics HTTP server exposes Prometheus and JSON metrics. The dashboard/aggregator can discover and aggregate multiple Nexus processes. See [docs/observability/README.md](docs/observability/README.md) for operational setup.

## 12. Security and Path Handling

Tool paths are sanitized against project boundaries and symlink traversal. Source retrieval must not traverse outside the configured project root.

Secrets and credentials are configuration inputs and must not be written into repository documentation, generated index data, or logs.

## 13. Compatibility and Source of Truth

- Current public MCP schemas and response fields: [docs/mcp-tools.md](docs/mcp-tools.md)
- Structured index languages and limitations: [docs/structured-index.md](docs/structured-index.md)
- Runtime configuration: [docs/configuration.md](docs/configuration.md)
- Future target state: [ROADMAP.md](ROADMAP.md)
- Released history: [CHANGELOG.md](CHANGELOG.md)

When prose conflicts with implementation-backed protocol schemas or tests, fix the prose; do not preserve duplicate normative contracts in multiple documents.
