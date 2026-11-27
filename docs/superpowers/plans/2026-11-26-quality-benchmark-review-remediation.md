# 品質ベンチマーク指摘修正 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 品質ベンチマークのprobe、fixture、採点、統合検証を実際の公開証拠とシナリオ期待値に一致させる。

**Architecture:** 既存のquality harness内で、fixtureと実行runnerが正確な観測・公開証拠を作り、採点器が期待ファイルと宣言範囲から評価する。変更はテスト用benchmark harnessに限定し、本番APIには触れない。

**Tech Stack:** TypeScript、Vitest、Node.js filesystem APIs、既存quality fixture/policy/adapter。

**Spec:** `docs/superpowers/specs/2026-11-26-quality-benchmark-review-remediation-design.md`

## Global Constraints

- 実装変更は `tests/benchmarks/quality` に限定し、回帰テストは `tests/unit/benchmarks/quality` と `tests/integration/quality` に追加する。プロダクトの検索・取得API自体は変更しない。
- 呼び出し前に中止されたプローブにはtraceを作らない。
- request abortはpolicy実行を中止するが、arm fixtureの準備・後始末を中断しない。事前abort時も両armの `NOT_STARTED` 結果を返し、probe trace/publicationを作らない。
- Q06の再作成ソースの期待値 `43` を維持する。
- 検索語を公開せず、アダプターが正規化した公開引数を使う。
- 未実行・失敗・中止を拒否結果として採点しない。

## Review Focus

- signal abortでobserverのsnapshot取得が中断しても、完了後に到着する記録を返却結果へ混入させない。Task 2でabort境界とpublication件数をテストする。
- request signalが事前abort済みでもfixture準備・disposeは完了させ、両armを `NOT_STARTED` として返す。abort signalをfixture作成へ渡してsetupを失敗させない。
- 同名シンボルが別ファイル・別範囲にあるとき、期待宣言だけを関連候補とし、同一ファイル・同一範囲の再採用は一度だけ数える。Task 1で範囲・重複テストを行う。
- 公開引数に検索語と `maxResults` があるとき、digestは検索語を含めず実際の正規化引数を反映する。Task 2でdigestの再現性と入力の非漏えいをテストする。
- Q06のarm実行順によるfixture汚染を防ぎ、双方の初期状態と最終値を独立に検証する。Task 3で各rootの変更前後をテストする。
- route probeの失敗status・空候補・拒否理由を成功扱いしない。Task 2とTask 4でcoverage predicateおよび正常系/不完全系を検証する。

---

### Task 1: Discoveryと拒否の採点を正す

**Files:**

- Modify: `tests/benchmarks/quality/scoring.ts`
- Test: `tests/unit/benchmarks/quality/scoring.test.ts`

**Interfaces:**

- Consumes: `QualityCaseManifest.expectedFiles`, `expectedSymbols`（`filePath`, `name`, `startByte`, `endByte`）、policy traceとadoption event。
- Produces: 既存の `gradeQualityArm(...)` と `gradeDiscovery(...)` の戻り値を維持し、正しい拒否・候補件数・hitsAtK・reciprocalRankを返す。

- [x] **Step 1: 失敗するscoringテストを書く**

  `gradeQualityArm` について、`expectedRefusalConditions` があるだけの未実行・EXHAUSTED・失敗は `CORRECT_REFUSAL` とせず、対象を調べ期待理由の拒否が観測された場合だけそう採点するテストを追加する。

  `gradeDiscovery` について、同名シンボルの別ファイル/別宣言範囲を無関係とすること、同じfilePath+宣言範囲の再採用を1件にすること、異なる範囲を別候補にすること、検索trace順位からreciprocalRankを計算することを個別にテストする。

- [x] **Step 2: 対象テストを実行して失敗を確認**

  Run: `npx vitest run tests/unit/benchmarks/quality/scoring.test.ts`
  Expected: 新規ケースが現状の誤判定を示してFAILする。

