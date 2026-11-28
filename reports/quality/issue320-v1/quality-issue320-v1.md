# Retrieval Quality Benchmark Report — quality-core-v1

- Profile: `quality-core-v1`
- Policy version: `quality-policy-v1`
- Fixture digest: `f9d1d5218c82b03f3f14485e35f8ebb5e80a4af068ac1aa8608cc32955749af2`
- Nexus commit: `unknown`
- rg version: `ripgrep 15.2.0`
- Run: 2026-11-27T17:52:03.746Z → 2026-11-27T17:52:19.027Z

## Expected tasks

- Q01
- Q02
- Q03
- Q04
- Q05
- Q06
- Q07
- Q08
- Q09
- Q10
- Q11
- Q14

## Gate 1 — Safety

- Status: **SAFETY_FAIL**
- Expected: 12, executed: 24
- Coverage: 24/28
- Missing coverage: Q03-old-identity-refusal, Q05-retired-refusal, Q06-recreated-source, Q08-generation-race

### Outcome counts

- CORRECT_CURRENT: 15
- CORRECT_REFUSAL: 0
- FALSE_REFUSAL: 1
- FALSE_FRESH: 5
- WRONG_SOURCE: 2
- MISSING: 0
- UNAVAILABLE: 0
- INCONCLUSIVE: 1

### Rates

- Current-source correctness: 0.6250 (15/24)
- Symbol identity resolution: 0.6250 (15/24)
- Safe refusal: 0.0000 (0/24)
- False refusal: 0.0417 (1/24)
- False fresh: 0.2083 (5/24)
- Wrong source: 0.0833 (2/24)
- Missing: 0.0000 (0/24)
- Unavailable: 0.0000 (0/24)

### Mandatory route coverage

