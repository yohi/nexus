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
