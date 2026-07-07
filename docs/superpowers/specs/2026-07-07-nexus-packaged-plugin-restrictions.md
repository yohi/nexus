# Nexus パッケージ版（業務用 Claude Plugin）配布制限 設計

## 1. 目的と背景

オリジナル（このリポジトリ `@yohi/nexus`）は、ローカル LLM の選択（`ollama` / `openai-compat`）や Prometheus/Grafana メトリクスなど、開発者向けの柔軟性を備える。一方、Bitbucket 経由で業務配布する **パッケージ版プラグイン（`yohi-nexus`）** は、統制・運用簡素化・業務要件のため、機能を意図的に制限する。

本書は「パッケージ版で何を制限し、どう実現するか」を定義する要件・設計ドキュメントである。実装計画（タスク分解）は本書の未確定事項（§6）を確定させた後に別途作成する。

> 関連ドキュメント:
> - 配布機構の設計: [2026-07-03-bitbucket-claude-plugins-marketplace.md](2026-07-03-bitbucket-claude-plugins-marketplace.md)
> - 配布ワークフロー実装計画: [../plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md](../plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md)（本書の決定により staging/前提が改訂される。§7 参照）

## 2. スコープ

- **対象**: Bitbucket 配布用パッケージ版プラグイン（`yohi-nexus`）の機能プロファイルと、それを生成するための最小限のコア変更。
- **非対象**: オリジナルのローカル動作。オリジナルは従来どおり `ollama` + Grafana で動作し続ける（local-first を維持）。

## 3. 制限要件

### 3.1 埋め込み LLM の選択不可（デプロイ時のみ可変）

- 利用者（Claude Code 上のエンドユーザー）は埋め込みプロバイダ/モデルを選択できない。
- ただし、**デプロイ時に GitHub Actions 変数で固定値を変更できる**ようにする（プロバイダ/モデル/リージョン/次元などをデプロイ運用者が設定）。
- 現状のオリジナルは [.claude-plugin/plugin.json](../../../.claude-plugin/plugin.json) の `userConfig` で利用者に選択 UI を提示している。パッケージ版ではこの `userConfig` を除去し、`mcpServers.nexus.env` の `${user_config.*}` 参照を固定値（またはビルド時注入値）へ置換する必要がある。

### 3.2 AWS Bedrock 埋め込みモデルの直接呼び出し

- LiteLLM 等の OpenAI 互換プロキシを経由せず、**AWS Bedrock の埋め込みモデルを直接呼び出す**。
- 現状の埋め込みプロバイダは `ollama` / `openai-compat` の 2 種のみ（[src/config/index.ts:245](../../../src/config/index.ts) のバリデータ、[src/server/factory.ts:544](../../../src/server/factory.ts) の `switch`）。Bedrock は新規プロバイダとしてコアに追加する。

### 3.3 Grafana/メトリクスの除去

- Prometheus メトリクス・Telemetry Aggregator・ダッシュボード（TUI）を業務配布物から除去する。
- 対象コンポーネント: [src/observability/](../../../src/observability)（metrics-collector / metrics-server / registration-client / types）、[src/server/metrics-port.ts](../../../src/server/metrics-port.ts)、[src/bin/aggregator.ts](../../../src/bin/aggregator.ts)、`packages/dashboard`、実行時依存 `prom-client`。

## 4. 推奨アーキテクチャ: 設定駆動の単一コードベース

フォーク・コード複製を避け、**単一コードベース + 設定プロファイル**で原本とパッケージ版を両立する。

- **Bedrock プロバイダをコアに追加**（§3.2）。オリジナルからも利用可能な正規機能とする。
- **「パッケージモード」を設定フラグ化**（§3.1・§3.3）。LLM ロックとメトリクス無効を設定で切り替える。
- **デプロイパイプラインが差分を注入**: 固定 config の焼き込み、`userConfig` 除去、ダッシュボード除外、build スクリプト調整。

この方針により、オリジナルはローカル（`ollama` + Grafana）で動作し続け、パッケージ版は同一コードから「制限プロファイル」として生成される（DRY / local-first 維持）。

## 5. コードベースへの影響（現行コード実態にもとづく）

