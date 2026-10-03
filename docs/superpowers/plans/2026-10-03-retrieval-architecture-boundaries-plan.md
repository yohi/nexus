# Define retrieval architecture boundaries and Structured Catalog non-goals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `SPEC.md` and supporting docs/tests to define retrieval-layer responsibilities, source-of-truth principles, Structured Catalog persistence boundaries, and LSP role, satisfying yohi/nexus#296.

**Architecture:** Add a new standalone section to `SPEC.md` between Search and Structured Symbol Retrieval. Keep existing sections intact except for renumbering and light cross-references. Update the docs consistency test to assert key phrases from the new section. No code or schema changes.

**Tech Stack:** Markdown, Vitest, TypeScript (for test file only), `npm run lint`, `npx tsc --noEmit`.

**Spec:** [docs/superpowers/specs/2026-10-03-retrieval-architecture-boundaries-design.md](../specs/2026-10-03-retrieval-architecture-boundaries-design.md)

## Global Constraints

- Do not create new AI agent configuration files or directories.
- Do not commit unless explicitly requested.
- Do not modify the Structured Catalog storage schema, parser implementations, or MCP tool contracts.
- Keep all documentation consistent with `docs/mcp-tools.md` and `docs/structured-index.md`.
- All Japanese user-facing output must avoid Chinese-specific Han characters and Hangul.

## Review Focus