- [x] **Step 3: scoringの拒否・候補識別を実装**

  `resolveFinalObservation` はtask期待条件だけで拒否を推定せず、実際のpolicy実行状況と期待拒否証拠を使う。候補キーは採用元のファイルパスと宣言範囲で構成し、期待シンボルはゴールデンのパス・範囲に一致する場合のみ関連とする。候補の検索順位は対応するdiscovery traceの順位に基づける。

- [x] **Step 4: scoringテストを通す**

  Run: `npx vitest run tests/unit/benchmarks/quality/scoring.test.ts`
  Expected: PASS。

- [x] **Step 5: コミット**

  ```bash
  git add tests/benchmarks/quality/scoring.ts tests/unit/benchmarks/quality/scoring.test.ts
  git commit -m "fix: 品質ベンチマークの採点根拠を修正"
  ```

### Task 2: Local adapterとprobe coverage evidenceを正す

**Files:**

- Modify: `tests/benchmarks/quality/runner.ts`
- Modify: `tests/benchmarks/quality/adapters.ts`
- Modify: `tests/benchmarks/quality/canonical-json.ts`
- Modify: `tests/benchmarks/quality/policy.ts`
- Test: `tests/unit/benchmarks/quality/runner.test.ts`
- Test: `tests/unit/benchmarks/quality/runner-glob.test.ts`
- Test: `tests/unit/benchmarks/quality/adapters.test.ts`
- Test: `tests/unit/benchmarks/quality/canonical-json.test.ts`

**Interfaces:**

- Consumes: `QualityAdapter.invoke(tool, args, signal, { traceSequence })` と `QualityObservation`。
- Produces: `collectQualityRouteCoverage(...)` がprobeごとに `QualityProbeEvidence` と一致する `QualityTraceEvent` を返し、coverageを期待アクションに基づいて分類する。

- [x] **Step 1: Local adapter/probeの失敗テストを書く**

  runner単体テストで、空needle拒否、fixture内grep結果、Q03旧ID拒否と新ID成功、Q10 outline、Q07/Q08 hybrid検索、`normalizedPublicArgs` digest、全期待条件に達した場合だけCOVEREDとなることを検証する。否定globのみの指定とsemantic-search除外、削除済みfixtureへのnot-found応答、undefinedを除いたprobe引数、Q01の各実行probeに対するtrace sequence/result status/digestの一致、開始前abortでtraceが増えないことも検証する。adapterテストでは拒否テキスト内のsource露出バイト数を検証する。

- [x] **Step 2: 対象テストを実行して失敗を確認**

  Run: `npx vitest run tests/unit/benchmarks/quality/runner.test.ts`
  Expected: 新規ケースが現状未接続サービス、空trace、誤ったcoverageを示してFAILする。

- [x] **Step 3: Local adapterをfixture対応にする**

  `createNexusAdapterForRoot` に、既存tool handlerが要求するfixture対象 `symbolRetrievalService` と動作する `SearchOrchestrator.search` を接続する。`LocalGrepEngine.searchFile` ではneedleが空なら検索前に結果なしを返し、非空needleの既存検索動作は維持する。Q03の旧IDはfixtureの旧宣言IDを使い、新宣言の取得は新IDのままにする。

  fixtureファイル削除後のoutline/source検索は `ENOENT` を `not_found` 応答へ変換する。glob指定は肯定・否定パターンを共通に評価し、否定パターンだけの場合は除外対象以外を検索する。

- [x] **Step 4: coverage・公開引数・probe traceを実装**

  `isProbeCovered` を期待アクション別に検証する関数へ変更する。検索の公開引数digestには `observation.normalizedPublicArgs` を使う。各実行済みprobeについて、割当済みsequenceとobservation由来のtraceを記録し、signalがprobe呼び出し前にabort済みならtraceは追加しない。

  fallback probe引数から未定義フィールドを除外する。canonical JSONはオブジェクトのundefined値をJSON serializationと同様に省略し、policyとfixture digestで一つの実装を共有する。sourceを含まないJSON拒否文はsource露出バイト数に加算しない。

  observer publicationの処理完了を待ってから `finalSnapshot` を取得する。policyのabort race後に完了したobserver記録を返却へ含めない場合は、待機境界を明示的に固定するテストを追加する。

