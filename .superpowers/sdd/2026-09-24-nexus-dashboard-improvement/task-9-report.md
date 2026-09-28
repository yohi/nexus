# Task 9 実施報告

## 実施内容

- 旧 Queue / Throughput / DLQ パネルと未使用 metrics helper、および関連テストを削除。
- `MetricPanel` は保持し、既存の compact panel / view を維持。
- 実 CLI を起動する統合テストを追加し、非 TTY での起動、metrics/status endpoint 復帰を検証。
- 再接続テストは dashboard が表示する正常状態 `No active issues` を確認し、root CLI の実ストレージに port file が作られるよう root build 後の成果物で検証。
- Nexus CLI と dashboard CLI の起動終了処理をテストし、子プロセスを終了。

## 検証結果

成功:

- `npm run build`（root）
- `npx tsc -p packages/dashboard/tsconfig.json --noEmit`
- `npx eslint packages/dashboard/src --ext .ts,.tsx`
- `npm run build -w packages/dashboard`
- `npx vitest run --config vitest.config.ts`（`packages/dashboard` で実行。17 files / 70 tests passed）
- `npx tsc --noEmit`（root）
- `npm run lint`（root）

root 全体の Vitest は dashboard 検証とは別に実行され、既存の DNS mock、環境依存 timeout、HTTP v2 等の失敗が発生（14 files failed、35 tests failed、995 passed、1 skipped）。Task 9 の dashboard suite は上記のとおり全件成功。

## コミット

`refactor(dashboard): 旧パネルを削除し統合テストを拡張`

## Task 9 レビュー修正

- brief 指定どおり `metric-panel.tsx` を削除し、同じ Box / Text の構造・枠線・余白・サイズ指定を利用箇所すべて（4 compact panel と Index / Retrieval / Provider / Diagnostics view）へ移植。
- 両 CLI 統合テストを `try/finally` で囲み、失敗時もプロセスを強制終了し、Nexus 子サーバーと一時 project を片付けるように変更。
- 統合テストの CLI 成果物 path を package 実行と root Vitest 実行の両方で解決できるよう修正。

修正後の検証:

- `npm run test:e2e` 成功（2 files / 4 tests passed）。
- Dashboard: tsc、ESLint、build、Vitest 成功（17 files / 70 tests passed）。
- Root: `npx tsc --noEmit`、`npm run lint` 成功。
- Root `npx vitest run` 再実行成功（146 files / 1106 tests passed）。以前の実行で一時的に見られた失敗は再現せず、残存失敗なし。
