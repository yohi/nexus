# Design: Define retrieval architecture boundaries and Structured Catalog non-goals

## Goal

Update `SPEC.md` so it defines a stable responsibility boundary for every Nexus retrieval layer, with source files as the only source of truth. The change must satisfy the acceptance criteria in [yohi/nexus#296](https://github.com/yohi/nexus/issues/296) while keeping existing MCP tool contracts and tests consistent.

## Current state

`SPEC.md` already describes the major retrieval mechanisms and the freshness/fail-closed contract:

- §1 Product Boundary lists semantic vector search, ripgrep text search, AST-aware chunking/structured symbol catalog, and exact symbol retrieval from the current working tree.
- §3 Runtime Architecture states that search combines semantic and/or textual retrieval and that structured retrieval uses the catalog to identify declarations and the current working tree to return verified source.
- §5 Search defines `semantic_search`, `hybrid_search`, and `grep_search`, and notes that search chunks are ranking/retrieval units, not complete logical declarations.
- §6 Structured Symbol Retrieval defines logical symbols, symbol identity, supported languages, freshness verification, embedding independence, and fail-closed semantics.
- §13 Compatibility and Source of Truth addresses document authority (SPEC vs. implementation), not the data-layer source-of-truth principle.

What is missing:

- An explicit statement that source files are the authoritative source of truth and that every index is derived data.
- A single place that lists the responsibility of each layer (semantic, text, structured catalog, current working tree, LSP).
- A clear distinction between approximate discovery and verified/current-source retrieval.
- Documentation of Structured Catalog persistence boundaries: what it owns and what it must not become the source of truth for.
- The role of LSP as an on-demand, current-working-tree semantic relationship layer that is not persisted as an authoritative graph.
- Architecture non-goals that reject persistent reference/call/type graphs unless future evidence justifies them.
- A limit on language-adapter responsibilities to declaration discovery, identity, range, and coverage rather than language-server reimplementation.

## Design

### Approach: minimal, focused insertion

Add a new standalone section to `SPEC.md` rather than scattering the content across existing sections. This makes the boundary contract easy to find and review, and avoids renumbering or restructuring the rest of the document.

- Insert **"§6 Retrieval Architecture Boundaries and Source of Truth"** immediately after §5 Search.
- Renumber the existing §6 "Structured Symbol Retrieval" through §13 accordingly.
- Keep the existing §5 and former-§6 content intact, adding only forward/backward references where they improve clarity.

### New section content

The new section will contain the following subsections, scaled to the complexity of each topic:

1. **Source files are the only source of truth**
   - State that every index and catalog is derived data.
   - No derived state silently overrides the current working tree for exact/current-source retrieval.

2. **Retrieval layers and responsibilities**
   - Semantic index: derived cache for meaning-based discovery.
   - Text search (`grep_search`): exact string/regex discovery against source files.
   - Structured Catalog: persistent symbol locator and identity catalog.
   - Current working tree: authoritative source content.
   - LSP: on-demand semantic relationships derived from the current working tree.

3. **Approximate discovery vs verified/current-source retrieval**
   - Discovery tools may return candidates based on derived index state.
   - Exact/structured retrieval verifies the requested identity against the current working tree before returning it as fresh/current.
   - When verification fails, the response uses an explicit status such as `stale`, `stale_identity`, `degraded`, `index_incomplete`, `unsupported`, or `not_indexed` rather than presenting stale/guessed source as current.

4. **Search chunks and logical symbols are distinct units**
   - Reiterate that chunks are ranking/retrieval units and chunk boundaries must not become authoritative declaration boundaries.
   - Logical symbols are identified by stable `symbolId` and verified against current source.

5. **Structured Catalog persistence boundaries**
   - Owns: stable `symbolId`, language/kind/logical name/qualified name, file and declaration range, declaration/file hashes, generation and retirement state, parser coverage/status.
   - Does not own and must not become the source of truth for: references, definition edges, implementations, caller/callee graph, inheritance/type hierarchy, resolved import graph, inferred type information.
   - Such relationships should be derived from the current working tree through LSP or other live analysis when needed.

6. **LSP-backed semantic navigation role**
   - LSP results are live semantic observations of the current working tree.
   - They are not persisted as authoritative reference/call/type graphs in the Structured Catalog or elsewhere.
   - When an LSP capability is unavailable, the response reports the limitation explicitly instead of falling back to stale persisted edges.
   - (Note: LSP-backed MCP tools are planned under #298; this section defines the architectural role, not a concrete tool contract.)

7. **Architecture non-goals**
   - Reject persistent reference/call/type graphs unless future evidence justifies them.
   - Reject turning the Structured Catalog into a persistent semantic graph.
   - Reject reimplementing language-server semantics inside language adapters.

8. **Language adapter expectations**
   - Language adapters are responsible for declaration discovery, stable identity, declaration range, and parser coverage/status reporting.
   - They are not required or expected to resolve references, build call graphs, reconstruct type hierarchies, or infer types.

### References and consistency

- Forward-reference the new §6 from §3 Runtime Architecture and §5 Search where the existing one-line summaries already mention retrieval layers.
- Keep §6.4 Freshness and fail-closed verification (formerly §6.4) as the detailed freshness contract; add a backward reference to the new §6.
- Update §13 Compatibility and Source of Truth title/scope to remain about document authority; add a note clarifying that data-layer source of truth is covered in §6.
- Ensure `docs/mcp-tools.md` and `docs/structured-index.md` remain consistent; do not contradict their existing status/reasonCode contracts.

### Tests

- Verify that `tests/unit/docs/structured-retrieval-guidance.test.ts` still passes and ideally checks for key phrases in the new section.
- If the test asserts the presence of guidance text in `SPEC.md`, extend the assertion list to include the new boundary concepts (e.g., `source of truth`, `derived index`, `LSP`, `not authoritative`, `non-goal`).
- Run `npx tsc --noEmit` and `npm run lint` after editing.

### Out of scope

- No new MCP tools.
- No changes to the Structured Catalog storage schema or parser implementations.
- No implementation of LSP-backed tools (#298).
- No new benchmarks (#320); only document the contracts that benchmarks can derive scenarios from.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Adding a new section renumbers later sections, which may break external deep links. | This is unavoidable for a document change; the content gain outweighs the link cost. Consider keeping section titles stable so anchors still resolve to the right topic. |
| The LSP role is described architecturally but the concrete tools are not implemented, which may be read as a commitment. | Use careful wording such as "when provided" and reference #298; avoid documenting specific tool inputs/outputs. |
| Non-goals could be read as forbidding future work. | Phrase them as "not pursued unless future evidence justifies" rather than absolute bans. |

## Acceptance criteria

All acceptance criteria from yohi/nexus#296 are satisfied by the `SPEC.md` update and any supporting test/doc updates:

- [ ] `SPEC.md` defines the responsibility of semantic, textual, structured, source, and LSP retrieval layers.
- [ ] `SPEC.md` explicitly states that source files are the authoritative source of truth and indexes are derived data.
- [ ] `SPEC.md` distinguishes approximate discovery from verified/current-source retrieval.
- [ ] Exact/structured retrieval failure semantics document that unverified source must not be represented as fresh/current.
- [ ] Search chunks and logical symbols are documented as distinct concepts with different correctness contracts.
- [ ] Structured Catalog persistence/non-persistence boundaries are documented.
- [ ] Architecture non-goals explicitly reject persistent reference/call/type graphs unless future evidence justifies them.
- [ ] Language adapter expectations are limited to declaration discovery / identity / range / coverage concerns rather than language-server reimplementation.
- [ ] Existing MCP tool contracts and tests remain consistent with the clarified architecture.
- [ ] #320 can derive correctness scenarios from the documented contracts without inventing a separate definition of "correct".

## Related work

- [yohi/nexus#296](https://github.com/yohi/nexus/issues/296) — this issue.
- [yohi/nexus#298](https://github.com/yohi/nexus/issues/298) — LSP-backed semantic navigation (future concrete tools).
- [yohi/nexus#320](https://github.com/yohi/nexus/issues/320) — retrieval correctness and agent-loop quality benchmarks.
