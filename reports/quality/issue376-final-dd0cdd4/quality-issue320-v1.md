# Retrieval Quality Benchmark Report — quality-core-v1

- Profile: `quality-core-v1`
- Policy version: `quality-policy-v1`
- Fixture digest: `f9d1d5218c82b03f3f14485e35f8ebb5e80a4af068ac1aa8608cc32955749af2`
- Nexus commit: `unknown`
- rg version: `ripgrep 15.2.0`
- Run: 2026-11-28T17:16:20.673Z → 2026-11-28T17:16:36.595Z

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

- Status: **SAFETY_PASS**
- Expected: 12, executed: 24
- Coverage: 28/28
- Missing coverage: none

### Outcome counts

- CORRECT_CURRENT: 21
- CORRECT_REFUSAL: 0
- FALSE_REFUSAL: 2
- FALSE_FRESH: 0
- WRONG_SOURCE: 0
- MISSING: 0
- UNAVAILABLE: 0
- INCONCLUSIVE: 1

### Rates

- Current-source correctness: 0.8750 (21/24)
- Symbol identity resolution: 0.8750 (21/24)
- Safe refusal: 0.0000 (0/24)
- False refusal: 0.0833 (2/24)
- False fresh: 0.0000 (0/24)
- Wrong source: 0.0000 (0/24)
- Missing: 0.0000 (0/24)
- Unavailable: 0.0000 (0/24)

### Mandatory route coverage