| 要件 | 主な変更対象 | 内容 |
| --- | --- | --- |
| 3.2 Bedrock | `src/plugins/embeddings/bedrock.ts`（新規） | `BaseEmbeddingProvider` を継承し `embed()` / `healthCheck()` / `dimensions` を実装（契約は [interface.ts](../../../src/plugins/embeddings/interface.ts)）。`openai-compat.ts` が近い実装参考 |
| 3.2 Bedrock | `src/types/index.ts` | `EmbeddingConfig.provider` union に `"bedrock"` を追加（現在 `"ollama" \| "openai-compat" \| "test"`） |
| 3.2 Bedrock | [src/config/index.ts:245](../../../src/config/index.ts) | プロバイダバリデータに `"bedrock"` を追加。AWS リージョン/モデル/資格情報の config 配線 |
| 3.2 Bedrock | [src/server/factory.ts:544](../../../src/server/factory.ts) | `switch (config.embedding.provider)` に `case "bedrock"` を追加 |
| 3.2 Bedrock | `package.json` | `@aws-sdk/client-bedrock-runtime` を依存に追加 |
| 3.1 LLM ロック | `.claude-plugin/plugin.json`（配布時変換） | `userConfig` 除去、`mcpServers.nexus.env` を固定値/注入値へ置換 |
| 3.1 LLM ロック | 設定注入（デプロイ） | 設定優先順位は `env ?? .nexus.json ?? デフォルト`（[config/index.ts:116](../../../src/config/index.ts)）。GitHub Actions 変数を staging の `.nexus.json`（または plugin.json の `env`）へ焼き込む |
| 3.3 メトリクス除去 | `package.json` | **ルート `build` が `npm run build -w packages/dashboard` と `dist/dashboard/cli.js` コピーを含むため、ダッシュボード除外は build スクリプト・bin エントリ（`nexus-dashboard` / `nexus-aggregator`）の調整を伴う**（単なるファイル除外では build が壊れる） |
| 3.3 メトリクス除去 | `src/observability/*` / `metrics-port.ts` / `prom-client` | 設定フラグでメトリクスサーバを起動しない（最小侵襲）か、コードから完全除去するか（§6-4 で決定） |

## 6. 未確定事項（実装前に要決定）

1. **Bedrock モデル**: 例 `amazon.titan-embed-text-v2:0`（1024/512/256 次元）、`amazon.titan-embed-text-v1`（1536 次元）、`cohere.embed-multilingual-v3`（1024 次元）等。次元数はインデックス（LanceDB）に直結するため確定が必須。
2. **AWS 認証方式**: 利用者マシンでの IAM ロール / 環境変数（`AWS_ACCESS_KEY_ID` 等）/ 名前付きプロファイル / SSO のいずれか。
3. **AWS リージョン**、および GitHub Actions 変数で可変にする項目の範囲（provider / model / region / dimensions のどれを可変にするか）。
4. **メトリクス除去の深さ**: 設定フラグで「起動しない」だけにするか、`prom-client` / observability をコードから完全除去するか。前者は最小侵襲だが依存が残る。後者はクリーンだが侵襲的。

## 7. 既存成果物との関係

- **配布機構**は [2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md](../plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md) のソースミラー方式を流用する。ただし本書の決定により、同計画の以下が改訂される:
  - Task 1（staging）: `packages/dashboard` を除外し、固定 config（`.nexus.json` 等）を注入する手順を追加。
  - Prerequisites: Bedrock 用の AWS 資格情報・GitHub Actions 変数を追加。
  - 前段に「Bedrock プロバイダ追加 / パッケージモード実装」（本書 §5 のコア変更）が必要。
- [2026-07-03-bitbucket-claude-plugins-marketplace.md](2026-07-03-bitbucket-claude-plugins-marketplace.md) §4 の「ソースミラー」例外規定とも整合する（ネイティブ依存プラグインの配布形態）。

## 8. 次のステップ

1. §6 の未確定事項を確定する。
2. `brainstorming` スキルで Bedrock プロバイダ設計・パッケージモード・メトリクス除去方針を詰める。
3. `writing-plans` スキルで、(a) コア変更（Bedrock + パッケージモード）と (b) 配布計画改訂 の実装計画を作成する。

> **ステータス: 保留（要件記録済み）。** 実装・詳細設計は未着手。