- [x] **Step 5: runnerとadapterテストを通す**

  Run: `npx vitest run tests/unit/benchmarks/quality/runner.test.ts tests/unit/benchmarks/quality/adapters.test.ts`
  Expected: PASS。

- [x] **Step 6: コミット**

  ```bash
  git add tests/benchmarks/quality/runner.ts tests/unit/benchmarks/quality/runner.test.ts tests/unit/benchmarks/quality/adapters.test.ts
  git commit -m "fix: 品質ベンチマークのprobe証拠を修正"
  ```

### Task 3: Paired armのfixture分離と変更スケジュールを実装

**Files:**

- Modify: `tests/benchmarks/quality/runner.ts`
- Modify: `tests/benchmarks/quality/fixtures.ts`
- Test: `tests/unit/benchmarks/quality/runner.test.ts`

**Interfaces:**

- Consumes: `OwnedQualityFixture`, `applyQualityMutation(fixture, taskId, phase)`、taskの `mutationSchedule`。
- Produces: `runQualityPair(...)` はR/Nそれぞれ独立rootの初期状態から実行した結果を返す。

- [x] **Step 1: Q06の独立状態と値を検証する失敗テストを書く**

  Q06のペア実行で、各armのrootが独立し、`during_request` の削除後に `before_publication` で再作成されたファイルが値 `43` を持つことを検証する。armの順番を変えても他armのfixtureを汚染しないことも確認する。

- [x] **Step 2: 対象テストを実行して失敗を確認**

  Run: `npx vitest run tests/unit/benchmarks/quality/runner.test.ts`
  Expected: 現行の単一root実行と未適用mutationがテスト失敗として確認できる。

- [x] **Step 3: armごとのfixtureを作成して変更を適用**

  `runSingleArm` にowned fixtureとtaskを渡す。armごとに同じcaseから独立fixtureを作成し、`before_request` を実行開始前、`during_request` を指定されたrequest境界、`before_publication` を公開直前に適用する。全arm結果を採点した後、それぞれのowned fixtureをdisposeする。Q06の再作成ソースは既存の `43` を保持する。

- [x] **Step 4: Q06と既存paired testを通す**

  Run: `npx vitest run tests/unit/benchmarks/quality/runner.test.ts tests/integration/quality/core.test.ts`
  Expected: PASS。Q06両armが独立し、最終公開ソースが期待値に一致する。

- [x] **Step 5: コミット**

  ```bash
  git add tests/benchmarks/quality/runner.ts tests/benchmarks/quality/fixtures.ts tests/unit/benchmarks/quality/runner.test.ts
  git commit -m "fix: 品質ペア実行のfixtureを分離"
  ```

### Task 4: マニフェストとQ01統合テストをゴールデン準拠にする

**Files:**

- Modify: `tests/benchmarks/quality/manifest.ts`
- Modify: `tests/benchmarks/quality/fixtures.ts`（Task 3と共有する差分は同時に確認）
- Modify: `tests/integration/quality/core.test.ts`
- Test: `tests/unit/benchmarks/quality/contracts.test.ts`

**Interfaces:**

- Consumes: scenario別 `QUALITY_CASES_V1` と `createQualityFixture(...)` のgenerated oracle case。
- Produces: Q01のintegration fixtureはgenerated goldenを維持し、成功caseではroute statusとtrace correspondenceを必須にする。

- [x] **Step 1: manifest/fixture/testの失敗を固定する**

  manifest検証でQ01などのpublic taskにpolicyが解析可能な公開手掛かりがあることを確認する。Q03 old declarationのIDがfixture内にあることを確認する。Q01 integrationではゴールデンのexpected range/hashを保持すること、成功系でrouteがCOVEREDかつ実行済みtraceSequenceごとにtraceがあることを検証する。

- [x] **Step 2: 対象テストを実行して失敗を確認**

  Run: `npx vitest run tests/unit/benchmarks/quality/contracts.test.ts tests/integration/quality/core.test.ts`
  Expected: placeholder manifest、whole-file golden override、緩すぎるroute assertionがFAILする。