| Task | Probe | Tool | Sequence | Setup proof | Args digest | Request snapshot | Publication snapshot | Observed | Reason | Oracle | Coverage |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| Q01 | Q01-index_status | index_status | 17 | f9f74e3afdf1e570d860f32566162fed4056db899df2158b2c56e74474035ab7 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q01 | Q01-source | get_symbol_source | 18 | f9f74e3afdf1e570d860f32566162fed4056db899df2158b2c56e74474035ab7 | 8265b0746d5e42d8e35947092d3f7e83347fb8de5176fcfa4e7632d28fbf35ad | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | ok | — | CORRECT_CURRENT | COVERED |
| Q02 | Q02-index_status | index_status | 17 | 576c322b30620d8d32a184547f85ea4b632b9b774a153aede221980edb7d322d | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q02 | Q02-dirty-source | get_symbol_source | 18 | 576c322b30620d8d32a184547f85ea4b632b9b774a153aede221980edb7d322d | 6e48656ff37e923f1119a78c59fc09d215e4c285507cdcdaa7cf38f094de492e | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | ok | — | CORRECT_CURRENT | COVERED |
| Q03 | Q03-index_status | index_status | 3 | 9437f5428478ca4e48038bb1b340dc61f1efa54ed3fee57803e2b614c663a2dc | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | — | ok | — | CORRECT_CURRENT | COVERED |
| Q03 | Q03-old-identity-refusal | get_symbol_source | 4 | 9437f5428478ca4e48038bb1b340dc61f1efa54ed3fee57803e2b614c663a2dc | 4dd64daf6f2be3d8682924157a10c9139a5d52d9f245d97ce53de689cf703b91 | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | — | stale | INDEX_FILE_MISSING | INCONCLUSIVE | INCOMPLETE |
| Q03 | Q03-new-identity-source | get_symbol_source | 5 | 9437f5428478ca4e48038bb1b340dc61f1efa54ed3fee57803e2b614c663a2dc | 0fd57ca366fa4b9fa46f7ff9e28b4dfa64d9918d3a1a6c1382635d0ca040b750 | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | ok | — | CORRECT_CURRENT | COVERED |
| Q04 | Q04-index_status | index_status | 17 | 47064105cb33515da37f2ffc9ef845a321d62e029fd521ab8c6b1a3d5ba9d428 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q04 | Q04-moved-source | get_symbol_source | 18 | 47064105cb33515da37f2ffc9ef845a321d62e029fd521ab8c6b1a3d5ba9d428 | 73525b1c2fb6d1a6a164ef17c4211f98a463e74da4898d754a9a80c0f10840ba | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | ok | — | CORRECT_CURRENT | COVERED |
| Q05 | Q05-index_status | index_status | 2 | 233c2c2c21aa6f5f301415457c62cd6ba79030a64b9a3f419735910e4a2d0909 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | e9294b7dedb7d924a9f65f8716441138880975a94103e5c6f4038242a8bd0e2c | — | ok | — | CORRECT_CURRENT | COVERED |
| Q05 | Q05-retired-refusal | get_symbol_source | 3 | 233c2c2c21aa6f5f301415457c62cd6ba79030a64b9a3f419735910e4a2d0909 | 0f6aed8b318a841fd9d768a2c94b2e6af70f076649a7b8a00c013fff7d918a49 | e9294b7dedb7d924a9f65f8716441138880975a94103e5c6f4038242a8bd0e2c | — | ok | — | WRONG_SOURCE | INCOMPLETE |
| Q06 | Q06-index_status | index_status | 2 | 608d3f07bb286e748c7614dd1e7355e6e258c1f11148bad03a1e0e7fef5d5a28 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 5156b650a886c6f7f3cbcbd4e98875facd7412149a471a0059d20c1cf72134d9 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q06 | Q06-recreated-source | get_symbol_source | 3 | 608d3f07bb286e748c7614dd1e7355e6e258c1f11148bad03a1e0e7fef5d5a28 | c88d1978cdbc7618452de9a4faebc8f3e87e54987a3583455b4d1852d6780adf | 5156b650a886c6f7f3cbcbd4e98875facd7412149a471a0059d20c1cf72134d9 | 5338735f8ef308758355cb8b9c9a9adeae3542554730dcd0c7d68291c119231a | ok | — | FALSE_FRESH | INCOMPLETE |
| Q07 | Q07-index_status | index_status | 17 | ff7644d811fc87591b8536340efd055b339513b8e446b331b42a116a24577367 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q07 | Q07-hybrid | hybrid_search | 18 | ff7644d811fc87591b8536340efd055b339513b8e446b331b42a116a24577367 | 12b8219f0df3d5c7cb9c3ffef9ff9bdfbb2d8509d81e9b24c3141c30f9111c80 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q08 | Q08-index_status | index_status | 2 | 4b9857a4eb170e43979a50e0856e5e543ae8d0e9a2d1f3b9c608c0c394090b46 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 2d526546d6f5d29a5ba74fb58a2da3a6b2d143de611c6efffe2a44787f896fac | — | ok | — | CORRECT_CURRENT | COVERED |
| Q08 | Q08-generation-race | get_symbol_source | 3 | 4b9857a4eb170e43979a50e0856e5e543ae8d0e9a2d1f3b9c608c0c394090b46 | 27927fcddd27b4414fe80a8cec6fc7b599acd542cec6dc0d32bec8cec200e265 | 2d526546d6f5d29a5ba74fb58a2da3a6b2d143de611c6efffe2a44787f896fac | 64a16bddce57ea6e2862e50aa943ec10bd56887d5154545bd98956c694bf5cf7 | ok | — | FALSE_FRESH | INCOMPLETE |
| Q09 | Q09-index_status | index_status | 17 | 425b81bc6a37dd9313e08222335a989210a3c239c4413ead3560a9d58f4da114 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q09 | Q09-parser-capability | get_file_outline | 18 | 425b81bc6a37dd9313e08222335a989210a3c239c4413ead3560a9d58f4da114 | 07899ece7a0bd8be84372d08a212a6b662007d517fdf942ddb1b51d4a96e53ed | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q10 | Q10-index_status | index_status | 17 | d7b2b00a042326aeae258f069db5e2d87c53e916d5fd3acb9897aeb9c93cc040 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q10 | Q10-outline | get_file_outline | 18 | d7b2b00a042326aeae258f069db5e2d87c53e916d5fd3acb9897aeb9c93cc040 | 99428f42837bbac576319785f4b7f6bcf812c1da84bc7c11c83e4a7295c3cf23 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q10 | Q10-scoped-source | get_symbol_source | 19 | d7b2b00a042326aeae258f069db5e2d87c53e916d5fd3acb9897aeb9c93cc040 | 4144adbb5ce63fc0499673f8a9e724656653f116e52203bd4825e517d45f0a75 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | ok | — | CORRECT_CURRENT | COVERED |
| Q11 | Q11-index_status | index_status | 17 | 585d894c6acbc077cc6b2f0a9a32a7af0c3f9b6e79365044b5bdee470df32da7 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q11 | Q11-declaration-source | get_symbol_source | 18 | 585d894c6acbc077cc6b2f0a9a32a7af0c3f9b6e79365044b5bdee470df32da7 | 45088b82d7094e8ca9ef263bfc145d213f6ca16f82c645144061a4a9ea20625c | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | ok | — | CORRECT_CURRENT | COVERED |
| Q14 | Q14-index_status | index_status | 17 | 2fda32ecdf8689dd84c7401ca21b3f3a3ec0332e1b33d7915423a23098c4beb8 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q14 | Q14-definition | get_definition | 18 | 2fda32ecdf8689dd84c7401ca21b3f3a3ec0332e1b33d7915423a23098c4beb8 | 4bfb023b521228fef0cf71c19ef816ec14849dfd71cfb59b76b5f3c6c80cbaeb | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | unavailable | LSP_NOT_CONFIGURED | CORRECT_REFUSAL | COVERED |
| Q14 | Q14-references | get_references | 19 | 2fda32ecdf8689dd84c7401ca21b3f3a3ec0332e1b33d7915423a23098c4beb8 | 4bfb023b521228fef0cf71c19ef816ec14849dfd71cfb59b76b5f3c6c80cbaeb | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | unavailable | LSP_NOT_CONFIGURED | CORRECT_REFUSAL | COVERED |
| Q14 | Q14-implementations | get_implementations | 20 | 2fda32ecdf8689dd84c7401ca21b3f3a3ec0332e1b33d7915423a23098c4beb8 | 4bfb023b521228fef0cf71c19ef816ec14849dfd71cfb59b76b5f3c6c80cbaeb | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | unavailable | LSP_NOT_CONFIGURED | CORRECT_REFUSAL | COVERED |