| Task | Probe | Tool | Sequence | Setup proof | Args digest | Request snapshot | Publication snapshot | Mutation applied | Observed | Reason | Oracle | Coverage |
|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| Q01 | Q01-index_status | index_status | 17 | 4c75ccae8f3e8d6733d5a4e000cc3ae23dd912531e9b47a2675868b8a3975f5c | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q01 | Q01-source | get_symbol_source | 18 | 4c75ccae8f3e8d6733d5a4e000cc3ae23dd912531e9b47a2675868b8a3975f5c | 8265b0746d5e42d8e35947092d3f7e83347fb8de5176fcfa4e7632d28fbf35ad | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q02 | Q02-index_status | index_status | 17 | 7dd79891c05d550b1ec906cf79381801cdd7b022c258a3b7c6caa0c8a9aa55f3 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q02 | Q02-dirty-source | get_symbol_source | 18 | 7dd79891c05d550b1ec906cf79381801cdd7b022c258a3b7c6caa0c8a9aa55f3 | 6e48656ff37e923f1119a78c59fc09d215e4c285507cdcdaa7cf38f094de492e | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q03 | Q03-index_status | index_status | 3 | 62308a40e20ba125fdd56822b05a84d45feec4554538b7f5c1856fd01f9e0d69 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q03 | Q03-old-identity-refusal | get_symbol_source | 4 | 62308a40e20ba125fdd56822b05a84d45feec4554538b7f5c1856fd01f9e0d69 | 4dd64daf6f2be3d8682924157a10c9139a5d52d9f245d97ce53de689cf703b91 | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | — | — | stale_identity | SYMBOL_RETIRED | CORRECT_REFUSAL | COVERED |
| Q03 | Q03-new-identity-source | get_symbol_source | 5 | 62308a40e20ba125fdd56822b05a84d45feec4554538b7f5c1856fd01f9e0d69 | 0fd57ca366fa4b9fa46f7ff9e28b4dfa64d9918d3a1a6c1382635d0ca040b750 | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | 629c29c4df05e3adb75c8d270fe13532056f1e5509ef63a75e22780f9297c33f | — | ok | — | CORRECT_CURRENT | COVERED |
| Q04 | Q04-index_status | index_status | 17 | 26648f0dd5e3a18c87534443dea3a32c0080460baa2b99ef2a746e070d021728 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q04 | Q04-moved-source | get_symbol_source | 18 | 26648f0dd5e3a18c87534443dea3a32c0080460baa2b99ef2a746e070d021728 | 73525b1c2fb6d1a6a164ef17c4211f98a463e74da4898d754a9a80c0f10840ba | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q05 | Q05-index_status | index_status | 2 | c0a907f9262dcc073fa51c9bce4e5cdd3e610c520e2dc6f4924a0c234dcd4a3b | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | e9294b7dedb7d924a9f65f8716441138880975a94103e5c6f4038242a8bd0e2c | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q05 | Q05-retired-refusal | get_symbol_source | 3 | c0a907f9262dcc073fa51c9bce4e5cdd3e610c520e2dc6f4924a0c234dcd4a3b | 0f6aed8b318a841fd9d768a2c94b2e6af70f076649a7b8a00c013fff7d918a49 | e9294b7dedb7d924a9f65f8716441138880975a94103e5c6f4038242a8bd0e2c | — | — | stale | INDEX_FILE_MISSING | CORRECT_REFUSAL | COVERED |
| Q06 | Q06-index_status | index_status | 2 | 15772c2b9c7a220e64b4d39e1cb8608e7671563112b9201756d86f6597c90eb5 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 5338735f8ef308758355cb8b9c9a9adeae3542554730dcd0c7d68291c119231a | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q06 | Q06-recreated-source | get_symbol_source | 3 | 15772c2b9c7a220e64b4d39e1cb8608e7671563112b9201756d86f6597c90eb5 | c88d1978cdbc7618452de9a4faebc8f3e87e54987a3583455b4d1852d6780adf | 5338735f8ef308758355cb8b9c9a9adeae3542554730dcd0c7d68291c119231a | 5338735f8ef308758355cb8b9c9a9adeae3542554730dcd0c7d68291c119231a | — | ok | — | CORRECT_CURRENT | COVERED |
| Q07 | Q07-index_status | index_status | 17 | aba6854e2a455f28fb021a081fefa2ca26d10ba30fe10af99260dae1fd754d5c | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q07 | Q07-hybrid | hybrid_search | 18 | aba6854e2a455f28fb021a081fefa2ca26d10ba30fe10af99260dae1fd754d5c | 12b8219f0df3d5c7cb9c3ffef9ff9bdfbb2d8509d81e9b24c3141c30f9111c80 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q08 | Q08-index_status | index_status | 2 | 9a47f2046fbdbbdcd404999731565e889d3d6114e225df32ab916c06c292ca7e | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 2d526546d6f5d29a5ba74fb58a2da3a6b2d143de611c6efffe2a44787f896fac | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q08 | Q08-generation-race | get_symbol_source | 3 | 9a47f2046fbdbbdcd404999731565e889d3d6114e225df32ab916c06c292ca7e | 27927fcddd27b4414fe80a8cec6fc7b599acd542cec6dc0d32bec8cec200e265 | 2d526546d6f5d29a5ba74fb58a2da3a6b2d143de611c6efffe2a44787f896fac | 64a16bddce57ea6e2862e50aa943ec10bd56887d5154545bd98956c694bf5cf7 | yes | stale | INDEX_FILE_MISSING | CORRECT_REFUSAL | COVERED |
| Q09 | Q09-index_status | index_status | 17 | 7b0a7fe21bf791d4fa43b23b647191be7511ec22aa92d00e7647df3202fd95e8 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q09 | Q09-parser-capability | get_file_outline | 18 | 7b0a7fe21bf791d4fa43b23b647191be7511ec22aa92d00e7647df3202fd95e8 | 07899ece7a0bd8be84372d08a212a6b662007d517fdf942ddb1b51d4a96e53ed | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q10 | Q10-index_status | index_status | 17 | 76aba5973843f94643e68160656d1a0a43704da483395eb5798e67566b198712 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q10 | Q10-outline | get_file_outline | 18 | 76aba5973843f94643e68160656d1a0a43704da483395eb5798e67566b198712 | 99428f42837bbac576319785f4b7f6bcf812c1da84bc7c11c83e4a7295c3cf23 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q10 | Q10-scoped-source | get_symbol_source | 19 | 76aba5973843f94643e68160656d1a0a43704da483395eb5798e67566b198712 | 4144adbb5ce63fc0499673f8a9e724656653f116e52203bd4825e517d45f0a75 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q11 | Q11-index_status | index_status | 17 | ed58171400283b5b4c829f32433916bd7c113d403068a68ddbea8ea0a6b10393 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q11 | Q11-declaration-source | get_symbol_source | 18 | ed58171400283b5b4c829f32433916bd7c113d403068a68ddbea8ea0a6b10393 | 45088b82d7094e8ca9ef263bfc145d213f6ca16f82c645144061a4a9ea20625c | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | ok | — | CORRECT_CURRENT | COVERED |
| Q14 | Q14-index_status | index_status | 17 | 208af666add938815be555c47dbef9d987e990ab8bbcfe8cc585b2d0cb1485f3 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q14 | Q14-definition | get_definition | 18 | 208af666add938815be555c47dbef9d987e990ab8bbcfe8cc585b2d0cb1485f3 | 4bfb023b521228fef0cf71c19ef816ec14849dfd71cfb59b76b5f3c6c80cbaeb | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | unavailable | LSP_NOT_CONFIGURED | CORRECT_REFUSAL | COVERED |
| Q14 | Q14-references | get_references | 19 | 208af666add938815be555c47dbef9d987e990ab8bbcfe8cc585b2d0cb1485f3 | 4bfb023b521228fef0cf71c19ef816ec14849dfd71cfb59b76b5f3c6c80cbaeb | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | unavailable | LSP_NOT_CONFIGURED | CORRECT_REFUSAL | COVERED |
| Q14 | Q14-implementations | get_implementations | 20 | 208af666add938815be555c47dbef9d987e990ab8bbcfe8cc585b2d0cb1485f3 | 4bfb023b521228fef0cf71c19ef816ec14849dfd71cfb59b76b5f3c6c80cbaeb | 50a8179f67b50a8027f3f0683e6055cc5408d9d0fedecd7e486072da683cc196 | — | — | unavailable | LSP_NOT_CONFIGURED | CORRECT_REFUSAL | COVERED |

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
- Recall (unique related candidates; no rank limit): 0.4545
- MRR: 0.3636
- Recall counts unique related candidates across the full collected set; MRR uses ranked adoption evidence. Unranked relevant hits count as 0 in MRR.
- File discovery: 0.8333
- Symbol discovery: 0.8333
- Irrelevant candidate rate: 0.0000

