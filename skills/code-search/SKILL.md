---
name: code-search
description: Use Nexus code search tools when investigating, tracing, or retrieving verified context from a codebase.
---

# Code Search Skill

## When to load

Load this skill before code investigation, implementation tracing, architectural exploration, or requests such as:

- "Where is this implemented?"
- "Who calls this symbol?"
- "Find the relevant code."
- "How does this feature work?"
- "Trace the dependency/call path."

Do not return a search-only answer when the task requires understanding code. Retrieve enough verified source to support the conclusion.

## Standard pipeline

**classify task → check index → search/outline → exact retrieval or bounded context → act**

This is an agent procedure, not an MCP protocol requirement. Nexus tools can be called independently.

### 1. Classify the task

- Vague, conceptual, or architectural request: identify concepts and likely areas.
- Exact symbol, error, string, or code fragment: preserve the exact search term.
- Structural/call-tree request: check whether `.codegraph/` is available.

### 2. Check the relevant index

- Before Nexus search tools, call `index_status`.
- `pipelineProgress.status === 'running'` means background indexing is active; searches remain available but may be incomplete.
- After calling `reindex`, call `index_status` again regardless of whether it returns a completed result, `already_running`, `incomplete`, or raises an exception.
- Treat indexing as successfully completed only when `pipelineProgress.status === 'idle'`, `indexStats.lastIndexedAt` is non-null, `pipelineProgress.lastError` is absent, and `indexStats.lastError` is absent.
- Do not treat `already_running`, `incomplete`, exceptions, or `pipelineProgress.status === 'running'` as completion. Wait and re-check `index_status` before relying on complete-index search results.
- CodeGraph exploration does not depend on the Nexus index.

### 3. Search or outline

- Use `hybrid_search` for semantic, vague, feature, or architecture questions.
- Use `grep_search` for exact symbols, error strings, constants, and exact code fragments.
- Use `semantic_search` when vector-only ranking is specifically useful.
- Use `codegraph_explore` for structural/call-tree tracing only when `.codegraph/` exists.
- Use `get_file_outline` for a known supported TypeScript/JavaScript, Python, or Go source file when you need a symbol map before selecting a declaration.

### 4. Prefer exact structured retrieval when possible

Search chunks and logical symbols are different retrieval units. A search result can identify a declaration through `symbolId`, while exact retrieval returns the complete verified logical declaration.

When a `semantic_search` or `hybrid_search` result contains a usable `chunk.symbolId`:

- use `get_symbol_source` when you need the exact declaration;
- use `get_symbol_context` when you need the exact declaration plus validated related imports within a token budget.

Do **not** replace this path with generic line retrieval merely because a search result also contains `startLine` / `endLine`.

Use `get_context` instead when:

- the hit is line-oriented or comes from `grep_search`;
- the declaration is not represented by a usable `symbolId`;
- the language/path is unsupported by structured retrieval;
- structured retrieval reports degraded/incomplete coverage and the task can be answered safely from bounded lines;
- you need a specific non-symbol line range.

For `get_context`, request the smallest useful range with explicit `startLine` and `endLine`. Avoid whole-file reads when a bounded range is sufficient.

### 5. Act

Explain the implementation, answer the question, or make the requested change from retrieved evidence. Preserve file paths and relevant line/symbol references so the result remains traceable.

## Common retrieval patterns

### Conceptual feature search

1. `index_status`
2. `hybrid_search`
3. If top result has a usable `symbolId`: `get_symbol_source` or `get_symbol_context`
4. Otherwise: `get_context` for the most relevant bounded ranges
5. Return a grounded summary

### Exact symbol trace

1. `index_status`
2. `grep_search` to locate exact references, or `get_file_outline` if the file is already known
3. Use a returned `symbolId` with `get_symbol_source` / `get_symbol_context` for declarations
4. Use `get_context` for individual call sites or other line-oriented hits
5. Distinguish the declaration from callers

### Structural dependency request

If `.codegraph/` exists:

1. `codegraph_explore`
2. Use Nexus exact/bounded retrieval only for source evidence needed to support the graph

If `.codegraph/` does not exist:

1. `index_status`
2. `hybrid_search`
3. Prefer structured exact retrieval for symbol-bearing results
4. Use bounded `get_context` for remaining references

## Deferred loading

Return a concise finding with file/symbol references first. Expand to additional source only when the initial evidence is insufficient or the requested edit requires more surrounding code.

`get_context` supports `mode: "deferred"` for preview-first reads. Prefer this over repeatedly reading large files in chunks.

## Freshness and failure handling

- After branch switches or large file changes, call `reindex` before relying on semantic results.
- Structured retrieval is fail-closed. Treat `stale`, `not_found`, `unsupported`, `degraded`, `index_incomplete`, or equivalent status/error codes as evidence that exact retrieval is unavailable for that request.
- A retired symbol identity returns `stale_identity`; a file-hash mismatch returns `stale` with `INDEX_FILE_HASH_MISMATCH`. Do not silently map either case to a similar symbol or return guessed source.
- Never guess source from a stale or retired `symbolId`.
- Fall back to bounded current-working-tree context only when that fallback is appropriate for the task.