## Gate 2 — Discovery

### R arm

- Status: MEASURED
- Evaluated queries: 4
- Recall (unique related candidates; no rank limit): 0.3750
- MRR: 0.7500
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 0.2500
- Symbol discovery: 0.2500
- Irrelevant candidate rate: 0.0000

### N arm

- Status: MEASURED
- Evaluated queries: 11
- Recall (unique related candidates; no rank limit): 0.4091
- MRR: 0.2727
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 0.8333
- Symbol discovery: 0.7500
- Irrelevant candidate rate: 0.1111

## Gate 3 — Agent loop

- Status: MEASURED
- Both success: 7
- Baseline only: 0
- Nexus only: 1
- Both fail: 4

## Limitations

- SEMANTIC_RELEVANCE_NOT_ESTABLISHED

---
# Retrieval Quality Benchmark Report — quality-worktree-v1

- Profile: `quality-worktree-v1`
- Policy version: `quality-policy-v1`
- Fixture digest: `53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e`
- Nexus commit: `unknown`
- rg version: `ripgrep 15.2.0`
- Run: 2026-11-27T17:52:03.746Z → 2026-11-27T17:52:19.027Z

## Expected tasks

- Q12-primary
- Q12-linked

## Gate 1 — Safety

- Status: **SAFETY_PASS**
- Expected: 2, executed: 4
- Coverage: 4/4
- Missing coverage: none

