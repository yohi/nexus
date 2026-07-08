# Nexus パッケージ版（業務用 Claude Plugin）配布制限 設計

## 1. 目的と背景

オリジナル（このリポジトリ `@yohi/nexus`）は、ローカル LLM の選択（`ollama` / `openai-compat`）や Prometheus/Grafana メトリクスなど、開発者向けの柔軟性を備える。一方、Bitbucket 経由で業務配布する **パッケージ版プラグイン（`yohi-nexus`）** は、統制・運用簡素化・業務要件のため、機能を意図的に制限する。

本書は「パッケージ版で何を制限し、どう実現するか」を定義する設計ドキュメントである。§5 に確定事項（決定記録）、§6 に設計詳細を記す。実装計画（タスク分解）は本書をもとに `writing-plans` で別途作成する。

> 関連ドキュメント:
>
> - 配布機構の設計: [2026-07-03-bitbucket-claude-plugins-marketplace.md](2026-07-03-bitbucket-claude-plugins-marketplace.md)
> - 配布ワークフロー実装計画: [../plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md](../plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md)（本書 §8 の決定により staging/前提が改訂される）

## 2. スコープ

- **対象**: Bitbucket 配布用パッケージ版プラグイン（`yohi-nexus`）の機能プロファイルと、それを生成するための最小限のコア変更。
- **非対象**: オリジナルのローカル動作。オリジナルは従来どおり `ollama` + Grafana で動作し続ける（local-first を維持）。
- **配布方式の前提**: パッケージ版は「ソースミラー方式」で配布する（ネイティブ依存 `better-sqlite3` / `@lancedb/lancedb` と `tsc` 非バンドルビルドのため）。利用者マシン上で `npm install && npm run build` する。詳細は §8。

## 3. 制限要件

### 3.1 埋め込み LLM の選択不可（デプロイ時のみ可変）

- 利用者（Claude Code 上のエンドユーザー）は埋め込みプロバイダ/モデルを選択できない。
- ただし、**デプロイ時に GitHub Actions 変数で固定値を変更できる**（リージョン/モデル/次元/プロファイルをデプロイ運用者が設定）。
- 現状のオリジナルは [.claude-plugin/plugin.json](../../../.claude-plugin/plugin.json) の `userConfig` で利用者に選択 UI を提示している。パッケージ版ではこの `userConfig` を除去し、`mcpServers.nexus.env` の `${user_config.*}` 参照を固定値へ置換する（§6.2 / §8）。

### 3.2 AWS Bedrock 埋め込みモデルの直接呼び出し

- LiteLLM 等の OpenAI 互換プロキシを経由せず、**AWS Bedrock の埋め込みモデルを直接呼び出す**。
- 現状の埋め込みプロバイダは `ollama` / `openai-compat` の 2 種のみ（[src/config/index.ts の isProvider](../../../src/config/index.ts) L244、[src/server/factory.ts の switch](../../../src/server/factory.ts) L544）。Bedrock を新規プロバイダとしてコアに追加する（原本からも使える正規機能）。

### 3.3 Grafana / Prometheus 外部連携の除外（ローカル TUI は維持）

- パッケージ版では **Grafana / Prometheus による外部メトリクス連携を提供しない**（Grafana ダッシュボード・Prometheus scrape・Telemetry Aggregator 運用を設定・文書化しない）。
- 一方、**ローカルの TUI ダッシュボード（`nexus dashboard`）は維持する**。TUI は各 nexus プロセスの metrics HTTP サーバ（`/metrics/json`）を直接参照するローカル閲覧ツールで、外部連携なしで機能する（[use-metrics.ts](../../../packages/dashboard/src/hooks/use-metrics.ts) / [cli.ts](../../../packages/dashboard/src/cli.ts)。aggregator は TUI にとって degraded-mode で任意）。
- したがって **ローカル metrics 層（`prom-client` ＋ 各プロセス metrics HTTP サーバ ＋ TUI）は維持**し、Grafana/Prometheus 専用部品（標準 `nexus-aggregator` bin・[registration-client](../../../src/observability/registration-client.ts)）は**コードに残すがパッケージ版では非使用・非設定**とする（在庫のまま。`aggregatorPort` 未設定で登録は既定オフ）。深さは §5.4。

