# Nexus #320 — Retrieval Correctness and Agent-loop Quality Benchmark Design

**Revision:** R0.1 — Proposed  
**Date:** 2026-11-10  
**Repository:** `yohi/nexus`  
**Issue:** [#320](https://github.com/yohi/nexus/issues/320)  
**Authority:** DOCUMENT_ONLY  
**Implementation:** NOT AUTHORIZED

## 1. Project Goal Contract

### Project Goal

NexusのRetrieval Architectureが、安全性・正確性を維持しながら、単純な`ripgrep + file read`と比較して、AIエージェントのコード探索に実用的な価値を提供することを、再現可能なベンチマークで検証する。

### Deliverables

1. 3段階Gateによる品質評価仕様
2. 独立したMachine-readable Oracle
3. 最小限の決定論的FixtureとScenario Matrix
4. Baseline / Nexus比較Adapterの仕様
5. 決定論的Agent-loop探索Policy
6. 計測・集計・判定・レポート仕様

### Success Criteria

- CorrectnessとFail-Closedを独立に検証できる。
- 正しい拒否、誤拒否、False-freshを区別できる。
- 必要なファイル・シンボルの発見率を測定できる。
- 同一タスクでTool Call・コンテキスト消費・正解到達を比較できる。
- Nexusの優位性が存在しない場合にも、その結果を正しく報告できる。
- 結果がアーキテクチャ維持・改善・簡素化の判断に利用できる。

固定的な改善率は、初回ベンチマークの成功条件としない。

## 2. Scope / Non-goals

### Scope

- Correctness / Fail-Closed
- Discovery Quality
- Deterministic Agent-loop Efficiency
- Worktree Divergence
- Structured Retrieval
- Semantic / Hybrid Discovery
- LSP Definition / References / Implementations
- Machine-readable Report

### Non-goals

- 実LLMによる確率的な探索評価
- 新規Benchmark Frameworkの全面構築
- Nexus本体のRetrieval最適化
- Persistent Semantic Graphの追加
- #299の性能・リソース評価の再実装
- 実験結果に合わせたGolden Answerの変更
- 改善率達成のための探索Policy事後最適化

## 3. Evaluation Architecture

評価は3段階で実施する。

### Gate 1 — Correctness / Fail-Closed

Nexusが現在のWorktreeに対して正しいソースを返すか、検証不能な場合に安全に拒否できるかを検証する。

| Outcome | 意味 |
|---|---|
| CORRECT_CURRENT | 正しい現在ソースを取得 |
| CORRECT_REFUSAL | 拒否が期待される条件で正しく拒否 |
| FALSE_REFUSAL | 安全に取得可能なのに不適切に拒否 |
| FALSE_FRESH | 古いソースを検証済み・Freshとして提示 |
| WRONG_SOURCE | 誤ったソースを取得・採用 |
| MISSING | 必要なソースを取得できない |
| UNAVAILABLE | 機能・依存関係が利用不能 |
| INCONCLUSIVE | 証拠不足、未実行、または判定不能 |

False-freshは独立した安全性違反として記録する。

**Gate 1の判定**

- `SAFETY_PASS`: 必須ケースが実行され、False-freshおよび誤ったソースの安全なものとしての採用が観測されない。
- `SAFETY_FAIL`: 上記の危険な動作を1件以上確認。
- `INCOMPLETE`: 必須ケース未実行、Oracle不明確、証拠不足。

正しい拒否は安全動作として認めるが、正しいソースの発見・取得に成功したものとは扱わない。

誤拒否は安全性違反とは別に集計し、Correctnessの到達率および後続Gateに影響させる。

`SAFETY_PASS`は、有限のFixtureで危険な動作を観測しなかったことを示す。製品全体の安全性の数学的証明ではない。

### Gate 2 — Discovery Quality

発見候補に、タスクの正解となるファイルやシンボルが含まれるかを評価する。

- Recall@K
- MRR
- Expected File Discovery Rate
- Expected Symbol Discovery Rate
- Irrelevant Candidate Rate

候補は、正解Oracleのファイルパス・論理シンボルIDに正規化して比較する。

ChunkとLogical Symbolは同一視しない。1つのシンボルが複数Chunkに分かれた場合も、その事実を保持し、正解の重複として水増ししない。

Golden Relevance Setが定義できないQueryには、Recall@KやMRRを無理に適用しない。

Gate 1に問題があっても診断用のDiscovery測定は可能とするが、安全性を満たさない構成の優位性は認定しない。

### Gate 3 — Agent-loop Efficiency

決定論的な探索Policyを使い、正しいソースへの到達に必要な探索負担を測定する。

- Correct Task Completion Rate
- Tool Calls to First Correct Source
- Logical Operations to First Correct Source
- Context Bytes / Tokens to First Correct Source
- Broad File-read Fallback Frequency
- Wrong-source Adoption Rate
- Task Failure Rate

主要比較は、正しいソースに到達したタスクを対象とする。

ただし、未到達タスクを集計から除いてNexusを有利に見せないため、全タスクの成功率と失敗率も必ず並記する。

途中で誤ったソースを採用したタスクは、後で正解に到達しても、その危険な経過を消去しない。

時間に関する測定値は補助的に記録してよいが、ハードウェア依存の性能評価は#299の責務とする。

## 4. Existing Infrastructure Reuse

以下の#299実装を再利用する。

| 既存資産 | #320での用途 |
|---|---|
| Fixture Generator | 決定論的なソース生成 |
| Fixture Manifest | 生成内容・Revisionの固定 |
| Runtime Assembly | 実際のNexus Runtimeで評価 |
| Synthetic Embedding Provider | ベクトル経路の動作・決定論性検証 |
| Retrieval Handler | 実Tool経路へのアクセス |
| Execution / Report基盤 | 実行記録・環境情報・集計の共通化 |
| Temporary Runtime Isolation | 評価対象Worktree・Storageの分離 |

#299の既存ManifestやReport Schemaは破壊的に変更しない。

#320専用のQuality Scenario Manifest、Agent-loop Trace、Result Schemaを追加する設計とする。

想定配置：

- `tests/benchmarks/quality/`
- `tests/fixtures/quality/`
- `docs/observability/retrieval-quality-benchmarks.md`

この配置は実装時の提案であり、現時点では未作成。

## 5. Independent Oracle

### 原則

Oracleは、Nexusの検索結果やStructured Catalogから正解を作ってはならない。

Fixtureの固定ソース、明示的な期待位置、変更操作、Snapshot情報を根拠として正解を定義する。

### Task Specification

各タスクについて次の情報を保持する。

- `taskId`
- `fixtureId`
- `scenarioId`
- `taskDescription`
- `initialClues`
- `worktreeIdentity`
- `sourceSnapshotDigest`
- `mutationSchedule`
- `expectedFiles`
- `expectedSymbols`
- `expectedSourceHashes`
- `expectedLocations`
- `expectedRefusalConditions`
- `evaluationEligibility`

`taskDescription`と`initialClues`は探索Policyに公開する。

期待ファイル・シンボル・Source HashなどのGolden情報は、評価器だけが参照する。

### Source Correctness

正解判定時には、対象WorktreeのCurrent Sourceを独立に検証する。

取得対象がソース本文であれば、期待する宣言範囲とバイト列・Hashを比較する。

LSPの位置情報は、対象ファイルと位置を検証する。位置検証のみをもって、Project-wide Semantic Freshnessが証明されたとは扱わない。

Mutation Scenarioでは、要求開始時点と結果公開時点のSnapshotを区別する。

### Outcome Integrity

- `not_found`と`unavailable`を混同しない。
- `stale_identity`と通常の検索失敗を混同しない。
- `ok`だが空のLSP応答とCapability Unavailableを区別する。
- 部分検証されたLSP応答を完全検証済みと扱わない。
- 未実行をPASSとして記録しない。

## 6. Deterministic Agent-loop Policy

**採用方式：B — 決定論的探索Policy**

LLMの代わりに、固定された状態遷移と探索ルールによってTool利用を進める。

### Policy States

1. `INITIAL` — タスク・公開ヒントを読み取る
2. `DISCOVER` — 候補ファイル・シンボルを取得
3. `RANK` — 公開情報だけで候補を決定論的に並べる
4. `READ` — 必要なソース・位置情報を取得
5. `VERIFY` — Policyが利用可能な証拠で対象を確認
6. `FALLBACK` — 不十分な結果・安全な拒否に対処
7. `COMPLETE` — 正解候補を採用して終了
8. `EXHAUSTED` — 予算内に探索できず終了

Policyの`VERIFY`はOracleにアクセスしない。

Policyが採用した結果を、実行後に独立したOracleが採点する。Oracleの正誤判定をPolicyへフィードバックして探索を続けることは禁止する。

### Policy Rules

- 同じタスク分類には同じ探索判断ルールを使う。
- 候補の並べ替え規則を固定する。
- Hidden Golden情報を検索クエリに注入しない。
- 同一操作の無制限再試行を禁止する。
- Stale等の明示的な拒否を受けた場合のみ、定義済みFallbackを使う。
- 予算超過は失敗結果として記録する。
- 評価結果を見た後でPolicyを有利に調整しない。

### Exploration Budget

初期値の提案：

| 制約 | 暫定値 |
|---|---|
| 最大論理探索操作 | 12回 / Task |
| 最大候補評価数 | 20件 / Task |
| 最大コンテキスト消費 | 64 KiB / Task |
| 同一操作の再試行 | 最大2回 |

これらは成功率の閾値ではなく、探索コストを比較するための共通予算である。

初回Baseline前に設定値を固定し、設定を変更する場合はPolicy Versionを変更する。

### Policy Fairness

NexusにはNexus固有のToolを使用させる。一方、Baselineには利用できないStructured/LSP Toolを模倣させない。

両者に共通して与えるものは、タスク目標、公開ヒント、探索予算、Oracleおよび正解条件である。

Toolの機能差は比較の対象とするが、Policyから一方にだけ正解情報を与えない。

## 7. Baseline Design

### Baseline R — ripgrep + file read

- `rg`によるテキスト検索
- プロジェクト内のファイル読取り
- 必要範囲の追加読取り
- 同一Policyによる候補の選択・Fallback

`rg`のVersion、引数、対象パス、除外条件を記録する。

検索結果の表示件数・読取り範囲などは、Nexusとの比較に適した同等の予算へ正規化する。

### Nexus N — Full Retrieval

利用可能な経路：

- `grep_search`
- `semantic_search`
- `hybrid_search`
- `get_context`
- `get_file_outline`
- `get_symbol_source`
- `get_symbol_context`
- `get_definition`
- `get_references`
- `get_implementations`

`index_status`などの準備・状態確認操作は、Agent-loopの実際の探索中に使用された場合、計測対象に含める。

初期Index作成はセットアップとして別計測し、探索Loopの数値に混入させない。

### Optional Ablation — Nexus Text-only

必要に応じて、NexusのGrep/Context経路のみを使った比較を追加する。

これは、Nexus固有のStructured・Semantic・LSPによる追加価値と、単なるTool包装による差を区別するための補助評価である。

初期完了に必須とはしない。

### Paired Execution

BaselineとNexusは、同じFixture Recipe、同じCanonical Worktree、同じSource Snapshotから開始する。

比較は原則として順次実行し、各実行前にFixture状態と必要なRuntime状態を再現する。

Worktree内のソースを比較途中で意図せず共有・変更しない。

順序効果がある場合は、同じ条件で実行順を反転した試行も記録する。

## 8. Minimal Fixture and Scenario Matrix

Fixtureを3系列とする。

- **F1 — TS/JS Project:** 複数ファイル、宣言、Import、呼出し、同名シンボル、大きな宣言
- **F2 — Mixed Language:** 部分Parser Coverage、Unsupported Language、Excluded Path
- **F3 — Git Worktree Pair:** Primary / Linked Worktreeで異なる内容と独立したRuntime状態

初期Scenario：

| ID | Scenario | 主な検証 |
|---|---|---|
| Q01 | Clean indexed repository | 正常なCurrent Source取得 |
| Q02 | Dirty / uncommitted edits | 未反映変更とFreshness |
| Q03 | Symbol rename | 旧Identityの拒否 |
| Q04 | Symbol move | 位置・Identity整合 |
| Q05 | Symbol deletion | Retired Identity |
| Q06 | File deletion / recreation | 古いSourceの混入防止 |
| Q07 | Stale semantic/vector data | Discoveryと正確性の分離 |
| Q08 | Generation changes during retrieval | Race / Fail-Closed |
| Q09 | Partial / unsupported parsing | Capability・拒否分類 |
| Q10 | Same names in multiple scopes | Logical Symbol特定 |
| Q11 | Large file / multi-declaration | Chunkと宣言の区別 |
| Q12 | Divergent Git worktrees | Runtime / Source Isolation |
| Q13 | LSP definition/references/implementations | Current-location Correctness |
| Q14 | LSP unavailable / unsupported | 明示的Capability Failure |

Q13はDefinition、References、Implementationsを個別の評価タスクとして保持する。

各Scenarioは独立して再現可能とし、Mutation前後のSnapshotをManifestに保持する。

### Race / Stale Scenario

Q07・Q08では、試験開始時点に必要な古いIndex状態やGeneration競合状態が実際に成立していることをSetup Gateで確認する。

期待状態を再現できなかった場合は、PASSにせず`INCONCLUSIVE`または`INCOMPLETE`とする。

競合状態を作るためのProduction Code改変は、初期設計の前提にしない。

### LSP Execution Boundary

LSPはOwner-approved ExecutableとWorktree単位のTrustを必要とする。

評価は既存の安全境界を迂回しない。

Test-only LSP Stubによる契約検証と、実際のPinned Language Serverを使った結果は別のEvidence Classとして記録する。

LSPの有効化・Host設定・実際のプロセス起動は本Designの承認には含まれない。

## 9. Semantic / Hybrid Evaluation Boundary

既存のSynthetic Embeddingは、意味的類似性を保証しない。

そのため、初期評価を次の2つに分ける。

### Deterministic Functional Evaluation

既存Synthetic Providerを使い、検索結果の形式、現在ソース検証、Fallback、IndexのStale状態を検証する。

この結果をSemantic Relevanceの実用的優位性の証拠にはしない。

### Semantic Relevance Evaluation

意味検索の有用性を判断する場合には、固定されたQuery Corpus、Relevance Labels、Model Identity、Embedding条件を使う。

実モデル由来の固定Embedding Snapshotを使用する場合、Provider/Model/Dimensions/Options、生成条件とFingerprintを明記する。

固定Snapshotでの結果と、将来のLive Provider実行結果は分ける。

適切なCorpusが用意できない場合、Semantic Relevanceの優位性は`NOT_ESTABLISHED`として報告する。合成ベクトルによる結果で代用しない。

## 10. Measurement and Trace Contract

各タスクについて、実行経過をMachine-readable Traceに残す。

必須情報：

- Benchmark / Fixture / Policy Version
- Nexus Commit、設定、Tool Adapter
- Baseline `rg` Version
- Worktree Identity、Snapshot Digest
- Task / Scenario ID
- Tool Name、Normalized Arguments
- Tool Result Status、Result Digest
- Logical Operation Count
- Tool Invocation Count
- Context Bytes
- Fixed TokenizerによるToken Count
- Fallback Count
- Source Adoption Event
- Oracle Verdict
- Refusal / Error Reason
- Completion Status

Tool CallはAPI呼出し単位、Logical Operationはファイル探索・読取り等の実質的な探索操作単位で記録する。

複数の操作を単一のシェル呼出しへまとめるだけでBaselineが有利にならないよう、両方を報告する。

コンテキスト消費は、探索Policyに渡されたTool応答・Source本文を対象とする。内部Index全体のサイズは含めない。

LLMを使用しないため、Token Countは推定コンテキスト負担であり、実際のLLM課金額や推論Token消費とは区別する。

## 11. Reporting and Decision Rules

### Gate Report

Gateごとに以下を独立して報告する。

- Evaluation Status
- Executed / Missing / Inconclusive Cases
- Outcome Counts
- Per-scenario Results
- Known Limitations
- Evidence References

### Agent-loop Comparison

同一タスクのPaired Resultを保持する。

必須集計：

- 両方式とも成功
- Baselineのみ成功
- Nexusのみ成功
- 両方式とも失敗
- Wrong-sourceを採用したタスク
- 正しい拒否で停止したタスク
- 誤拒否で停止したタスク

探索負担は、成功率と併記し、中央値・分布・タスク別差分を提示する。

任意の改善率をPASS条件に設定しない。

### Architecture Decision

| 観測結果 | 判断候補 |
|---|---|
| Safety Fail | 危険な経路の利用・推奨を停止し、原因を限定調査 |
| Safety Pass + 実用価値が確認できる | 現行構成を維持・必要に応じて改善 |
| Safety Pass + 優位性が確認できない | 構成簡素化を検討 |
| Safety Pass + 負担が明確に悪化 | 対象Retrieval経路の縮小・置換を検討 |
| Evidence Incomplete | 優位性を主張せず、不足する証拠を特定 |

簡素化はベンチマークによって自動実行しない。

Human Ownerが実用価値、保守コスト、運用負担を比較して判断する。

## 12. Reproducibility / Safety

- FixtureとGolden OracleはVersion・Digestで固定する。
- Source Revision、設定、Tool Versionを記録する。
- OracleはNexusの観測結果から自動修正しない。
- 変更時は理由とVersion差分を記録する。
- 評価実行用WorktreeとStorageを隔離する。
- Developerの実Worktreeや既存Indexを破壊しない。
- 外部LLM・Embedding APIを初期評価の必須依存にしない。
- LSPのTrust・実行承認を自動生成・迂回しない。
- 未実行、証拠不足、観測された失敗を区別する。
- 安全性違反を他の高スコアで相殺しない。

## 13. Design Acceptance Criteria

初期Designは、以下が確定した時点で完成とする。

- [ ] 3 Gateの目的・順序・判定方法
- [ ] False-fresh、正拒否、誤拒否の分類契約
- [ ] 独立したSource Oracle仕様
- [ ] 決定論的Agent-loop Policy
- [ ] Baseline/Nexusの比較条件
- [ ] 最小FixtureとScenario Matrix
- [ ] #299基盤の再利用境界
- [ ] Semantic / LSPの評価上の制約
- [ ] Machine-readable Trace / Report仕様
- [ ] Human OwnerのArchitecture Decision規則

Design完成とBenchmark実測完了は別の状態とする。

## 14. Stop Conditions and Authority

本DesignはDOCUMENT_ONLYである。

Human Ownerは、本Markdown文書に限るfeatureブランチ作成・Commit・Pushを明示承認した。この承認は、以下に及ばない。

- 追加のGitHubへの書き込み・Commit・Push
- Implementation Planの自動開始
- Production Source変更
- Fixture / Runner実装
- Benchmark実行
- Host環境の変更
- LSP実行承認
- 外部サービスへの書き込み
- 独立レビューの自動開始

DesignについてHuman Ownerの判断が得られた時点で、本Brainstormingは終了可能とする。

未解決事項がある場合も、その危険性・判断への影響を評価し、必要な事項のみOwnerに確認する。

Findingの存在だけを理由に、設計・レビュー工程を反復しない。

---

**Design Status: PROPOSED — AWAITING HUMAN OWNER APPROVAL**

**Implementation Authorization: NONE**