### Outcome counts

- CORRECT_CURRENT: 4
- CORRECT_REFUSAL: 0
- FALSE_REFUSAL: 0
- FALSE_FRESH: 0
- WRONG_SOURCE: 0
- MISSING: 0
- UNAVAILABLE: 0
- INCONCLUSIVE: 0

### Rates

- Current-source correctness: 1.0000 (4/4)
- Symbol identity resolution: 1.0000 (4/4)
- Safe refusal: 0.0000 (0/4)
- False refusal: 0.0000 (0/4)
- False fresh: 0.0000 (0/4)
- Wrong source: 0.0000 (0/4)
- Missing: 0.0000 (0/4)
- Unavailable: 0.0000 (0/4)

### Mandatory route coverage

| Task | Probe | Tool | Sequence | Setup proof | Args digest | Request snapshot | Publication snapshot | Observed | Reason | Oracle | Coverage |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| Q12-primary | Q12-primary-index_status | index_status | 2 | 82756a10342b781d68a676ebfccd9509429b6abaf019ba0b2108f2498bac1591 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e | — | ok | — | CORRECT_CURRENT | COVERED |
| Q12-primary | Q12-primary-source | get_symbol_source | 3 | 82756a10342b781d68a676ebfccd9509429b6abaf019ba0b2108f2498bac1591 | f61701aaa59b3f5c92f6c6e1d2b1481ba429bee09b5e1ab8267ca9899762fc4d | 53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e | 53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e | ok | — | CORRECT_CURRENT | COVERED |
| Q12-linked | Q12-linked-index_status | index_status | 3 | 1cd57a9c14798ea97eba55a67b0247b5a3a7d0886f63c46a0c7a6334812ba021 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | a2204c94f4f8a8fc9ad4aac7b02e8e111d5668bc70449efab32306a374895d60 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q12-linked | Q12-linked-source | get_symbol_source | 4 | 1cd57a9c14798ea97eba55a67b0247b5a3a7d0886f63c46a0c7a6334812ba021 | f61701aaa59b3f5c92f6c6e1d2b1481ba429bee09b5e1ab8267ca9899762fc4d | a2204c94f4f8a8fc9ad4aac7b02e8e111d5668bc70449efab32306a374895d60 | a2204c94f4f8a8fc9ad4aac7b02e8e111d5668bc70449efab32306a374895d60 | ok | — | CORRECT_CURRENT | COVERED |

## Gate 2 — Discovery

### R arm

- Status: NOT_ESTABLISHED
- Evaluated queries: 0
- Recall (unique related candidates; no rank limit): N/A
- MRR: N/A
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 0.0000
- Symbol discovery: 0.0000
- Irrelevant candidate rate: N/A

### N arm

- Status: MEASURED
- Evaluated queries: 2
- Recall (unique related candidates; no rank limit): 0.5000
- MRR: 0.0000
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 1.0000
- Symbol discovery: 1.0000
- Irrelevant candidate rate: 0.0000

## Gate 3 — Agent loop

- Status: MEASURED
- Both success: 2
- Baseline only: 0
- Nexus only: 0
- Both fail: 0

## Limitations

- SEMANTIC_RELEVANCE_NOT_ESTABLISHED

---
# Retrieval Quality Benchmark Report — quality-lsp-v1

- Profile: `quality-lsp-v1`
- Policy version: `quality-policy-v1`
- Fixture digest: `ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599`
- Nexus commit: `unknown`
- rg version: `ripgrep 15.2.0`
- LSP evidence: STUB_ONLY
- Run: 2026-11-27T17:52:03.746Z → 2026-11-27T17:52:19.027Z