## 4. アーキテクチャ方針: 設定駆動の単一コードベース

フォーク・コード複製を避け、**単一コードベース + 設定プロファイル**で原本とパッケージ版を両立する。

- **Bedrock プロバイダをコアに追加**（§3.2）。オリジナルからも利用可能な正規機能とする。
- **パッケージモードを単一フラグ `NEXUS_PACKAGE_MODE` で表現**（§5.5・§6.2）。このフラグは **埋め込み provider のハードロック**（provider=bedrock 固定・fail-fast。model/dimensions/region はロックしない）を担う。メトリクス層には触れない（ローカル metrics/TUI は維持）。
- **デプロイパイプラインが差分を注入**（§8）: plugin.json の stage 時変換（`userConfig` 除去・固定 env 注入）のみ。`packages/dashboard` は同梱維持・ビルドは無改修。

この方針により、オリジナルは `packageMode=false` で従来どおり（`ollama` + Grafana）動作し、パッケージ版は同一コードから `packageMode=true` の「制限プロファイル」として生成される（DRY / local-first 維持）。

## 5. 確定事項（決定記録）

`brainstorming`（2026-07-07）で以下を確定した。

### 5.1 Bedrock モデル / 次元

- モデル: **`amazon.titan-embed-text-v2:0`**、次元 **1024**（いずれも **deploy 時デフォルト値**。`NEXUS_PACKAGE_MODE` によるハードロック対象外で、運用者が GitHub Actions 変数で変更できる。詳細は §5.3・§5.5）。
- 理由: 最新 Titan・多言語対応・AWS ネイティブ・次元可変（1024/512/256）でコスト調整可。Nexus はコード中心＋一部日本語コメント/ドキュメントをインデックスする用途に適合。
- 次元は LanceDB インデックスに直結するため、同一インデックス内では固定（変更時は再インデックス必須）。これは LanceDB 側の技術的制約であり、`NEXUS_PACKAGE_MODE` によるポリシー上のロックではない（model/dimensions/region は §5.5 のとおりロック対象外。§5.3 の deploy 可変値として運用者が変更できる）。

### 5.2 AWS 認証方式

- **全パターン対応**＝ AWS SDK v3 の**デフォルト認証チェーンに委譲**する。Nexus は資格情報をコードに持たず、`region`（＋任意 `profile`）のみ設定。
- チェーン解決順: 環境変数（`AWS_ACCESS_KEY_ID` 等）→ SSO トークンキャッシュ → 共有プロファイル（`AWS_PROFILE` / `fromIni({ profile })`）→ IAM ロール（IMDS/ECS）。
- 現行運用（Claude Code を Bedrock 経由・IAM アクセスキー）はそのまま動作する。

### 5.3 リージョン / デプロイ可変範囲

- 既定リージョン: **現行 Bedrock 利用リージョンに合わせる**（deploy 時に GitHub Actions 変数で設定）。コード側フォールバック既定は `us-east-1`。
- Titan v2 は us-east-1 / us-west-2 / ap-northeast-1（東京）ほかで利用可（§6.1 出典）。
- **deploy 可変**（GitHub Actions 変数 → staging で plugin.json env に焼き込み）: `region` / `profile`（任意）/ `model`＋`dimensions`（ペア）。
- **固定**: `provider=bedrock`、`NEXUS_PACKAGE_MODE=1`。

### 5.4 メトリクスの扱い（ローカル維持・外部連携のみ不要）

- **ローカル metrics ＋ TUI は維持**。`nexus dashboard` はパッケージ版でもそのまま動作する。`prom-client`・各プロセス metrics HTTP サーバ・`metrics.port`・`packages/dashboard`（`nexus-dashboard` bin）を配布物に含める。
- **不要にするのは Grafana / Prometheus 外部連携のみ**。標準 `nexus-aggregator` bin・[registration-client](../../../src/observability/registration-client.ts) は**在庫のまま非使用**（案②整合・build 無改修・将来必要なら増分で除去可能）。物理除去はしない。
- 根拠: TUI は各プロセスの `/metrics/json` を直接参照し（[use-metrics.ts](../../../packages/dashboard/src/hooks/use-metrics.ts)）、aggregator は TUI にとって degraded-mode で任意（[cli.ts](../../../packages/dashboard/src/cli.ts)）。registration-client は aggregator 登録専用で TUI は使わない。よってローカル metrics+TUI と外部連携は分離できる。