1. **Section renumbering side effects:** Adding a new §6 shifts former §6–§13 to §7–§14. Preserve stable Markdown anchors for unchanged section titles, update internal cross-references, and inspect/update links in `README.md`, `AGENTS.md`, and other docs that reference SPEC.md section numbers or anchors.
2. **LSP wording over-commitment:** The new section describes an architectural role for LSP (#298), but concrete LSP tools do not exist yet. Wording must avoid documenting specific tool inputs/outputs.
3. **Non-goals misread as absolute bans:** Non-goals should be phrased as "not pursued unless future evidence justifies" rather than permanent prohibitions.
4. **Docs consistency test coverage:** The test that checks guidance text in `SPEC.md` must include the new boundary phrases, or acceptance criteria cannot be mechanically verified.
5. **Acceptance criteria traceability:** Every acceptance criterion from #296 must be mappable to a specific paragraph or list in the updated `SPEC.md`.

---

### Task 1: Update `SPEC.md` with the new retrieval boundaries section

**Files:**
- Modify: `SPEC.md` (add new §6; renumber former §6–§13)
- Reference: `docs/mcp-tools.md`, `docs/structured-index.md`

**Interfaces:**
- Consumes: Current `SPEC.md` structure and content; design doc decisions.
- Produces: Updated `SPEC.md` with a new "Retrieval Architecture Boundaries and Source of Truth" section.

- [ ] **Step 1: Open `SPEC.md` and read §3, §5, former §6, and §13**

Confirm the insertion point and the exact paragraphs that will be renumbered.

- [ ] **Step 2: Insert the new §6 "Retrieval Architecture Boundaries and Source of Truth" after §5 Search**

The new section must contain exactly these subsections in order:

1. **Source files are the only source of truth**
   - State that source files are the authoritative source of truth.
   - State that semantic index, structured catalog, and any other derived state are not authoritative source content.
   - State that text search (`grep_search`) operates directly against source files and is not a persistent text search index.
2. **Retrieval layers and responsibilities**
   - Define semantic index as a derived cache for meaning-based discovery.
   - Define text search (`grep_search`) as exact string/regex discovery against source files.
   - Define Structured Catalog as a persistent symbol locator and identity catalog.
   - Define current working tree as the authoritative source content.
   - Define LSP as on-demand semantic relationships derived from the current working tree.
3. **Approximate discovery vs verified/current-source retrieval**
   - Discovery tools may identify candidates from derived index state.
   - Exact/structured retrieval verifies the requested identity against current source before returning it as fresh/current.
   - When verification cannot establish current-source correctness, the response uses an explicit status (`stale`, `stale_identity`, `degraded`, `index_incomplete`, `unsupported`, `not_indexed`) rather than presenting stale or guessed source as current.
4. **Search chunks and logical symbols are distinct units**
   - Reiterate that search chunks are ranking/retrieval units and chunk boundaries must not become authoritative declaration boundaries.
   - Logical symbols are identified by stable `symbolId` and verified against current source.
5. **Structured Catalog persistence boundaries**
   - List what the catalog owns: stable `symbolId`, language/kind/logical name/qualified name, file and declaration range, declaration/file hashes, generation and retirement state, parser coverage/status.
   - List what the catalog does not own and must not become the source of truth for: references, definition edges, implementations, caller/callee graph, inheritance/type hierarchy, resolved import graph, inferred type information.
   - State that these relationships should be derived from the current working tree through LSP or other live analysis when needed.
6. **LSP-backed semantic navigation role**
   - State that LSP results are live semantic observations of the current working tree.
   - State that they are not persisted as authoritative reference/call/type graphs.
   - State that when an LSP capability is unavailable, the response reports the limitation explicitly instead of falling back to stale persisted edges.
   - Add a parenthetical note that concrete LSP-backed tools are future work tracked in #298.
7. **Architecture non-goals**
   - Reject turning the Structured Catalog into a persistent semantic graph.
   - Reject persistent reference/call/type graphs unless future evidence justifies them.
   - Reject reimplementing language-server semantics inside Nexus language adapters.
8. **Language adapter expectations**
   - Language adapters are responsible for declaration discovery, stable identity, declaration range, and parser coverage/status reporting.
   - They are not required or expected to resolve references, build call graphs, reconstruct type hierarchies, or infer types.

- [ ] **Step 3: Renumber former §6 "Structured Symbol Retrieval" through §13 to §7–§14**

Update every section number and any internal references to those section numbers. Where section titles stay the same, keep the old Markdown anchors (e.g., `#structured-symbol-retrieval`) intact so existing deep links continue to resolve to the correct topic.

- [ ] **Step 4: Update cross-references and external links**

- In §3 Runtime Architecture, add a forward reference to the new §6 when mentioning retrieval layers.
- In former §6.4 (now §7.4) Freshness and fail-closed verification, add a backward reference to the new §6.
- In §13 (now §14) Compatibility and Source of Truth, add a note that data-layer source of truth is covered in §6.
- Inspect `README.md`, `AGENTS.md`, `docs/mcp-tools.md`, `docs/structured-index.md`, and `docs/configuration.md` for links or section-number references to the renumbered SPEC.md sections, and update them to match the new numbering or stable anchors.

- [ ] **Step 5: Verify no contradictory statements remain**

Read the updated `SPEC.md` once and confirm it does not contradict `docs/mcp-tools.md` or `docs/structured-index.md`.

- [ ] **Step 6: Run markdown lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 7: Commit the SPEC update only if explicitly requested**

If the user explicitly asked to commit, run:

```bash
git add SPEC.md
git commit -m "docs: define retrieval architecture boundaries and Structured Catalog non-goals"
```

If no explicit request was made, leave the changes uncommitted.

---

### Task 2: Update docs consistency test to assert the new boundary guidance

**Files:**
- Modify: `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: Updated `SPEC.md` text from Task 1.
- Produces: Test assertions that prove the new boundary concepts are documented.

- [ ] **Step 1: Read `tests/unit/docs/structured-retrieval-guidance.test.ts`**

Understand the existing assertion pattern (e.g., checking for `stale_identity`, `INDEX_FILE_HASH_MISMATCH`, etc.).

- [ ] **Step 2: Add assertions scoped to the new §6 boundary phrases**

Read the updated `SPEC.md`, locate the new §6 "Retrieval Architecture Boundaries and Source of Truth", and add case-insensitive substring checks that verify the *content* of that section, not just the presence of words elsewhere in the document. For each phrase, assert it appears inside §6 or in the specific list/subsection that implements the boundary concept:

- Subsection 6.1: `source files are the only source of truth`, `derived data`, and `not authoritative source content`.
- Subsection 6.2: `semantic index` as a derived cache, `grep_search` as direct source-file search, `Structured Catalog` as persistent symbol locator, `current working tree` as authoritative source content, and `LSP` as on-demand semantic relationships.
- Subsection 6.3: `approximate discovery`, `verified/current-source retrieval`, and an explicit list or sentence showing that unverified source is returned with a status (`stale`, `stale_identity`, `degraded`, `index_incomplete`, `unsupported`, `not_indexed`) rather than as fresh/current.
- Subsection 6.4: `search chunks` and `logical symbols` as distinct units, plus the requirement that chunk boundaries must not become authoritative declaration boundaries.
- Subsection 6.5: a list or structure showing what the catalog owns (`stable symbolId`, language/kind, declaration range, hashes, generation/retirement state, parser coverage/status) and what it does not own (`references`, `caller/callee`, `type hierarchy`, `resolved import graph`, `inferred type information`).
- Subsection 6.6: `LSP results are live semantic observations` and a statement that they are not persisted as authoritative reference/call/type graphs, plus the #298 future-work note.
- Subsection 6.7: `non-goals` phrased as `not pursued unless future evidence justifies` rather than absolute bans.
- Subsection 6.8: `language adapters` limited to declaration discovery, stable identity, declaration range, and parser coverage/status, and explicitly not required to resolve references, build call graphs, reconstruct type hierarchies, or infer types.

Keep the existing assertions unless they are superseded.

- [ ] **Step 3: Run the updated test**

Run: `npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts`
Expected: passes.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit the test update only if explicitly requested**

If the user explicitly asked to commit, run:

```bash
git add tests/unit/docs/structured-retrieval-guidance.test.ts
git commit -m "test: assert retrieval architecture boundary guidance in SPEC.md"
```

If no explicit request was made, leave the changes uncommitted.

---

### Task 3: Final verification

**Files:**
- Reference: `SPEC.md`, `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: Output of Task 1 and Task 2.
- Produces: Verified acceptance-criteria coverage report.

- [ ] **Step 1: Run the structured retrieval guidance test**

Run: `npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts`
Expected: passes.

- [ ] **Step 2: Run the structured retrieval unit and integration tests**

Run: `npx vitest run tests/unit/structured/retrieval-service.test.ts tests/unit/server/tools/structured-retrieval.test.ts tests/integration/structured-retrieval.test.ts`
Expected: passes.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: passes.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Produce acceptance-criteria coverage report**

For each #296 acceptance criterion, cite the SPEC.md section/paragraph where it is satisfied:

| #296 Criterion | `SPEC.md` location |
|---|---|
| Defines responsibility of semantic, textual, structured, source, and LSP retrieval layers | New §6.2 |
| Source files are authoritative source of truth; indexes are derived data | New §6.1 |
| Distinguishes approximate discovery from verified/current-source retrieval | New §6.3 |
| Exact/structured failure semantics document unverified source must not be represented as fresh/current | New §6.3 + §7.4 |
| Search chunks and logical symbols documented as distinct concepts | New §6.4 + §5.1 |
| Structured Catalog persistence/non-persistence boundaries documented | New §6.5 |
| Architecture non-goals reject persistent reference/call/type graphs unless future evidence justifies | New §6.7 |
| Language adapter expectations limited to declaration discovery/identity/range/coverage | New §6.8 |
| Existing MCP tool contracts and tests remain consistent | Cross-reference checks + unchanged tool definitions |
| #320 can derive correctness scenarios from documented contracts | New §6.3, §6.4, §6.5, §7.4 |

- [ ] **Step 6: Commit final verification log only if explicitly requested**

If the user explicitly asked to save the report as a committed file, add and commit it. Otherwise, present the coverage table in the task completion message without committing.

---

## Self-Review

1. **Spec coverage:** Every design subsection maps to a task or sub-step. The new §6 content is fully covered by Task 1; the mechanical verification by Task 2 and Task 3.
2. **Step scan:** Each step asks the implementer to write one concrete thing: insert a named subsection, add an assertion, run a command, produce a table.
3. **Type consistency:** No new code signatures are introduced; the plan touches only Markdown and an existing test file.
4. **Review Focus:** Each focus item has a corresponding guard step (renumbering in Task 1 Step 3, LSP wording in Task 1 Step 2 non-goal note, non-goals phrasing in Task 1 Step 2 subsection 7, docs test in Task 2, traceability in Task 3 Step 5).
5. **Proportion:** The plan is short because the work is documentation-only and the design doc already decided the content.
