# 設定リファレンス

Nexus は `<projectRoot>/.nexus.json` から設定を読み込みます。
すべての項目は環境変数でも上書きできます。
優先順位は環境変数が最優先です。

## 解決順序

1. 環境変数
2. `.nexus.json`
3. 組み込みデフォルト値

## 設定例

```json
{
  "storage": {
    "rootDir": "/workspace/project/.nexus",
    "metadataDbPath": "/workspace/project/.nexus/metadata.db",
    "vectorDbPath": "/workspace/project/.nexus/vectors"
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
    "maxConcurrency": 2,
    "batchSize": 32,
    "retryCount": 3,
    "retryBaseDelayMs": 250
  }
}
```

## Storage

| Field | Type | Default | Environment Variable | Description |
| --- | --- | --- | --- | --- |
| `storage.rootDir` | string | `<projectRoot>/.nexus` | `NEXUS_STORAGE_ROOT_DIR` | Nexus が管理するローカル状態のルートディレクトリ |
| `storage.metadataDbPath` | string | `<projectRoot>/.nexus/metadata.db` | `NEXUS_STORAGE_METADATA_DB_PATH` | SQLite metadata database のパス |
| `storage.vectorDbPath` | string | `<projectRoot>/.nexus/vectors` | `NEXUS_STORAGE_VECTOR_DB_PATH` | LanceDB vector store ディレクトリ |

## Watcher

| Field | Type | Default | Environment Variable | Description |
| --- | --- | --- | --- | --- |
| `watcher.debounceMs` | positive integer | `100` | `NEXUS_WATCHER_DEBOUNCE_MS` | 連続した filesystem event を束ねる待ち時間 |
| `watcher.maxQueueSize` | positive integer | `10000` | `NEXUS_WATCHER_MAX_QUEUE_SIZE` | overflow handling に入る前の最大キュー長 |
| `watcher.fullScanThreshold` | positive integer | `5000` | `NEXUS_WATCHER_FULL_SCAN_THRESHOLD` | incremental 処理から広い scan recovery へ切り替える閾値 |
| `watcher.ignorePaths` | string list | `['node_modules', '.git', '.nexus', 'dist', 'build', 'out', 'coverage', '.cache', '.parcel-cache', 'venv', '.venv', 'env', '.idea', '.vscode', '.DS_Store']` | `NEXUS_WATCHER_IGNORE_PATHS` | 監視・インデックス対象外とするパスのリスト |

## Embedding

| Field | Type | Default | Environment Variable | Description |
| --- | --- | --- | --- | --- |
| `embedding.provider` | `ollama \| openai-compat \| test` | `ollama` | `NEXUS_EMBEDDING_PROVIDER` | 有効化する embedding backend |
| `embedding.model` | string | `nomic-embed-text` | `NEXUS_EMBEDDING_MODEL` | embedding provider へ渡す model 名 |
| `embedding.dimensions` | positive integer | `768` | `NEXUS_EMBEDDING_DIMENSIONS` | 期待する embedding 次元数 |
| `embedding.baseUrl` | string | `http://127.0.0.1:11434` | `NEXUS_EMBEDDING_BASE_URL` | HTTP ベース provider の base URL |
| `embedding.apiKey` | string | unset | `NEXUS_EMBEDDING_API_KEY` | 認証が必要な provider 用の任意 API key |
| `embedding.maxConcurrency` | positive integer | `2` | `NEXUS_EMBEDDING_MAX_CONCURRENCY` | 並列 embedding request の上限 |
| `embedding.batchSize` | positive integer | `32` | `NEXUS_EMBEDDING_BATCH_SIZE` | 1 回の embed batch に含める chunk 数 |
| `embedding.retryCount` | non-negative integer | `3` | `NEXUS_EMBEDDING_RETRY_COUNT` | 一時的失敗に対する retry 回数 |
| `embedding.retryBaseDelayMs` | positive integer | `250` | `NEXUS_EMBEDDING_RETRY_BASE_DELAY_MS` | retry backoff の基準待機時間（ミリ秒） |

## バリデーションの注意点

- 空文字列は無視されます。
- 数値の環境変数は 10 進整数である必要があります。
- `retryCount` は `0` を許容しますが、その他の数値項目は `0` より大きい必要があります。
- 未対応の `embedding.provider` は無視され、設定ファイルまたはデフォルト値へフォールバックします。