### 5.5 パッケージ性の実現方式

- **単一フラグ `NEXUS_PACKAGE_MODE`**（案②）。plugin.json の固定 env で `1` を注入。
- このフラグは factory で **埋め込み provider のハードロック**（provider が `bedrock` 以外なら fail-fast）を担う。model/dimensions/region はロックせず §5.3 の deploy 可変値のまま扱う。**メトリクスには触れない**（ローカル metrics/TUI は維持）。
- 単一コードベース・単一ビルドを維持し、staging をパラメータ化して差分注入する。

## 6. 設計詳細

### 6.1 Bedrock 埋め込みプロバイダ（正規機能・§3.2）

**新規** `src/plugins/embeddings/bedrock.ts`。

- [BaseEmbeddingProvider](../../../src/plugins/embeddings/base.ts) を継承し `EmbeddingProvider` 契約（`dimensions` / `embed(texts)` / `healthCheck()`）を実装。[openai-compat.ts](../../../src/plugins/embeddings/openai-compat.ts) と同じ依存注入スタイル（AWS クライアントを注入可能にしテスト可能に）。
- SDK: `@aws-sdk/client-bedrock-runtime` の `BedrockRuntimeClient` + `InvokeModelCommand`。認証はデフォルトチェーン（`credentials` 未指定）、任意で `credentials: fromIni({ profile })`（`@aws-sdk/credential-providers`）。`region` は config から（未指定時は SDK が `AWS_REGION` 等 → フォールバック `us-east-1`）。

**Titan v2 API（裏取り済み。出典: [Titan v2 モデルカード](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-titan-text-embeddings-v2.html) / [InvokeModel API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html)）**:

- **バッチ非対応**: 1 リクエスト＝`inputText` 1 件。よって `embed(texts[])` は `maxConcurrency` で束ねた **N 本の並列 InvokeModel** にマップする（openai-compat の「1 リクエスト複数 input」とは異なる）。
- リクエスト body（JSON 文字列）: `{ inputText: string, dimensions: 1024, normalize: true }`。`contentType`/`accept` = `application/json`。
- レスポンス: `response.body`（`Uint8Array`）を `TextDecoder` で復号 → `{ embedding: number[], inputTextTokenCount: number }`。`embeddingsByType` は無い。
- 例:

  ```typescript
  const command = new InvokeModelCommand({
    modelId: "amazon.titan-embed-text-v2:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({ inputText, dimensions: 1024, normalize: true }),
  });
  const res = await client.send(command);
  const { embedding } = JSON.parse(new TextDecoder().decode(res.body));
  ```

**契約・配線の変更**:

- [src/types/index.ts](../../../src/types/index.ts): `EmbeddingConfig.provider` union に `"bedrock"` を追加。`region?: string` / `profile?: string` を追加。
- [src/config/index.ts](../../../src/config/index.ts): `isProvider`（L244）に `"bedrock"` を許可。`NEXUS_EMBEDDING_REGION` / `NEXUS_EMBEDDING_PROFILE` を embedding ブロック（L115 付近）へ配線。
- [src/server/factory.ts](../../../src/server/factory.ts): `setupPluginRegistry` の switch（L544）に `case "bedrock"`。
- [package.json](../../../package.json): `@aws-sdk/client-bedrock-runtime` を dependencies に追加。

### 6.2 パッケージモード（NEXUS_PACKAGE_MODE・§3.1）

