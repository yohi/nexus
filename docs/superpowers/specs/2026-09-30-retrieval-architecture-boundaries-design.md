# Design: Retrieval Architecture Boundaries and Structured Catalog Non-Goals

**Date:** 2026-09-30
**Issue:** [#296](https://github.com/yohi/nexus/issues/296)
**Status:** Approved (sections 1-3)

## Goal

Define and document a stable responsibility boundary for each retrieval layer in Nexus, with source code as the only source of truth. Prevent the Structured Catalog from becoming a persistent semantic graph that duplicates responsibilities already provided by language servers.

## Background

Nexus already separates semantic/vector retrieval, ripgrep text search, structured symbol retrieval, and current-working-tree source verification. As structured indexing expands to more languages, there is a risk of turning the Structured Catalog into a persistent semantic graph and duplicating responsibilities already provided by language servers.

The intended architecture separates **approximate discovery** from **verified/current-source retrieval**. Search indexes are useful for finding candidates, but derived index state must not silently become more authoritative than the current working tree.

## Design

### Section 1: Retrieval Layer Responsibilities

Nexus separates five retrieval layers with distinct responsibility contracts. Source files are the only authoritative source of truth; all indexes are derived data.

#### Layer responsibilities

| Layer | Responsibility | Authority |
|-------|---------------|-----------|
| Semantic index | Meaning-based discovery via vector similarity | Derived cache, approximate |
| Text search | Exact string/regex discovery against source files | Discovery only |
| Structured Catalog | Persistent symbol locator and identity catalog | Declaration metadata only |
| Current working tree | Authoritative source content | Authoritative |
| LSP | On-demand semantic relationships from current working tree | Live observation |

#### Retrieval correctness principles

- Derived indexes may identify candidates, but they are not authoritative source content.
- Exact/structured retrieval must verify the requested identity against current source before returning it as fresh/current.
- When current-source correctness cannot be established, an explicit stale/degraded/unsupported/not-indexed result is preferable to guessed or stale source presented as current.
- Search chunks and logical symbols serve different purposes; chunk boundaries must not become the authoritative declaration boundary.
- LSP results are live semantic observations and must not be persisted as authoritative reference/call/type graphs.

### Section 2: Structured Catalog Ownership Boundaries

The Structured Catalog owns:

- stable `symbolId`
- language / kind / logical name / qualified name
- file and declaration range
- declaration/file hashes
- generation and retirement state
- parser coverage/status

The Structured Catalog does **not** own:

- references
- definition edges
- implementations
- caller/callee graph
- inheritance/type hierarchy
- resolved import graph
- inferred type information

These are derived from the current working tree through LSP or other live analysis when needed.

#### Language adapter expectations

Language adapters are limited to declaration discovery, identity, range, and coverage concerns. They must not reimplement language servers or persist semantic relationship graphs.

### Section 3: Compatibility and Testability

#### Existing section integration

| Target | Action |
|--------|--------|
| SPEC.md Section 5 (Search) | Add reference to new "Retrieval Architecture Boundaries" section |
| SPEC.md Section 6 (Structured Symbol Retrieval) | Add reference to non-goals definition |
| SPEC.md Section 13 (Compatibility) | Add reference to new section |
| docs/mcp-tools.md | No change (existing contracts maintained) |
| docs/structured-index.md | Add reference to non-goals definition |
| Tests | No change (contracts maintained) |

#### Testability (Issue #320 consideration)

The documented contracts enable deriving correctness scenarios:

- **Approximate discovery correctness**: semantic/hybrid search results must not be represented as fresh/current
- **Structured retrieval correctness**: hash mismatch must return stale, not guessed source
- **LSP non-persistence**: LSP results must not be persisted as authoritative reference graphs
- **Chunk ≠ symbol**: search chunks must not be treated as logical declaration boundaries

## Acceptance Criteria Mapping

| # | Criterion | Covered by |
|---|-----------|------------|
| 1 | SPEC.md defines responsibility of semantic, textual, structured, source, and LSP retrieval layers | Section 1 |
| 2 | SPEC.md explicitly states source files are authoritative source of truth and indexes are derived data | Section 1 |
| 3 | SPEC.md distinguishes approximate discovery from verified/current-source retrieval | Section 1 |
| 4 | Exact/structured retrieval failure semantics document that unverified source must not be represented as fresh/current | Section 1 |
| 5 | Search chunks and logical symbols documented as distinct concepts with different correctness contracts | Section 1 |
| 6 | Structured Catalog persistence/non-persistence boundaries documented | Section 2 |
| 7 | Architecture non-goals explicitly reject persistent reference/call/type graphs | Section 2 |
| 8 | Language adapter expectations limited to declaration discovery/identity/range/coverage | Section 2 |
| 9 | Existing MCP tool contracts and tests remain consistent | Section 3 |
| 10 | #320 can derive correctness scenarios from documented contracts | Section 3 |

## Non-Goals

- Implementing LSP-backed semantic navigation tools (tracked in #298)
- Establishing retrieval correctness benchmarks (tracked in #320)
- Changing existing MCP tool contracts or test suites
- Adding new retrieval layers or engines
