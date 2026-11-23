# Retrieval Quality Benchmarks

This document describes the `quality-issue320-v1` benchmark suite used to assess Nexus retrieval correctness against a reproducible baseline.

## Scope

The benchmark compares two arms for every task:

- **R**: ripgrep-based baseline (`rg_search`, `read_file`, `get_context`).
- **N**: Nexus native tools (`grep_search`, `semantic_search`, `hybrid_search`, `get_symbol_source`, `get_symbol_context`, `get_definition`, `get_references`, `get_implementations`).

Tasks cover clean/dirty source trees, symbol moves/deletes/renames, file recreation, divergent Git worktrees, and LSP navigation contracts.

## Required tasks

The suite enumerates exactly 17 tasks:

| Task | Scenario |
|------|----------|
| Q01 | Clean indexed repository |
| Q02 | Dirty / uncommitted edits |
| Q03 | Symbol rename |
| Q04 | Symbol move |
| Q05 | Symbol deletion |
| Q06 | File deletion / recreation |
| Q07 | Stale semantic/vector data |
| Q08 | Generation changes during retrieval |
| Q09 | Partial / unsupported parsing |
| Q10 | Same names in multiple scopes |
| Q11 | Large file / multi-declaration |
| Q14 | LSP unavailable / unsupported |
| Q12-primary | Divergent Git worktrees — primary root |
| Q12-linked | Divergent Git worktrees — linked root |
| Q13-definition | LSP definition |
| Q13-references | LSP references |
| Q13-implementations | LSP implementations |

## Three gates

1. **Safety** — no wrong-source adoption, required coverage present, current-source correctness, refusal correctness.
2. **Discovery** — per-arm Recall@10, MRR, file/symbol discovery rates, irrelevant candidate rate.
3. **Agent loop** — paired completion/failure, first-correct-source cost distributions, fallback frequency.

## Outputs

For each profile (`quality-core-v1`, `quality-worktree-v1`, `quality-lsp-v1`) the suite writes:

- `\u003csuiteId\u003e.json`: machine-readable report with redacted public projections.
- `\u003csuiteId\u003e.md`: human-readable summary.
- `SHA256SUMS`: byte-identity digests of the two artifacts.

## Running

```bash
OUT=$(mktemp -d "${TMPDIR:-/tmp}/nexus-quality-320.XXXXXXXX")
chmod 700 "$OUT"
NEXUS_QUALITY_SUITE=quality-issue320-v1 NEXUS_QUALITY_OUTPUT_ROOT="$OUT" \
  npx vitest run tests/integration/quality/suite.test.ts --coverage.enabled=false
```

## Redaction and safety

The JSON report contains no source text, no absolute host paths, and no credentials. The `metadata.rgExecutableIdentity` is a digest of public executable identity, not a physical path.
