# MCP Tool Reference

Nexus exposes nine MCP tools through `createNexusServer()`. This is the canonical public reference for tool roles and structured-retrieval behavior. Current architecture invariants are in [SPEC.md](../SPEC.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `semantic_search` | Vector search over indexed code chunks |
| `grep_search` | Exact text and regex search through ripgrep |
| `hybrid_search` | Reciprocal Rank Fusion of semantic and grep results |
| `get_context` | Bounded or deferred file-range retrieval |
| `get_file_outline` | Symbol outline for a known supported source file |
| `get_symbol_source` | Exact verified source for a structured `symbolId` |
| `get_symbol_context` | Exact symbol source plus verified related imports within a token budget |
| `index_status` | Index, structured-index, pipeline, vector, and plugin health |
| `reindex` | Manual incremental reindex or clean full rebuild |

## Retrieval Flow

Call `index_status` before relying on search results.

```text
semantic_search / hybrid_search
  -> usable symbolId
  -> get_symbol_source or get_symbol_context

known supported source file
  -> get_file_outline
  -> symbolId
  -> get_symbol_source or get_symbol_context

line-oriented / non-symbol hit
  -> get_context
```

Search chunks and logical symbols are different retrieval units. Prefer exact structured retrieval when a usable `symbolId` exists.

## Search Tools

`semantic_search` accepts `query` and optional `topK`, `filePattern`, `filePatterns`, and `language`. Results contain ranked chunks; a chunk backed by a structured declaration can carry `chunk.symbolId`.

`grep_search` accepts `pattern` and optional `filePattern`, `filePatterns`, `caseSensitive`, and `maxResults`. Matches are line-oriented and include file/line/submatch information.

`hybrid_search` accepts `query` and optional `topK`, `filePattern`, `filePatterns`, `language`, `grepPattern`, `includeSnippet`, and `contextLines`. `contextLines` is clamped to 20. Snippet-read failures omit that snippet rather than failing the entire search response.

## Context and Structured Retrieval

`get_context` requires project-relative `filePath` and supports optional `startLine`, `endLine`, and `mode` (`eager` or `deferred`). Paths are sanitized and ranges are clamped to file bounds. Deferred mode returns a bounded preview plus follow-up range metadata.

`get_file_outline` requires `filePath`. On `ok`, symbols can include `name`, `qualifiedName`, `symbolId`, `kind`, `signatureDiscriminator`, `position`, `isExact`, `languageId`, and `parentSymbolId`.

### `kind`

Symbols report a `kind` describing the declaration shape. Core kinds include `function`, `class`, `interface`, `method`, `property`, `variable`, `enum`, `type`, `namespace`, `module`, and `import`.

Additional language-specific kinds include `struct`, `trait`, `impl`, `record`, and `field`.

`get_symbol_source` requires `symbolId`. On `ok`, it returns the complete verified declaration plus freshness/reindex state. Non-`ok` outcomes do not return guessed source.

`get_symbol_context` requires `symbolId` and `tokenBudget` (`1..100000`). The complete symbol declaration is preserved even if it exceeds the budget; related imports are reduced instead. Budget metadata reports requested/actual usage, whether it was exceeded, and omissions.

Structured retrieval is fail-closed. Public statuses include `ok`, `not_found`, `stale_identity`, `not_indexed`, `excluded`, `unsupported`, `degraded`, `stale`, and `index_incomplete`. Representative codes include `FILE_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `SYMBOL_RETIRED`, `STRUCTURED_INDEX_MISSING`, `PATH_EXCLUDED`, `STRUCTURED_SCHEMA_UNSUPPORTED`, `unsupported_language`, `PARSER_COVERAGE_PARTIAL`, `PARSER_BOUNDARY_UNCERTAIN`, `INDEX_FILE_HASH_MISMATCH`, `INDEX_FILE_MISSING`, `INDEX_PENDING_GENERATION`, `INDEX_SYMBOL_HASH_MISMATCH`, `INDEX_IMPORT_HASH_MISMATCH`, and `INDEX_GENERATION_MISSING`.

A stale or retired identity must not be silently mapped to a similar symbol.

## Index State

`index_status` accepts an empty object. Initial full indexing can run in the background while tools are available. Treat initial indexing as successfully completed only when `indexStats.lastIndexedAt` is non-null and `pipelineProgress.lastError` is absent. A `running` pipeline means search is available but may be incomplete. `structuredIndex` reports schema/generation state and rebuild requirements.

`reindex` accepts optional `fullRebuild` and `reason` (`manual`, `overflow-recovery`, or `startup-reconciliation`). If indexing is already running, it reports that state instead of starting a second pipeline. A full rebuild is not successfully complete while unresolved dead-letter work remains.

## HTTP Bridge

`nexus http-bridge` adapts stdio-only MCP clients to a Nexus Streamable HTTP endpoint. Without an explicit URL it discovers or starts the project-scoped loopback server. Transport and managed-server safety invariants are defined in [SPEC.md](../SPEC.md).
