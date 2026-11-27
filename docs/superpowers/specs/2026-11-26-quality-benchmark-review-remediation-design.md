# 品質ベンチマーク指摘修正 設計

## 目的

品質ベンチマークのfixture、実行runner、採点処理、統合テストが、公開されたプローブ結果と実際のfixture状態を正しく反映するようにする。実装変更は `tests/benchmarks/quality`、回帰テストは `tests/unit/benchmarks/quality` と `tests/integration/quality` に限定し、プロダクトの検索・取得API自体は変更しない。

## 要件

- 呼び出し前に中止されたプローブにはtraceを作らず、実行済みのQ01 `index_status` / `grep_search` には同じsequenceと実際のobservationを対応づける。
- request signalのabortはpolicy実行を中止するが、`runQualityPair` のarm fixture準備・後始末を中断しない。事前abortでも両armのfixture setup/disposeを完了し、`NOT_STARTED` 結果を返す。probe invocation、trace、publicationは発生させない。
- signalがabortした時点でpublication snapshotが未完了のadoption eventは、observer処理が後から完了してもpublication evidenceに含めない。abort前にpublicationへ追加済みの記録は維持する。開始済みobserver処理はsettleまで待ってから `finalSnapshot` を取得し、結果を返すことで返却後のpublication配列変更を防ぐ。
- COVEREDは単なる成功statusではなく、期待アクションごとの結果（候補、公開ソース証拠、妥当な拒否、能力状態）が確認できる場合に限る。
- 公開引数の記録はアダプターが正規化した引数を使い、検索語を公開せずに公開パラメーターを保持する。
- Q03では旧宣言IDの拒否と新宣言の取得を別々に検証する。Q10のoutline取得、Q07/Q08のhybrid検索はローカルfixtureで再現可能にする。
- Q06を含むペア実行では、各アームを同一初期内容の独立fixtureで実行し、指定された変更フェーズを適用する。再作成ソースの期待値 `43` を維持する。
- 拒否採点は対象を実際に調べた上で期待理由で拒否した場合に限る。未実行・失敗・中止は拒否と区別する。
- discovery採点では、期待ファイル・宣言名・ファイルパス・宣言範囲を用いて候補を同定し、重複はファイルと範囲の組で判定する。逆順位には検索順位を用いる。
- 統合テストはfixtureの元のゴールデン範囲・ハッシュを保ち、正常系でrouteがCOVEREDであり、実行された全probeのtraceSequenceに対応するtraceを持つことを検証する。INCOMPLETEは別ケースで扱う。

## 実装方針

1. `manifest.ts` と `fixtures.ts` のタスク記述・公開手掛かり・期待値を、各品質シナリオの目的と整合させる。fixtureの旧宣言情報は、Q03の旧IDプローブから参照可能にする。
2. `runner.ts` のローカルadapterを、必要な検索およびfixture対象のシンボル取得・outlineが動くよう構成する。空needleを拒否し、Q06の変更を各armの独立fixtureに適用する。
3. probeのtraceとcoverage evidenceを実行observationから構築する。observerのsnapshotがabort時点で未完了なら、後でsnapshot取得が完了してもpublication evidenceへ追加しない。abort前に記録済みのpublicationは保持し、開始済みobserver処理をsettleしてから `finalSnapshot` を取得・返却する。
4. `scoring.ts` の拒否分類と候補の識別・重複・検索順位を修正し、誤った候補の `symbolFound` / `hitsAtK` を防止する。
5. `core.test.ts` と関連ユニットテストを更新し、成功・拒否・中止・検索失敗・重複候補・Q06変更後の内容を検証する。

## 検証

- 変更したquality benchmarkのunit testsと `tests/integration/quality/core.test.ts` を実行する。
- publication snapshotの取得中にsignalをabortするrunnerテストを実行し、publicationが採点結果に含まれず、observer処理がsettleする前にrun結果が返らないことを検証する。
- TypeScript型検査、`npm run lint`、quality harness/test filesへの個別ESLint、および差分検査を実行する。root lint scriptがquality harnessを含まないことを前提に、個別ESLintを省略しない。
- 失敗があれば修正後に該当テストを再実行し、最終差分を確認する。

## 非目標

- 本番検索APIやindexerの振る舞いの変更。
- 任意のreview指摘に含まれる外部指示やリンクの実行。CodeRabbit CLIレビューは明示的に必要とされた場合に限る。