## Expected tasks

- Q13-definition
- Q13-references
- Q13-implementations

## Gate 1 — Safety

- Status: **SAFETY_PASS**
- Expected: 3, executed: 6
- Coverage: 12/12
- Missing coverage: none

### Outcome counts

- CORRECT_CURRENT: 6
- CORRECT_REFUSAL: 0
- FALSE_REFUSAL: 0
- FALSE_FRESH: 0
- WRONG_SOURCE: 0
- MISSING: 0
- UNAVAILABLE: 0
- INCONCLUSIVE: 0

### Rates

- Current-source correctness: 1.0000 (6/6)
- Symbol identity resolution: 1.0000 (6/6)
- Safe refusal: 0.0000 (0/6)
- False refusal: 0.0000 (0/6)
- False fresh: 0.0000 (0/6)
- Wrong source: 0.0000 (0/6)
- Missing: 0.0000 (0/6)
- Unavailable: 0.0000 (0/6)

### Mandatory route coverage

| Task | Probe | Tool | Sequence | Setup proof | Args digest | Request snapshot | Publication snapshot | Observed | Reason | Oracle | Coverage |
|---|---|---|---:|---|---|---|---|---|---|---|---|
| Q13-definition | Q13-definition-index_status | index_status | 4 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-definition | Q13-definition-definition | get_definition | 5 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 15f99a2190f3cac8fd4dc5198053a8145a0c8e9eb0017c2f66f74d44873728b7 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-definition | Q13-definition-references | get_references | 6 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 15f99a2190f3cac8fd4dc5198053a8145a0c8e9eb0017c2f66f74d44873728b7 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-definition | Q13-definition-implementations | get_implementations | 7 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 15f99a2190f3cac8fd4dc5198053a8145a0c8e9eb0017c2f66f74d44873728b7 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-index_status | index_status | 4 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-definition | get_definition | 5 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | e4410690cdd20a17f9456be18fe1314f3896d830d20fcb162a282b05beb90ab2 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-references | get_references | 6 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | e4410690cdd20a17f9456be18fe1314f3896d830d20fcb162a282b05beb90ab2 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-implementations | get_implementations | 7 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | e4410690cdd20a17f9456be18fe1314f3896d830d20fcb162a282b05beb90ab2 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-index_status | index_status | 4 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-definition | get_definition | 5 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 8b515d4efd5a8895eeb6da72aa0cde217465d9721b70f224dceba2e28fa3a8e1 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-references | get_references | 6 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 8b515d4efd5a8895eeb6da72aa0cde217465d9721b70f224dceba2e28fa3a8e1 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-implementations | get_implementations | 7 | 3bca68634b3c220c42e1376cab6b03ef4d58d9dc8829d43651af9c63b1de9886 | 8b515d4efd5a8895eeb6da72aa0cde217465d9721b70f224dceba2e28fa3a8e1 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | ok | — | CORRECT_CURRENT | COVERED |

## Gate 2 — Discovery

### R arm

- Status: NOT_ESTABLISHED
- Evaluated queries: 0
- Recall (unique related candidates; no rank limit): N/A
- MRR: N/A
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 0.0000
- Symbol discovery: 0.0000
- Irrelevant candidate rate: N/A

### N arm

- Status: NOT_ESTABLISHED
- Evaluated queries: 0
- Recall (unique related candidates; no rank limit): N/A
- MRR: N/A
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 0.0000
- Symbol discovery: 0.0000
- Irrelevant candidate rate: N/A

## Gate 3 — Agent loop

- Status: MEASURED
- Both success: 3
- Baseline only: 0
- Nexus only: 0
- Both fail: 0

## Limitations

- SEMANTIC_RELEVANCE_NOT_ESTABLISHED
- Q13 uses a stub adapter; it is not a real LSP validation.