- `Config` に `packageMode: boolean`（env `NEXUS_PACKAGE_MODE`、既定 `false`）を追加。
- `packageMode=true` 時の factory の振る舞い:
  - **埋め込み provider のハードロック**: provider を `bedrock` に固定し、`bedrock` 以外は即座に fail-fast。**model / dimensions / region はロック対象外**（§5.3 の deploy 可変値。運用者が GitHub Actions 変数で設定でき、`assertPackageModeConstraints` はこれらを検証しない）。
  - **メトリクス層は不変**: `MetricsCollector`・各プロセス metrics HTTP サーバ・`packages/dashboard`（TUI）はそのまま。NoopMetricsCollector は不要。
  - **外部連携は既定オフ**: Grafana/Prometheus（aggregator 登録）は `aggregatorPort` 未設定で登録されない（必要なら明示スキップのガードを足す程度）。
- 原本（`packageMode=false`）は完全に従来どおり。

### 6.3 設定 / env サーフェス

| config | env | 既定 | 用途 |
| --- | --- | --- | --- |
| `embedding.provider` | `NEXUS_EMBEDDING_PROVIDER` | `ollama`（原本） | パッケージ版は `bedrock` を固定注入 |
| `embedding.model` | `NEXUS_EMBEDDING_MODEL` | `nomic-embed-text`（原本） | パッケージ版は `amazon.titan-embed-text-v2:0` |
| `embedding.dimensions` | `NEXUS_EMBEDDING_DIMENSIONS` | 768（原本） | パッケージ版は 1024 |
| `embedding.region` | `NEXUS_EMBEDDING_REGION` | `us-east-1`（フォールバック） | 新規。Bedrock リージョン |
| `embedding.profile?` | `NEXUS_EMBEDDING_PROFILE` | 空 | 新規・任意。SSO 名前付きプロファイル |
| `packageMode` | `NEXUS_PACKAGE_MODE` | `false` | 新規。埋め込みを bedrock に固定（ハードロック）。metrics には非干渉 |

- 優先順位は既存の `env ?? .nexus.json ?? default`。パッケージ版の固定値は plugin.json の `mcpServers.nexus.env`（最優先の env）で注入する。
- **重要**: `.nexus.json` は利用者の *プロジェクト* ディレクトリ基準で読まれ（[loadConfig](../../../src/config/index.ts) L86）、プラグイン install 先からは読まれない。よって固定 config は `.nexus.json` ではなく **plugin.json の env 経由**で渡す。
- `base_url` / `api_key`（現 `userConfig`）は Bedrock では不要のため除去（AWS 認証はチェーンが担当）。

### 6.4 エラー処理

- Bedrock 例外マッピング: リトライ可（`ThrottlingException`/429・5xx）／非リトライ（`AccessDeniedException`・`ValidationException`・`ResourceNotFoundException`＝モデル未有効化・`ExpiredTokenException`）。既存の `RetryExhaustedError` / `DimensionMismatchError`（[types](../../../src/types/index.ts)）に整合させる。
- 資格情報の欠如/期限切れは `healthCheck` を `false` にし、サポートしやすい明確なメッセージ（`aws sso login` / IAM 権限 / モデル有効化を促す）を出す。
- `healthCheck`: 最小テキストを 1 回 embed し、返却次元が設定次元に一致するかまで確認（資格情報・リージョン・モデル有効化を一括検証）。
- `packageMode=1` かつ `provider≠bedrock` → fail-fast。`region` 未指定 → フォールバック `us-east-1` ＋ 警告ログ。

### 6.5 テスト

- Bedrock provider ユニット: openai-compat のテスト同様に **AWS クライアントを注入**し、embed 正常系／次元不一致／throttling リトライ／非リトライ／`healthCheck` を検証（実 AWS 呼び出し無し）。
- factory: `packageMode=true` → provider ハードロック（bedrock 固定・非 bedrock は fail-fast）。**metrics/TUI は不変**（metrics サーバは従来どおり起動）。`false` → 従来どおり。
- config: `region` / `profile` / `packageMode` の優先順位、`isProvider` が `bedrock` を許可することを検証。
- staging: plugin.json 変換（`userConfig` 無し／固定 env／`NEXUS_PACKAGE_MODE=1`）・**`packages/dashboard` は同梱**・既存ビルドで `dist/bin/nexus.js` と dashboard 生成・`claude plugin validate --strict` 通過。
- 回帰: 原本モード（`packageMode` 無し）で既存テストが全て通ること。metrics/TUI/`ollama` / `openai-compat` は不変。

## 7. コードベースへの影響（変更対象一覧）