- [x] **Step 3: マニフェストと統合fixtureを修正**

  placeholder clueをscenarioに合う公開手掛かりへ置き換え、必要なpolicy clueを設定する。`core.test.ts` の `makeTask` は `expectedSymbols` と `expectedSourceHashes` を上書きせず、generated fixtureから得た対象宣言に対するペア実行を行う。正常系routeでは `COVERED` を必須にし、trace correspondenceを検証する。INCOMPLETEと開始前abortの挙動は別testにする。

- [x] **Step 4: integrationとbenchmark unit testsを通す**

  Run: `npx vitest run tests/unit/benchmarks/quality tests/integration/quality/core.test.ts`
  Expected: PASS。

- [x] **Step 5: コミット**

  ```bash
  git add tests/benchmarks/quality/manifest.ts tests/benchmarks/quality/fixtures.ts tests/integration/quality/core.test.ts tests/unit/benchmarks/quality/contracts.test.ts
  git commit -m "test: 品質Q01のゴールデンとrouteを検証"
  ```

### Task 5: 全体検証と最終レビュー

**Files:**

- Verify: `tests/benchmarks/quality/`
- Verify: `tests/integration/quality/core.test.ts`

- [x] **Step 1: quality benchmark関連テストを再実行**

  Run: `npx vitest run tests/unit/benchmarks/quality tests/integration/quality/core.test.ts`
  Expected: PASS。

- [x] **Step 2: 型検査と差分検査**

  Run: `npx tsc --noEmit` および `git diff --check`
  Expected: 型エラーなし、whitespace errorなし。

- [x] **Step 3: 最終差分を確認してpush**

  `git status --short` と `git log` を確認し、変更対象が本計画に限定されていることを確認してから、作業ブランチをoriginへpushする。

  Full-suite note: `npm test` produced 242 passing files and one unrelated failure in `tests/integration/performance/retrieval.test.ts` (`readiness required`). The earlier baseline had three unrelated failures; this run reproduced only the retrieval failure. The quality benchmark suite, typecheck, and diff check passed.

### Task 6: PR review follow-up regressionsと計画整合

**Files:**

- Modify: `tests/benchmarks/quality/scoring.ts`
- Modify: `tests/benchmarks/quality/runner.ts`
- Modify: `tests/benchmarks/quality/adapters.ts`
- Modify: `tests/benchmarks/quality/canonical-json.ts`
- Modify: `tests/benchmarks/quality/policy.ts`
- Test: `tests/unit/benchmarks/quality/scoring.test.ts`
- Test: `tests/unit/benchmarks/quality/runner.test.ts`
- Test: `tests/unit/benchmarks/quality/runner-glob.test.ts`
- Test: `tests/unit/benchmarks/quality/adapters.test.ts`
- Test: `tests/unit/benchmarks/quality/canonical-json.test.ts`
- Update: `docs/superpowers/plans/2026-11-26-quality-benchmark-review-remediation.md`
- Update: `docs/superpowers/specs/2026-11-26-quality-benchmark-review-remediation-design.md`

**Acceptance:**

- 採点で、完了した空検索結果が既存の成功採用を上書きしない。
- glob否定、削除済みfixture、abort時のarm fixture準備、生成manifestに基づく採点を回帰テストで固定する。
- source-free refusal JSONをsource露出として数えず、canonical JSONとfallback probe引数からundefined object fieldsを省略する。
- design specにrequest-abortとfixture setup/cleanupの境界を明記する。

- [x] 回帰テストを実装変更より先に追加し、対象ケースのRED→GREENを確認した。
- [x] レビュー計画とspecを変更ファイル、abort境界、lintコマンドに合わせて更新した。
- [x] `npx vitest run tests/unit/benchmarks/quality tests/integration/quality/core.test.ts`: 9 files / 208 tests passed.
- [x] `npx tsc --noEmit`、`npm run lint`、`git diff --check` passed; the plan/spec Prettier check passed.
- [x] Targeted ESLint was run. Root `npm run lint` passes; benchmark/test ESLint reports pre-existing findings in `tests/benchmarks/quality/policy.ts` and `tests/unit/benchmarks/quality/policy.test.ts`, confirmed against `HEAD`. Other changed benchmark/test files pass.
