# 設定リファレンス

Nexus は `<projectRoot>/.nexus.json` から設定を読み込みます。
多くの項目は環境変数でも上書きできますが、一部の項目はプロジェクト設定を優先します。

## 解決順序

通常の解決順序は以下です。

1. 環境変数
2. `.nexus.json`
3. 組み込みデフォルト値

例外として、`projectName` と `aggregatorPort` はプロジェクト固有設定を優先するため、`.nexus.json`、環境変数、組み込みデフォルト値の順で解決されます。Dashboard CLI の Aggregator port だけは CLI 引数 `--aggregator-port` が最優先です。

## 設定例

```json
{
  "projectName": "my-project",
  "aggregatorPort": 9470,
  "storage": {
    "rootDir": ".nexus",
    "metadataDbPath": ".nexus/metadata.db",
    "vectorDbPath": ".nexus/vectors"
  },
  "watcher": {
    "debounceMs": 100,
    "maxQueueSize": 10000,
    "fullScanThreshold": 5000
  },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "baseUrl": "http://127.0.0.1:11434",
    "apiKey": "",
    "maxConcurrency": 1,
    "batchSize": 4,
    "retryCount": 3,
    "retryBaseDelayMs": 250,
    "timeoutMs": 120000,
    "ollamaNumThread": 2
  }
}
```

## Project Identity and Metrics Ports

| Field | Type | Default | Environment Variable | Description |
| --- | --- | --- | --- | --- |
| `projectName` | string | project root basename | `NEXUS_PROJECT_NAME` | Prometheus の `project` default label と Aggregator 登録 payload の `projectId` に使用されます。`.nexus.json` の値が環境変数より優先されます。 |
| `metricsPort` | port number | OS による自動割当 | `NEXUS_METRICS_PORT` | Nexus プロセス自身の `/metrics`, `/metrics/json`, `/health` HTTP サーバーの待受ポートです。 |
| `aggregatorPort` | port number | `9470` | `NEXUS_AGGREGATOR_PORT` | Dashboard Aggregator の待受ポート、および Nexus プロセスが Heartbeat 登録する先のポートです。`.nexus.json` の値が環境変数より優先されます。 |

Dashboard CLI では `--aggregator-port` が `aggregatorPort` と `NEXUS_AGGREGATOR_PORT` より優先されます。Nexus サーバープロセスには CLI 引数がないため、`aggregatorPort`、`NEXUS_AGGREGATOR_PORT`、`9470` の順で解決されます。

## Storage

| Field                    | Type   | Default                            | Environment Variable             | Description                                      |
| ------------------------ | ------ | ---------------------------------- | -------------------------------- | ------------------------------------------------ |
| `storage.rootDir`        | string | `<projectRoot>/.nexus`             | `NEXUS_STORAGE_ROOT_DIR`         | Nexus が管理するローカル状態のルートディレクトリ |
| `storage.metadataDbPath` | string | `<projectRoot>/.nexus/metadata.db` | `NEXUS_STORAGE_METADATA_DB_PATH` | SQLite metadata database のパス                  |
| `storage.vectorDbPath`   | string | `<projectRoot>/.nexus/vectors`     | `NEXUS_STORAGE_VECTOR_DB_PATH`   | LanceDB vector store ディレクトリ                |

## Watcher

| Field                       | Type             | Default                                                                                                                                                                                                                                               | Environment Variable                | Description                                             |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `watcher.debounceMs`        | positive integer | `100`                                                                                                                                                                                                                                                 | `NEXUS_WATCHER_DEBOUNCE_MS`         | 連続した filesystem event を束ねる待ち時間              |
| `watcher.maxQueueSize`      | positive integer | `10000`                                                                                                                                                                                                                                               | `NEXUS_WATCHER_MAX_QUEUE_SIZE`      | overflow handling に入る前の最大キュー長                |
| `watcher.fullScanThreshold` | positive integer | `5000`                                                                                                                                                                                                                                                | `NEXUS_WATCHER_FULL_SCAN_THRESHOLD` | incremental 処理から広い scan recovery へ切り替える閾値 |
| `watcher.ignorePaths`       | string list      | `['node_modules', '.git', '.worktrees', '.nexus', 'dist', 'build', 'out', 'coverage', '.cache', '.parcel-cache', 'venv', '.venv', 'env', '.idea', '.vscode', '.DS_Store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', '*.lock']` | `NEXUS_WATCHER_IGNORE_PATHS`        | 監視・インデックス対象外とするパスのリスト              |