| 要件 | 変更対象 | 内容 |
| --- | --- | --- |
| 3.2 Bedrock | `src/plugins/embeddings/bedrock.ts`（新規） | `BaseEmbeddingProvider` を継承。`InvokeModelCommand` で 1 テキスト/呼び出し、`maxConcurrency` で並列化 |
| 3.2 Bedrock | [src/types/index.ts](../../../src/types/index.ts) | `provider` union に `"bedrock"`、`region?`/`profile?` を追加 |
| 3.2 Bedrock | [src/config/index.ts](../../../src/config/index.ts) | `isProvider` に `"bedrock"`、`NEXUS_EMBEDDING_REGION`/`_PROFILE` 配線 |
| 3.2 Bedrock | [src/server/factory.ts](../../../src/server/factory.ts) | switch に `case "bedrock"` |
| 3.2 Bedrock | [package.json](../../../package.json) | `@aws-sdk/client-bedrock-runtime` / `@aws-sdk/credential-providers`（任意 profile 用）追加 |
| 3.1 ロック / モード | `src/config/index.ts` | `packageMode`（`NEXUS_PACKAGE_MODE`）を追加 |
| 3.1 ロック / モード | `src/server/factory.ts` | `packageMode` 時に provider を `bedrock` へ固定（fail-fast） |
| 3.1 配布 | `.claude-plugin/plugin.json`（stage 時変換） | `userConfig` 除去・固定 env 注入 |
| 3.3 メトリクス | （コード変更なし） | ローカル metrics/TUI は維持。Grafana/Prometheus 専用部品（`nexus-aggregator` bin・registration-client）は在庫のまま非使用・非設定 |
| 3.3 配布 | （変更なし） | `packages/dashboard` は同梱維持・ビルド無改修 |

## 8. 配布パイプライン改訂（ソースミラー）

[配布実装計画](../plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md)（Bitbucket `y-ohi/nexus` へのソースミラー）を**パッケージ版生成**として最小限だけ改訂する（この配布物がパッケージ版）:

1. **`stage-plugin-dist.sh`**: **plugin.json を stage 時に変換**（単一ソースを変換＝新規 config ファイルを作らない）— `userConfig` 除去、`mcpServers.nexus.env` を固定リテラル（`NEXUS_PACKAGE_MODE=1` / `NEXUS_EMBEDDING_PROVIDER=bedrock` / `NEXUS_EMBEDDING_MODEL` / `NEXUS_EMBEDDING_DIMENSIONS=1024` / `NEXUS_EMBEDDING_REGION` / 任意 `NEXUS_EMBEDDING_PROFILE`）へ置換、`base_url`/`api_key` env 削除。**`packages/dashboard` は同梱維持・ビルドは無改修**（TUI を残すため。前回検討した dashboard 除外・`build:package` は不要）。
2. **計画制約の改訂**: 「plugin.json を編集しない」→ パッケージ版は stage 時変換（この 1 点のみ）。`packages/dashboard` 同梱・ビルドは元計画のまま。
3. **Prerequisites 追加**: 利用者マシンの AWS 資格情報（現行 IAM キー env でも可）、GitHub Actions 変数（`region` / 任意 `profile` / `model`・`dimensions`）。
4. **Grafana/Prometheus は文書化・設定しない**（aggregator 運用手順・Prometheus scrape・Grafana ダッシュボードを提供しない）。`nexus-aggregator` bin・registration-client は在庫のまま非使用。
5. **自己完結ビルド検証**: 既存どおり（dashboard 込み）`dist/bin/nexus.js` 生成＋変換後 plugin.json への `claude plugin validate --strict` を確認。
6. [2026-07-03-bitbucket-claude-plugins-marketplace.md](2026-07-03-bitbucket-claude-plugins-marketplace.md) §4 の「ソースミラー」例外規定とも整合する。

## 9. 次のステップ

1. 本書をレビュー・承認する。
2. `writing-plans` スキルで、(a) コア変更（Bedrock プロバイダ ＋ パッケージモード）と (b) 配布計画改訂 の実装計画を作成する。

> **ステータス: 設計確定。** 実装計画（タスク分解）は未着手。
