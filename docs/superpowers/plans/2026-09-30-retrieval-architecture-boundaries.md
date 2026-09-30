# Retrieval Architecture Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update SPEC.md with retrieval architecture boundaries, Structured Catalog non-goals, and language adapter expectations.

**Architecture:** Add a new "Retrieval Architecture Boundaries" section to SPEC.md defining five retrieval layers (semantic, text, structured, source, LSP) with distinct responsibility contracts. Explicitly document what the Structured Catalog owns and does not own. Add cross-references from existing sections.

**Tech Stack:** Markdown documentation

**Spec:** docs/superpowers/specs/2026-09-30-retrieval-architecture-boundaries-design.md

## Global Constraints

- This is a documentation-only change; no code or test modifications
- Existing MCP tool contracts and test suites must remain consistent
- SPEC.md is the canonical source for current architecture invariants
- docs/mcp-tools.md remains the canonical reference for MCP tool contracts
- docs/structured-index.md remains the canonical reference for structured index limitations

## Review Focus

- New section does not contradict existing Section 5 (Search) or Section 6 (Structured Symbol Retrieval) definitions
- Non-goals list does not conflict with current Structured Catalog implementation (which stores declarations and imports)
- Cross-references are accurate and point to correct sections
- Language adapter expectations align with current parser implementations (tree-sitter, TypeScript compiler API)

---

### Task 1: Add Retrieval Architecture Boundaries section to SPEC.md

**Files:**
- Modify: `SPEC.md` (insert new section before Section 5)

**Interfaces:**
- Consumes: Design doc sections 1-3
- Produces: New SPEC.md section "Retrieval Architecture Boundaries" with five-layer responsibility table and correctness principles

- [ ] **Step 1: Insert new section before Section 5 (Search)**

Insert the following content before `## 5. Search` in SPEC.md:

```markdown
## Retrieval Architecture Boundaries

Nexus separates five retrieval layers with distinct responsibility contracts. Source files are the only authoritative source of truth; all indexes are derived data.

### Layer responsibilities

| Layer | Responsibility | Authority |
|-------|---------------|-----------|
| Semantic index | Meaning-based discovery via vector similarity | Derived cache, approximate |
| Text search | Exact string/regex discovery against source files | Discovery only |
| Structured Catalog | Persistent symbol locator and identity catalog | Declaration metadata only |
| Current working tree | Authoritative source content | Authoritative |
| LSP | On-demand semantic relationships from current working tree | Live observation |

### Retrieval correctness principles

- Derived indexes may identify candidates, but they are not authoritative source content.
- Exact/structured retrieval must verify the requested identity against current source before returning it as fresh/current.
- When current-source correctness cannot be established, an explicit stale/degraded/unsupported/not-indexed result is preferable to guessed or stale source presented as current.
- Search chunks and logical symbols serve different purposes; chunk boundaries must not become the authoritative declaration boundary.
- LSP results are live semantic observations and must not be persisted as authoritative reference/call/type graphs.

### Structured Catalog ownership boundaries

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

### Language adapter expectations

Language adapters are limited to declaration discovery, identity, range, and coverage concerns. They must not reimplement language servers or persist semantic relationship graphs.
```

- [ ] **Step 2: Verify section renders correctly**

Run: `npx markdownlint SPEC.md`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add SPEC.md
git commit -m "docs: add retrieval architecture boundaries section to SPEC.md"
```

---

### Task 2: Add cross-references from existing SPEC.md sections

**Files:**
- Modify: `SPEC.md` (Sections 5, 6, 13)

**Interfaces:**
- Consumes: New "Retrieval Architecture Boundaries" section from Task 1
- Produces: Cross-references from existing sections to new section

- [ ] **Step 1: Add reference to Section 5 (Search)**

In Section 5.1, after the first sentence, add:

```markdown
See [Retrieval Architecture Boundaries](#retrieval-architecture-boundaries) for the responsibility contract of each retrieval layer.
```

- [ ] **Step 2: Add reference to Section 6 (Structured Symbol Retrieval)**

In Section 6.1, after the first sentence, add:

```markdown
See [Retrieval Architecture Boundaries](#retrieval-architecture-boundaries) for Structured Catalog ownership boundaries and non-goals.
```

- [ ] **Step 3: Add reference to Section 13 (Compatibility and Source of Truth)**

In Section 13, add a bullet point:

```markdown
- Retrieval architecture boundaries and layer responsibilities: [Retrieval Architecture Boundaries](#retrieval-architecture-boundaries)
```

- [ ] **Step 4: Verify cross-references are accurate**

Run: `npx markdownlint SPEC.md`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add SPEC.md
git commit -m "docs: add cross-references to retrieval architecture boundaries"
```

---

### Task 3: Add non-goals reference to docs/structured-index.md

**Files:**
- Modify: `docs/structured-index.md`

**Interfaces:**
- Consumes: New "Retrieval Architecture Boundaries" section from Task 1
- Produces: Cross-reference in structured-index.md to SPEC.md non-goals

- [ ] **Step 1: Add non-goals section to docs/structured-index.md**

After the "Known limitations" section, add:

```markdown
## Structured Catalog non-goals

The Structured Catalog does not store references, definition edges, implementations, caller/callee graphs, inheritance/type hierarchy, resolved import graph, or inferred type information. These are derived from the current working tree through LSP or other live analysis when needed.

See [SPEC.md](../SPEC.md#retrieval-architecture-boundaries) for the complete ownership boundary definition.
```

- [ ] **Step 2: Verify section renders correctly**

Run: `npx markdownlint docs/structured-index.md`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add docs/structured-index.md
git commit -m "docs: add non-goals reference to structured-index.md"
```

---

### Task 4: Verify existing tests remain consistent

**Files:**
- No modifications

**Interfaces:**
- Consumes: All previous tasks
- Produces: Confirmation that existing tests pass with updated documentation

- [ ] **Step 1: Run existing test suite**

Run: `npx vitest run`
Expected: All tests pass (documentation changes do not affect test outcomes)

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No type errors (documentation changes do not affect type checking)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 4: If all checks pass, no commit needed (verification only)**

If any check fails, investigate whether the failure is related to the documentation changes or pre-existing. Report findings.