> **シークレットファイルの常時除外**: `.env` および `.env.*` は、`watcher.ignorePaths` を `.nexus.json` や `NEXUS_WATCHER_IGNORE_PATHS` で上書きした場合でも、**常に**除外対象としてマージされます。シークレットが誤ってインデックス（ベクトル DB）へ取り込まれるのを防ぐためで、上書きによって再度有効化することはできません。

## Embedding

| Field                        | Type                                         | Default                             | Environment Variable                  | Description                                                                                                         |
| ---------------------------- | -------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `embedding.provider`         | `ollama \| openai-compat \| bedrock \| test` | `ollama`                            | `NEXUS_EMBEDDING_PROVIDER`            | 有効化する embedding backend。`bedrock` は AWS Bedrock Runtime (`InvokeModelCommand`) を直接呼び出します            |
| `embedding.model`            | string                                       | `nomic-embed-text`                  | `NEXUS_EMBEDDING_MODEL`               | embedding provider へ渡す model 名                                                                                  |
| `embedding.dimensions`       | positive integer                             | `768`                               | `NEXUS_EMBEDDING_DIMENSIONS`          | 期待する embedding 次元数                                                                                           |
| `embedding.baseUrl`          | string                                       | `http://127.0.0.1:11434`            | `NEXUS_EMBEDDING_BASE_URL`            | HTTP ベース provider の base URL                                                                                    |
| `embedding.apiKey`           | string                                       | unset                               | `NEXUS_EMBEDDING_API_KEY`             | 認証が必要な provider 用の任意 API key                                                                              |
| `embedding.region`           | string                                       | unset（フォールバック `us-east-1`） | `NEXUS_EMBEDDING_REGION`              | `bedrock` provider 用の AWS リージョン。未設定時はプロバイダ側で `us-east-1` にフォールバックし警告ログを出力します |
| `embedding.profile`          | string                                       | unset                               | `NEXUS_EMBEDDING_PROFILE`             | `bedrock` provider が `fromIni({ profile })` で名前付き AWS プロファイルの認証情報を使う場合に指定する任意項目      |
| `embedding.maxConcurrency`   | positive integer                             | `1`                                 | `NEXUS_EMBEDDING_MAX_CONCURRENCY`     | 並列 embedding request の上限                                                                                       |
| `embedding.batchSize`        | positive integer                             | `4`                                 | `NEXUS_EMBEDDING_BATCH_SIZE`          | 1 回の embed batch に含める chunk 数                                                                                |
| `embedding.retryCount`       | non-negative integer                         | `3`                                 | `NEXUS_EMBEDDING_RETRY_COUNT`         | 一時的失敗に対する retry 回数                                                                                       |
| `embedding.retryBaseDelayMs` | positive integer                             | `250`                               | `NEXUS_EMBEDDING_RETRY_BASE_DELAY_MS` | retry backoff の基準待機時間（ミリ秒）                                                                              |
| `embedding.timeoutMs`        | positive integer                             | `120000`                            | `NEXUS_EMBEDDING_TIMEOUT_MS`          | embedding HTTP リクエスト 1 回あたりのタイムアウト（ミリ秒）                                                        |
| `embedding.ollamaNumThread`  | integer `1`〜`16`                            | `2`                                 | `NEXUS_OLLAMA_NUM_THREAD`             | Ollama `/api/embed` リクエストに渡す `options.num_thread`。無効な値は `2` にフォールバックします。                  |

## Package Mode

| Field | Type | Default | Environment Variable | Description |
| --- | --- | --- | --- | --- |
| `packageMode` | boolean | `false` | `NEXUS_PACKAGE_MODE` | `true` の場合、`embedding.provider` を `bedrock` にハードロックします（`bedrock` 以外を指定するとサーバー起動時に fail-fast で例外を投げます）。`model` / `dimensions` / `region` はロック対象外で、デプロイ時に変更可能です。ローカル metrics HTTP サーバーおよび `nexus dashboard`（TUI）は維持されますが、Grafana/Prometheus 向け Aggregator への自動登録（Heartbeat）はスキップされます。 |

## Indexing

