# Retrieval Architecture Boundaries and Structured Catalog Non-Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update canonical documentation and the documentation tests that guard them so that `SPEC.md`, `docs/mcp-tools.md`, `docs/structured-index.md`, and `skills/code-search/SKILL.md` clearly define Nexus retrieval-layer responsibilities, the source-of-truth boundary, and the Structured Catalog non-goals described in GitHub issue [#296](https://github.com/yohi/nexus/issues/296).

**Architecture:** Add a new top-level "Retrieval Architecture" section to `SPEC.md` that assigns responsibilities to semantic, textual, structured, source, and LSP layers and states the source-of-truth and fail-closed contracts. Cross-reference it from `docs/mcp-tools.md` and `docs/structured-index.md`; update the agent-facing skill to keep the retrieval workflow consistent. Extend existing documentation tests to assert the new invariants.

**Tech Stack:** Markdown documentation; existing Vitest documentation tests in `tests/unit/docs/`.

**Spec:** GitHub issue [#296](https://github.com/yohi/nexus/issues/296).

## Global Constraints

- Source files are the only authoritative source of truth; all indexes are derived data.
- Derived indexes may identify candidates, but they must not be presented as authoritative source content.
- Exact/structured retrieval is fail-closed: unverified source is returned with an explicit `stale`/`degraded`/`unsupported`/`not_indexed`/`stale_identity` status, never as fresh/current.
- Search chunks and logical symbols are separate retrieval units with different correctness contracts.
- The Structured Catalog persists only declaration identity, range, language/kind, hashes, generation state, and parser coverage/status; it does not persist references, definition/implementation/caller/callee/inheritance/type graphs, or resolved import graphs.
- LSP results are live semantic observations derived from the current working tree and are not persisted as authoritative graphs.
- Language adapters are limited to declaration discovery, identity, range, and coverage concerns; they do not reimplement language-server semantic analysis.
- All changes must keep existing MCP tool contracts and tests consistent.
- New documentation must follow project markdown style; do not duplicate complete tool schemas or runbooks.
- Documentation tests in `tests/unit/docs/structured-retrieval-guidance.test.ts` and `tests/unit/docs/structured-index-docs.test.ts` must be updated to assert the new content.

## Review Focus

- A reader asks, "Which layer owns reference/call/type relationships?" The plan adds an explicit non-goals list in `SPEC.md` and `docs/structured-index.md` naming these as out of scope.
- A reader asks, "Why did `get_symbol_source` return `stale`?" `SPEC.md` and `docs/mcp-tools.md` must state that the tool re-verifies the current file and symbol hash before returning fresh source.
- A reader conflates a search chunk with a full declaration. `SPEC.md`, `docs/mcp-tools.md`, and `skills/code-search/SKILL.md` must repeat that chunks are ranking units, not authoritative declarations.
- A future issue proposes persisting caller/callee data in the Structured Catalog. `SPEC.md` must contain an explicit non-goal rejecting persistent reference/call/type graphs unless future evidence justifies them.
- A language adapter author implements import resolution. `SPEC.md` and `docs/structured-index.md` must limit adapters to declaration discovery / identity / range / coverage, deferring semantic relationships to LSP/live analysis.

Each Review Focus item has a matching test assertion added to Task 5.

---

### Task 1: Add Retrieval Architecture section to `SPEC.md`

**Files:**
- Modify: `SPEC.md` (insert after section 3 "Runtime Architecture" or as new section 4, renumbering later sections)
- Test: `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: existing sections 1–3 of `SPEC.md`.
- Produces: a new section that later files cross-reference by anchor text.

- [ ] **Step 1: Add "Retrieval Architecture" section to `SPEC.md`**

Add a new section after "Runtime Architecture" (or renumber as needed) containing exactly the following subsections and statements:

```markdown
## 4. Retrieval Architecture

Nexus separates five retrieval concerns. Each layer has a distinct correctness contract.

### 4.1 Retrieval layers

| Layer | Responsibility | Source of truth |
| --- | --- | --- |
| Semantic index | Derived vector similarity for meaning-based discovery | Derived from source; not authoritative source content |
| Text search | Exact string/regex discovery against current source files | Source files |
| Structured Catalog | Persistent symbol locator and identity catalog: stable `symbolId`, language/kind, logical and qualified name, file and declaration range, declaration/file hashes, generation and retirement state, parser coverage/status | Derived from source; authoritative only for identity and location metadata |
| Current working tree | Authoritative source content | Source files |
| LSP / live analysis | On-demand semantic relationships derived from the current working tree | Source files at request time |

### 4.2 Source of truth

Source files in the current working tree are the only authoritative source of truth. All indexes, catalogs, and derived artifacts are secondary data. A derived index may identify a candidate declaration or range, but it must not be treated as the authoritative content of that declaration.

### 4.3 Discovery vs. verified retrieval

Semantic and hybrid search, as well as text search, provide **approximate discovery**. They find candidates. Exact symbol retrieval (`get_symbol_source`, `get_symbol_context`) and file outline (`get_file_outline`) provide **verified/current-source retrieval**: they re-read the current working tree and verify the indexed file hash and symbol hash before returning source as `fresh`.

When current-source correctness cannot be established, the response must fail closed with an explicit status such as `stale`, `stale_identity`, `degraded`, `unsupported`, `not_indexed`, `index_incomplete`, or `not_found`. Guessed or stale source must never be returned as fresh/current.

### 4.4 Search chunks vs. logical symbols

Search chunks are ranking and retrieval units. They may cross declaration boundaries or split a single declaration across multiple chunks. A logical symbol is a complete declaration with a stable `symbolId`. A search result can identify a declaration through `symbolId`, but structured retrieval returns the complete verified logical declaration from the current working tree. Chunk boundaries are not declaration boundaries and must not become authoritative declaration boundaries.

### 4.5 Structured Catalog persistence boundaries

The Structured Catalog persists:

- stable `symbolId` values;
- language / kind / logical name / qualified name;
- file path and declaration byte/line range;
- declaration and file hashes;
- generation and retirement state;
- parser coverage and status.

The Structured Catalog does **not** persist, and is **not** the source of truth for:

- references;
- definition edges;
- implementation relationships;
- caller/callee graphs;
- inheritance or type hierarchy;
- resolved import graphs;
- inferred type information.

These should be derived from the current working tree through LSP or other live analysis when needed.

### 4.6 Language adapter expectations

Language adapters parse supported source files to discover declarations, produce stable identities, record declaration ranges, and report parser coverage/status. They are not expected to reimplement language-server semantic analysis, module resolution, type inference, or call-graph construction.

### 4.7 Retrieval correctness

Correctness claims for retrieval must be measurable through automated benchmarks (see roadmap issue #320) rather than inferred only from architecture. The architecture establishes the contracts; benchmarks exercise them against concrete source states.
```

Renumber the following sections of `SPEC.md` so headers remain sequential. Update internal cross-references only if a header number appears in the prose (minimal change; prefer anchor links).

- [ ] **Step 2: Verify no duplicate or contradictory statements remain**

Read `SPEC.md` sections 5–13 after editing. Confirm:
- Section 6 "Structured Symbol Retrieval" still states fail-closed verification and source-as-truth.
- No other section claims indexes are authoritative source content.
- No prose says Structured Catalog owns references, call graphs, or type hierarchy.

Run: `grep -nE "authoritative|source of truth|reference graph|call graph|type hierarchy" SPEC.md` and confirm the new section is the only authoritative definition and the non-goal list appears exactly once.

- [ ] **Step 3: Commit**

```bash
git add SPEC.md
git commit -m "docs: add retrieval architecture boundaries and structured catalog non-goals to SPEC"
```

---

### Task 2: Update `docs/mcp-tools.md` to reference the new architecture

**Files:**
- Modify: `docs/mcp-tools.md`
- Test: `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: the new "Retrieval Architecture" section in `SPEC.md`.
- Produces: tool descriptions that explicitly distinguish discovery from verified retrieval.

- [ ] **Step 1: Rewrite the "Retrieval Flow" intro and tool descriptions**

After the existing tool table and before "Search Tools", replace the "Retrieval Flow" and related prose with:

```markdown
## Retrieval Flow

Nexus tools are divided into **discovery** tools and **verified/current-source retrieval** tools. Discovery tools find candidates; verified tools return source only after reading the current working tree and checking hashes.

- `semantic_search` / `hybrid_search` / `grep_search` are discovery tools. They identify candidate files, lines, or `symbolId` values; their results are not authoritative source content.
- `get_file_outline`, `get_symbol_source`, and `get_symbol_context` are verified tools. They re-read the project file and compare the current file hash and symbol hash against the Structured Catalog before returning source as `fresh`.
- `get_context` reads the current working tree directly and is useful for line-oriented hits, unsupported paths, or cases where structured retrieval reports degraded coverage.

Call `index_status` before relying on search results.

```text
semantic_search / hybrid_search / grep_search
  -> candidate file, line, or symbolId
  -> get_file_outline / get_symbol_source / get_symbol_context (verify against current source)

known supported source file
  -> get_file_outline
  -> symbolId
  -> get_symbol_source / get_symbol_context

line-oriented / non-symbol / degraded hit
  -> get_context
```

Search chunks and logical symbols are different retrieval units with different correctness contracts. A chunk is a ranking unit; a logical symbol is a complete declaration with a stable `symbolId`. Prefer exact structured retrieval when a usable `symbolId` exists, but do not treat the chunk that identified it as the declaration boundary. See [SPEC.md](../SPEC.md) for the full retrieval-layer contract.
```

Keep the existing per-tool input/output details under "Search Tools" and "Context and Structured Retrieval" unchanged unless they contradict the new contract; if so, align the phrasing.

- [ ] **Step 2: Add a "Retrieval correctness" sentence under "Direct Verification"**

After the existing paragraph, add:

```markdown
The verifier exercises the documented discovery/retrieval boundary: search tools return candidates, and structured tools return source only when the current working tree verifies against the catalog.
```

- [ ] **Step 3: Commit**

```bash
git add docs/mcp-tools.md
git commit -m "docs: clarify discovery vs verified retrieval in MCP tool reference"
```

---

### Task 3: Update `docs/structured-index.md` with Structured Catalog boundaries and language adapter scope

**Files:**
- Modify: `docs/structured-index.md`
- Test: `tests/unit/docs/structured-index-docs.test.ts`

**Interfaces:**
- Consumes: new `SPEC.md` section 4.
- Produces: a "What the structured index is not" subsection and language-adapter scope statement.

- [ ] **Step 1: Add a "Structured Catalog persistence boundaries" section**

After the existing "Structured index vs vector index" section and before "Parsing failures and outline semantics", insert:

```markdown
## Structured Catalog persistence boundaries

The Structured Catalog is a persistent symbol locator and identity catalog. It owns:

- stable `symbolId` values;
- language / kind / logical name / qualified name;
- file path and declaration range;
- declaration and file hashes;
- generation and retirement state;
- parser coverage and status.

It does **not** own, and should not be used as the source of truth for:

- references;
- definition edges;
- implementation relationships;
- caller/callee graphs;
- inheritance or type hierarchy;
- resolved import graphs;
- inferred type information.

Derive those from the current working tree through LSP or other live analysis when needed. Persisting them in the Structured Catalog is an explicit non-goal unless future evidence justifies it.

## Language adapter expectations

Language adapters discover declarations, assign stable identities, record declaration ranges, and report parser coverage. They do not reimplement language-server features such as module resolution, type inference, or call-graph construction.
```

- [ ] **Step 2: Verify the new section does not duplicate full tool schemas**

Confirm the file still does not contain complete MCP input/output schemas (those belong in `docs/mcp-tools.md`) and that the new prose is concise.

- [ ] **Step 3: Commit**

```bash
git add docs/structured-index.md
git commit -m "docs: document structured catalog non-goals and language adapter scope"
```

---

### Task 4: Update `skills/code-search/SKILL.md` to align with the clarified architecture

**Files:**
- Modify: `skills/code-search/SKILL.md`
- Test: `tests/unit/docs/structured-retrieval-guidance.test.ts`

**Interfaces:**
- Consumes: new `SPEC.md` section 4 and updated `docs/mcp-tools.md`.
- Produces: agent workflow guidance that explicitly classifies each tool as discovery or verified retrieval.

- [ ] **Step 1: Rewrite "Standard pipeline" step 1 and add a layer contract paragraph**

After the first paragraph of the "Standard pipeline" section, insert:

```markdown
Nexus tools are separated into **discovery** tools (`semantic_search`, `hybrid_search`, `grep_search`) and **verified/current-source retrieval** tools (`get_file_outline`, `get_symbol_source`, `get_symbol_context`, `get_context`). Discovery tools find candidates; verified tools read the current working tree and verify indexed hashes before returning source as `fresh`.
```

Then change step 1 from:

```markdown
### 1. Classify the task
```

to keep its existing bullets.

No other changes required unless existing bullets contradict the architecture; if so, align them.

- [ ] **Step 2: Strengthen the "Prefer exact structured retrieval when possible" section**

After the existing paragraph, append:

```markdown
Do not treat the search chunk that carries a `symbolId` as the authoritative declaration boundary. A chunk is a ranking unit; the logical symbol is the complete declaration. Always retrieve the verified declaration through `get_symbol_source` or `get_symbol_context` when a usable `symbolId` exists.
```

- [ ] **Step 3: Commit**

```bash
git add skills/code-search/SKILL.md
git commit -m "docs: align code-search skill with retrieval architecture boundaries"
```

---

### Task 5: Extend documentation tests to assert the new invariants

**Files:**
- Modify: `tests/unit/docs/structured-retrieval-guidance.test.ts`
- Modify: `tests/unit/docs/structured-index-docs.test.ts`
- Test: run `npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts tests/unit/docs/structured-index-docs.test.ts`

**Interfaces:**
- Consumes: new prose in `SPEC.md`, `docs/mcp-tools.md`, `docs/structured-index.md`, and `skills/code-search/SKILL.md`.
- Produces: passing tests that guard the new architecture statements.

- [ ] **Step 1: Add a new test to `structured-retrieval-guidance.test.ts`**

Append a new test inside the existing `describe` block:

```typescript
  it("defines retrieval-layer responsibilities and source-of-truth in SPEC.md", () => {
    expect(spec).toContain("## 4. Retrieval Architecture");
    expect(spec).toContain("Source files in the current working tree are the only authoritative source of truth");
    expect(spec).toContain("approximate discovery");
    expect(spec).toContain("verified/current-source retrieval");
    expect(spec).toContain("Search chunks are ranking and retrieval units");
    expect(spec).toContain("logical symbol is a complete declaration");
    expect(spec).toContain("Structured Catalog persists");
    expect(spec).toContain("Structured Catalog does **not** persist");
    expect(spec).toContain("references");
    expect(spec).toContain("caller/callee graphs");
    expect(spec).toContain("inheritance or type hierarchy");
    expect(spec).toContain("Language adapters parse supported source files");
    expect(spec).toContain("not expected to reimplement language-server semantic analysis");
  });

  it("distinguishes discovery and verified retrieval in MCP tool reference", () => {
    expect(mcpTools).toContain("discovery tools");
    expect(mcpTools).toContain("verified/current-source retrieval");
    expect(mcpTools).toContain("Search chunks and logical symbols are different retrieval units");
    expect(mcpTools).toContain("different correctness contracts");
  });

  it("keeps the code-search skill aligned with the retrieval architecture", () => {
    expect(skill).toContain("discovery tools");
    expect(skill).toContain("verified/current-source retrieval");
    expect(skill).toContain("chunk is a ranking unit");
    expect(skill).toContain("logical symbol is the complete declaration");
  });
```

- [ ] **Step 2: Add a new test to `structured-index-docs.test.ts`**

Append a new test inside the existing `describe` block:

```typescript
  it("documents structured catalog non-goals and adapter scope", async () => {
    const [structuredIndex, specContent] = await Promise.all([
      readFile("docs/structured-index.md", "utf8"),
      readFile("SPEC.md", "utf8"),
    ]);

    expect(structuredIndex).toContain("Structured Catalog is a persistent symbol locator and identity catalog");
    expect(structuredIndex).toContain("does **not** own");
    expect(structuredIndex).toContain("caller/callee graphs");
    expect(structuredIndex).toContain("resolved import graphs");
    expect(structuredIndex).toContain("inferred type information");
    expect(structuredIndex).toContain("Language adapter expectations");
    expect(structuredIndex).toContain("do not reimplement language-server features");
    expect(specContent).toContain("## 4. Retrieval Architecture");
  });
```

- [ ] **Step 3: Run the focused documentation tests**

Run:

```bash
npx vitest run tests/unit/docs/structured-retrieval-guidance.test.ts tests/unit/docs/structured-index-docs.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/docs/structured-retrieval-guidance.test.ts tests/unit/docs/structured-index-docs.test.ts
git commit -m "test: assert retrieval architecture boundaries in documentation"
```

---

### Task 6: Run the full documentation and type/lint verification

**Files:**
- All files touched above.

**Interfaces:**
- Consumes: completed edits and tests.
- Produces: green verification results.

- [ ] **Step 1: Run documentation tests**

```bash
npx vitest run tests/unit/docs/
```

Expected: PASS.

- [ ] **Step 2: Run type check and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: no errors (no code changes were made).

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: build succeeds. No public exports changed.

- [ ] **Step 4: Final commit if any verification fixes were needed**

Only if step 1–3 required file changes, commit them with a `test:` or `docs:` message as appropriate. If no changes, mark this step complete.

---

## Self-Review

1. **Spec coverage:**
   - Semantic/text/structured/source/LSP layer responsibilities → Task 1, section 4.1.
   - Source files as authoritative truth → Task 1, section 4.2.
   - Discovery vs verified retrieval → Task 1, section 4.3; Task 2; Task 4.
   - Unverified source must not be fresh/current → Task 1, section 4.3; existing `SPEC.md` 6.4.
   - Search chunks vs logical symbols → Task 1, section 4.4; Task 2; Task 4.
   - Structured Catalog persistence boundaries → Task 1, section 4.5; Task 3.
   - Architecture non-goals rejecting persistent graphs → Task 1, section 4.5; Task 3.
   - Language adapter scope → Task 1, section 4.6; Task 3.
   - Existing MCP contracts/tests remain consistent → Tasks 2 and 4 do not change tool schemas; Task 5 asserts consistency.
   - Benchmark issue #320 can derive scenarios → Task 1, section 4.7.

2. **Step scan:** Every step names one file change or one test run with a verifiable command. No TBDs or vague instructions.

3. **Type consistency:** Not applicable; this plan changes Markdown and documentation tests only.

4. **Review Focus:** Each focus item is covered by a test assertion in Task 5 or by explicit prose in Task 1/2/3/4.

5. **Proportion:** Plan is concise relative to the issue body; code blocks contain only exact prose the spec requires.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-30-retrieval-architecture-boundaries.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; recommended because documentation cross-references and test assertions must stay consistent across four files.
- **Native** - I implement every task myself in this session, then one fresh reviewer checks the whole branch. Cheapest and fastest; suitable because the changes are documentation-only and the plan pins exact prose and assertions.

Does the plan capture what you want, and which approach should we use?
