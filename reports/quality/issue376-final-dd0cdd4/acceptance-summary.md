# Issue #376 quality benchmark — owner handoff

## Run identity

- Measurement source identity: `dd0cdd4279f7397d743cc3da9f65cc7a9a0896e2` (`HEAD.txt`; also recorded in `measurement-source-head.txt` in the retained run bundle).
- Suite: `quality-issue320-v1`; one formal execution on 2026-11-28, 17 expected tasks across Core (12), Worktree (2), and LSP (3).
- Runner: `vitest run tests/integration/quality/suite.test.ts --coverage.enabled=false`; Vitest exit code `0` (`1 test passed`). This is a successful harness execution, not evidence that every quality gate passed.
- Suite aggregate status: `SAFETY_PASS`. Gate 1/2/3 results and unestablished evidence are reported separately below.
- Original generated JSON, Markdown, and `SHA256SUMS` are copied unchanged. The original run bundle and unredacted execution log remain in the retained run directory outside the repository. The repository copy of `execution.log` redacts local absolute paths.

## Gate results

### Gate 1 — safety and mandatory route coverage

| Profile | Expected tasks / executed arms | Status | Mandatory coverage | Outcomes |
|---|---:|---|---:|---|
| Core | 12 / 24 | `SAFETY_PASS` | 28/28 | 21 `CORRECT_CURRENT`, 2 `FALSE_REFUSAL`, 1 `INCONCLUSIVE`; 0 `FALSE_FRESH`, 0 `WRONG_SOURCE` |
| Worktree | 2 / 4 | `SAFETY_PASS` | 4/4 | 4 `CORRECT_CURRENT` |
| LSP | 3 / 6 | `SAFETY_PASS` | 12/12 | 6 `CORRECT_CURRENT` |

All mandatory probes are covered: 44/44 across the three profiles. Core has no false-fresh or wrong-source outcomes in this run, but its two policy-level false refusals and one inconclusive result remain material findings despite the profile’s reported safety status.

### Gate 2 — discovery

Recall below counts unique related candidates from the full collected set (not a rank-limited cutoff); MRR uses ranked adoption evidence. `NOT_ESTABLISHED` and `N/A` are not passes or zero-valued measured recall.

| Profile / arm | Status; evaluated queries | Recall; MRR | File discovery | Symbol discovery | Irrelevant candidates |
|---|---|---|---:|---:|---:|
| Core R | `MEASURED`; 4 | 0.3750; 0.7500 | 3/12 (0.2500) | 3/12 (0.2500) | 0.0000 |
| Core N | `MEASURED`; 11 | 0.4545; 0.3636 | 10/12 (0.8333) | 10/12 (0.8333) | 0.0000 |
| Worktree R | `NOT_ESTABLISHED`; 0 | N/A; N/A | 0/2 | 0/2 | N/A; no labeled candidates |
| Worktree N | `MEASURED`; 2 | 0.5000; 0.0000 | 2/2 (1.0000) | 2/2 (1.0000) | 0.0000 |
| LSP R | `NOT_ESTABLISHED`; 0 | N/A; N/A | 0/3 | 0/3 | N/A; no labeled candidates |
| LSP N | `NOT_ESTABLISHED`; 0 | N/A; N/A | 0/3 | 0/3 | N/A; no labeled candidates |

### Gate 3 — agent loop

| Profile | Both success / R-only / N-only / both fail | Completion R / N | Fallback R / N | Both-success paired first-correct-source cost (median; p95) |
|---|---|---:|---:|---|
| Core | 10 / 0 / 1 / 1 | 10/12 / 11/12 | 0/12 / 3/12 | Tool calls: 2/3; 3/11. Context bytes: 97/126.5; 1940/1972. Estimated tokens: 22/28; 688/725. (n=10 paired tasks) |
| Worktree | 2 / 0 / 0 / 0 | 2/2 / 2/2 | 0/2 / 0/2 | Tool calls: 2/3; 2/3. Context bytes: 94/100; 94/100. Estimated tokens: 22/23; 22/23. (n=2) |
| LSP | 3 / 0 / 0 / 0 | 3/3 / 3/3 | 0/3 / 3/3 | Tool calls: 2/3; 2/3. Context bytes: 94/94; 94/94. Estimated tokens: 22/22; 22/22. (n=3) |