| Field                   | Type             | Default           | Environment Variable            | Description                                                                                                                                               |
| ----------------------- | ---------------- | ----------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indexing.maxFileBytes` | positive integer | `1048576` (1 MiB) | `NEXUS_INDEXING_MAX_FILE_BYTES` | embedding 対象とするファイルの最大バイト数（UTF-8）。これを超えるファイルは embedding せずスキップし、`skippedFiles` に記録します（DLQ には送られません） |

## バリデーションの注意点

- 空文字列は無視されます。
- 数値の環境変数は 10 進整数である必要があります。
- `retryCount` は `0` を許容しますが、その他の数値項目は `0` より大きい必要があります。
- `embedding.ollamaNumThread` は `1` から `16` までの整数のみを受け付け、`0`、負数、小数、文字列、`16` を超える値はデフォルト `2` にフォールバックします。
- 未対応の `embedding.provider` は無視され、設定ファイルまたはデフォルト値へフォールバックします。
- `NEXUS_PACKAGE_MODE` は `1`/`true`/`0`/`false`（大文字小文字を区別しない）のみを受け付け、その他の値は無視されて `.nexus.json` の設定またはデフォルト `false` にフォールバックします。

## パフォーマンスチューニング: CPU-only Ollama 環境

`maxConcurrency` のデフォルトは **`1`** で、CPU-only Ollama でも安全な保守的値です。Ollama が **GPU アクセラレーションなし**（CPU のみ）で動作している場合、`maxConcurrency` を `1` より上げるとスレッド競合により頻繁にタイムアウトが発生し、DLQ (Dead Letter Queue) にエントリが溜まりやすくなります。CPU-only 環境では既定の `1` のままにしてください。

### 推奨設定

CPU-only 環境では以下を推奨します:

```bash
export NEXUS_EMBEDDING_MAX_CONCURRENCY=1
export NEXUS_OLLAMA_NUM_THREAD=2
```

あるいは `.nexus.json`:

```json
{
  "embedding": {
    "maxConcurrency": 1,
    "ollamaNumThread": 2
  }
}
```

### CPU 競合の症状

- ログに `RetryExhaustedError` が頻発する
- `index_status` ツールの `skippedFiles` カウントが急増する
- Ollama が全てのリクエストに対して応答が遅い
- DLQ recovery sweep の `abandoned` カウンタが増加する

### 目安

| 環境             | 推奨 `maxConcurrency` |
| ---------------- | --------------------- |
| CPU-only Ollama  | `1`                   |
| GPU (8GB VRAM)   | `2`〜`3`              |
| GPU (16GB+ VRAM) | `4`〜`8`              |

VRAM および モデルサイズに応じて段階的に上げ、`abandoned` メトリクスが増えない範囲で最大化してください。

## プロセスロック

Nexus は同じ `storage.rootDir` に対して複数プロセスが同時起動するのを防ぐため、`proper-lockfile` によるファイルベースロックを取得します。

- 起動時、`storage.rootDir` 直下に `nexus.pid` を作成し、排他的アクセス権を獲得します。
- ロック獲得に失敗した場合は、同じプロジェクトの Nexus プロセスが既に稼働している可能性があるため起動を中止します。
- 通常終了時はロックを解放します。
- クラッシュ等で残った stale lock は `proper-lockfile` の stale 検出により自動回復されます。

**注意**: `dashboard` サブコマンドはインデックスを行わないため、このプロジェクト単位ロックを取得しません。

## HTTP Bridge / Managed Server

`nexus http-bridge` は、プロジェクトごとに 1 つの loopback HTTP Nexus プロセス（managed server）を自動的に発見または起動します。以下は関連する CLI 引数・環境変数です（`.nexus.json` の項目ではありません）。

| CLI 引数 | 環境変数 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `--project-root <path>` | `NEXUS_PROJECT_ROOT` | カレントディレクトリ | Bridge および `nexus` 本体が解決するプロジェクトルート。managed server の descriptor (`endpoint.json`) や `storage.rootDir` はこのルートを基準に解決されます。 |
| `--idle-shutdown-ms <ms>` | `NEXUS_IDLE_SHUTDOWN_MS` | `0` | `--managed` server がアクティブなクライアント接続数 0 になってから自動終了までの待機時間（ミリ秒）。`0` は即時終了。 |

> **注意**: `--managed` および `--port 0 --managed` は、`nexus http-bridge` がプロジェクトのコネクター経由で内部的に起動する子プロセス専用の隠しオプションです。通常の運用では手動指定する必要はありません。