## Gate 3 — Agent loop

- Status: MEASURED
- Both success: 10
- Baseline only: 0
- Nexus only: 1
- Both fail: 1

## Limitations

- SEMANTIC_RELEVANCE_NOT_ESTABLISHED

---
# Retrieval Quality Benchmark Report — quality-worktree-v1

- Profile: `quality-worktree-v1`
- Policy version: `quality-policy-v1`
- Fixture digest: `53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e`
- Nexus commit: `unknown`
- rg version: `ripgrep 15.2.0`
- Run: 2026-11-28T17:16:20.673Z → 2026-11-28T17:16:36.595Z

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

| Task | Probe | Tool | Sequence | Setup proof | Args digest | Request snapshot | Publication snapshot | Mutation applied | Observed | Reason | Oracle | Coverage |
|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| Q12-primary | Q12-primary-index_status | index_status | 2 | 92f502c87f28fafd07f4391f304039a6a65a1468448c83c58f0233a0d3a441c6 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | 53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q12-primary | Q12-primary-source | get_symbol_source | 3 | 92f502c87f28fafd07f4391f304039a6a65a1468448c83c58f0233a0d3a441c6 | f61701aaa59b3f5c92f6c6e1d2b1481ba429bee09b5e1ab8267ca9899762fc4d | 53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e | 53c32617377d80600b59f3bcfbb680f9f132c40ac75fe2e4f310360a4fe08f6e | — | ok | — | CORRECT_CURRENT | COVERED |
| Q12-linked | Q12-linked-index_status | index_status | 3 | 5c08ac227b169b74ea541f2724deba7a9f8983585431a4e48473cf57f5752e5a | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | a2204c94f4f8a8fc9ad4aac7b02e8e111d5668bc70449efab32306a374895d60 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q12-linked | Q12-linked-source | get_symbol_source | 4 | 5c08ac227b169b74ea541f2724deba7a9f8983585431a4e48473cf57f5752e5a | f61701aaa59b3f5c92f6c6e1d2b1481ba429bee09b5e1ab8267ca9899762fc4d | a2204c94f4f8a8fc9ad4aac7b02e8e111d5668bc70449efab32306a374895d60 | a2204c94f4f8a8fc9ad4aac7b02e8e111d5668bc70449efab32306a374895d60 | — | ok | — | CORRECT_CURRENT | COVERED |

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
- Run: 2026-11-28T17:16:20.673Z → 2026-11-28T17:16:36.595Z

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

| Task | Probe | Tool | Sequence | Setup proof | Args digest | Request snapshot | Publication snapshot | Mutation applied | Observed | Reason | Oracle | Coverage |
|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| Q13-definition | Q13-definition-index_status | index_status | 4 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-definition | Q13-definition-definition | get_definition | 5 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 15f99a2190f3cac8fd4dc5198053a8145a0c8e9eb0017c2f66f74d44873728b7 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-definition | Q13-definition-references | get_references | 6 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 15f99a2190f3cac8fd4dc5198053a8145a0c8e9eb0017c2f66f74d44873728b7 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-definition | Q13-definition-implementations | get_implementations | 7 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 15f99a2190f3cac8fd4dc5198053a8145a0c8e9eb0017c2f66f74d44873728b7 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-index_status | index_status | 4 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-definition | get_definition | 5 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | e4410690cdd20a17f9456be18fe1314f3896d830d20fcb162a282b05beb90ab2 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-references | get_references | 6 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | e4410690cdd20a17f9456be18fe1314f3896d830d20fcb162a282b05beb90ab2 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-references | Q13-references-implementations | get_implementations | 7 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | e4410690cdd20a17f9456be18fe1314f3896d830d20fcb162a282b05beb90ab2 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-index_status | index_status | 4 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-definition | get_definition | 5 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 8b515d4efd5a8895eeb6da72aa0cde217465d9721b70f224dceba2e28fa3a8e1 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-references | get_references | 6 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 8b515d4efd5a8895eeb6da72aa0cde217465d9721b70f224dceba2e28fa3a8e1 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |
| Q13-implementations | Q13-implementations-implementations | get_implementations | 7 | 86fe0279fd2189f3683b4213c6117cc7bc8a6192fa26a677268fad0cf15099a5 | 8b515d4efd5a8895eeb6da72aa0cde217465d9721b70f224dceba2e28fa3a8e1 | ac184f73bd82fbfea60beac11f7fa84fc2bcae880eba461ab917f34cca04c599 | — | — | ok | — | CORRECT_CURRENT | COVERED |

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