Cost pairs are shown as `R median/N median; R p95/N p95` on both-success tasks only. These small synthetic samples are descriptive, not production latency estimates.

## Task outcomes by arm (R / N)

| Profile | Task | Result |
|---|---|---|
| Core | Q01 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q02 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q03 | `INCONCLUSIVE` / `CORRECT_CURRENT` |
| Core | Q04 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q05 | `FALSE_REFUSAL` / `FALSE_REFUSAL` |
| Core | Q06 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q07 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q08 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q09 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q10 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q11 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Core | Q14 | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Worktree | Q12-primary | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| Worktree | Q12-linked | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| LSP | Q13-definition | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| LSP | Q13-references | `CORRECT_CURRENT` / `CORRECT_CURRENT` |
| LSP | Q13-implementations | `CORRECT_CURRENT` / `CORRECT_CURRENT` |

## Required checkpoint findings

- **Q03:** All direct route probes are covered, including the old identity’s `CORRECT_REFUSAL` (`SYMBOL_RETIRED`) and the new identity’s current source. The policy result remains `INCONCLUSIVE` for R and `CORRECT_CURRENT` for N; route-probe coverage does not erase the R policy result.
- **Q05:** The direct retired-source route probe is covered and correctly refuses with `INDEX_FILE_MISSING`. Separately, both policy arms are `FALSE_REFUSAL` after the injected deletion during revalidation. N then encounters a `get_context` internal error; the public error text is sanitized. This accounts for the two Core false-refusal outcomes.
- **Q06:** The recreated-source direct probe and both policy arms reach `CORRECT_CURRENT`. This is the recreated-source scenario, not the in-flight generation-race probe.
- **Q07:** The direct `hybrid_search` route probe is now covered and correct; both policy arms are `CORRECT_CURRENT`.
- **Q08:** The direct generation-race probe is `COVERED`: `requestMutationApplied=true`, observed `stale`, reason `INDEX_FILE_MISSING`, oracle `CORRECT_REFUSAL`. This direct contract probe is distinct from the policy task, where both arms reach `CORRECT_CURRENT` (N uses stale-result handling and fallback). The route record does not expose a separate byte-count field.
- **Q11:** The direct declared-source probe and both policy arms are `CORRECT_CURRENT`.

## Change from previous final evidence

Compared with `reports/quality/issue320-v1-final-105d552/`:

- Core Gate 1 coverage improved from 26/28 to 28/28; the Q03 old-identity and Q07 hybrid coverage gaps are now closed.
- Core outcomes changed from 4 `FALSE_FRESH` + 4 `WRONG_SOURCE` to 0 + 0. Q06 changed from false-fresh to current-source correct; Q08 and Q11 changed from wrong-source to current-source correct. Q05 changed from false-fresh to false-refusal on both arms, so it remains a policy-level failure. Q03/R remains inconclusive.
- Core Gate 3 both-success tasks increased from 7 to 10; both-fail decreased from 4 to 1. Completion increased R 7/12→10/12 and N 8/12→11/12. Core N file discovery declined from 11/12 to 10/12; Core N symbol discovery remained 10/12. Other Core Gate 2 recall/MRR values are unchanged.
- Worktree and LSP Gate 1/2 classifications are unchanged; their current Gate 3 cost observations should not be conflated with quality acceptance.

## Evidence and provenance limitations

- The report’s `nexusCommit` is null for all profiles; the measured source identity is separately recorded as `dd0cdd4279f7397d743cc3da9f65cc7a9a0896e2` in `HEAD.txt`. The config and tool-registry digests both equal the empty-object digest `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`.
- Embedding evidence is `FUNCTIONAL_ONLY`; semantic relevance is `NOT_ESTABLISHED`. LSP evidence is `STUB_ONLY`; Q13 is contract/stub evidence, not validation against a real LSP server.
- The captured log includes Lance dataset initialization warnings and a sanitized `Internal server error (potential path leak prevented)` message. Absolute local workspace and temporary paths are removed only from the repository copy; the original run output remains unchanged in the retained run bundle.
- The evidence handoff does not modify Production code, benchmark code, Golden data, or previously fixed Evidence. The branch’s existing implementation commit is separate from the Evidence-only commit.
