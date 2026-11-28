# Issue 320 final quality benchmark — owner handoff

- Measurement source HEAD: `105d55297cc6f3d64618e860aea2d121ae1838a9`
- Suite: `quality-issue320-v1`; one execution; Vitest exit code 0.
- Expected tasks: 17; executed tasks: 17 (Core 12, Worktree 2, LSP 3).
- Gate 1 profile results: Core `SAFETY_FAIL` (26/28 mandatory probes; outcomes: 15 CORRECT_CURRENT, 4 FALSE_FRESH, 4 WRONG_SOURCE, 1 INCONCLUSIVE); Worktree `SAFETY_PASS` (4/4); LSP `SAFETY_PASS` (12/12).
- Gate 2: Core R `Recall@10` 0.3750, MRR 0.7500; N 0.4545, MRR 0.3636. File/symbol discovery R 0.2500/0.2500; N 0.9167/0.8333; irrelevant candidate rate R 0.0000, N 0.1000. Worktree R `NOT_ESTABLISHED`; N Recall@10 0.5000, MRR 0, discovery 1.0000/1.0000, irrelevant rate 0. LSP `NOT_ESTABLISHED` for both arms (no eligible queries). Synthetic embedding evidence is `FUNCTIONAL_ONLY`; semantic relevance remains `NOT_ESTABLISHED`.
- Gate 3: Core both-success 7, baseline-only 0, Nexus-only 1, both-fail 4; completion R 7/12 (58.3%), N 8/12 (66.7%). Worktree 2 both-success; LSP 3 both-success. LSP evidence is `STUB_ONLY` / contract-only.
- Core route coverage 26/28. Missing: `Q03-old-identity-refusal` (probe verdict INCONCLUSIVE though status stale) and `Q07-hybrid` (probe missing).
- Q03: direct old-identity refusal was INCONCLUSIVE; new identity CORRECT_CURRENT on Nexus, R was INCONCLUSIVE overall. Q05 retired-identity refusal and Q06 recreated-current-source probes were CORRECT, but ordinary policy outcomes were FALSE_FRESH on both arms (4 total). Q06 tests post-recreation retrieval, not an in-flight race. Q08 direct generation-race probe was CORRECT_REFUSAL, but policy outcome was WRONG_SOURCE on both arms; policy evaluation and direct contract probe are distinct. Q11 declared source probe was CORRECT_CURRENT, while policy outcome was WRONG_SOURCE on both arms.
- No benchmark or product source was changed during this run. Provenance limitation: benchmark metadata `nexusCommit` is null; config and registry digests are the empty-object digest; oracle and manifest digests match. Source identity is recorded separately in `HEAD.txt`. Runtime details and log are sanitized for public storage.
