# MCP ツールリファレンス

Nexus は `createNexusServer()` を通じて 6 つの MCP ツールを公開します。
すべてのレスポンスは structured JSON content として返されます。

## `semantic_search`

インデックス済みコードチャンクに対する vector similarity search です。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | 自然言語またはコード寄りの検索クエリ |
| `topK` | positive integer | no | 返す最大件数 |
| `filePattern` | string | no | 任意の file glob filter |
| `language` | string | no | 任意の言語 filter |

### レスポンス

```json
{
  "results": [
    {
      "chunk": {
        "id": "src/auth.ts:1",
        "filePath": "src/auth.ts",
        "content": "export function authenticate() {}",
        "language": "typescript",
        "symbolKind": "function",
        "startLine": 1,
        "endLine": 1,
        "hash": "hash-1"
      },
      "score": 0.98,
      "source": "semantic"
    }
  ]
}
```

## `grep_search`

設定済み project directory を起点にした ripgrep ベースの exact text search です。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | grep engine へ渡す text または regex pattern |
| `filePattern` | string | no | 任意の file glob filter |
| `caseSensitive` | boolean | no | case-sensitive match を有効化 |
| `maxResults` | positive integer | no | 返す最大 match 数 |

### レスポンス

```json
{
  "matches": [
    {
      "filePath": "src/auth.ts",
      "lineNumber": 1,
      "lineText": "export function authenticate() {}",
      "submatches": [
        {
          "start": 16,
          "end": 28,
          "match": "authenticate"
        }
      ]
    }
  ]
}
```

## `hybrid_search`

semantic search と grep search を統合した ranking search です。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | ranking の主クエリ |
| `topK` | positive integer | no | 返す最大件数 |
| `filePattern` | string | no | 任意の file glob filter |
| `language` | string | no | 任意の言語 filter |
| `grepPattern` | string | no | ranking に混ぜる exact-match 用クエリ |

### レスポンス

```json
{
  "query": "authenticate token",
  "results": [
    {
      "chunk": {
        "filePath": "src/auth.ts"
      },
      "score": 1,
      "source": "hybrid",
      "rank": 1,
      "reciprocalRankScore": 0.03278688524590164
    }
  ],
  "tookMs": 4
}
```

## `get_context`

指定した行範囲の file content を返します。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | project-relative file path |
| `symbolName` | string | no | 将来拡張用の予約項目 |
| `startLine` | positive integer | no | file bounds に clamp される開始行 |
| `endLine` | positive integer | no | file bounds に clamp される終了行 |

### 挙動

- path は server-side path sanitizer を通して解決されます。
- `startLine` または `endLine` を省略した場合はファイル全体を返します。
- 解決後の開始行が終了行を上回る場合はエラーになります。

### レスポンス

```json
{
  "filePath": "src/auth.ts",
  "content": "export function authenticate() {}",
  "startLine": 1,
  "endLine": 1
}
```

## `index_status`

現在の metadata、vector、plugin health 情報を返します。

### 引数

このツールは空オブジェクトを受け取ります。

### レスポンス

```json
{
  "indexStats": {
    "id": "primary",
    "totalFiles": 1,
    "totalChunks": 1,
    "lastIndexedAt": "2026-04-07T00:00:00.000Z",
    "lastFullScanAt": null,
    "overflowCount": 0
  },
  "vectorStats": {
    "totalChunks": 1,
    "totalFiles": 1,
    "dimensions": 64,
    "fragmentationRatio": 0,
    "lastCompactedAt": null
  },
  "skippedFiles": 0,
  "pluginHealth": {
    "languages": {
      "registered": [
        "typescript",
        "python",
        "go"
      ],
      "healthy": true
    },
    "embeddings": {
      "provider": "ollama",
      "healthy": true
    },
    "healthy": true,
    "isOperational": true
  }
}
```

## `reindex`

indexing pipeline を通じて manual reindex を実行します。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `fullRebuild` | boolean | no | incremental pass ではなく full rebuild を要求 |

### レスポンス

成功時のレスポンス形状は pipeline の reindex result に従います。
すでに reindex が実行中の場合は、次を返します。

```json
{
  "status": "already_running"
}
```

- `1 MB` を超える request body は HTTP transport 層で reject されます。

## stdio-only クライアント向け HTTP Bridge

stdio 接続のみに対応した MCP クライアント（OpenCode など）から、Nexus HTTP サーバーに接続するには、`nexus http-bridge` を中継として使います。Bridge は独立したローカルプロセスとして起動し、標準入出力の JSON-RPC を Nexus の Streamable HTTP エンドポイントに転送します。

### 使い方

基本的な接続は引数なしで実行できます。

```bash
nexus http-bridge
```

同じプロジェクトに対しては常に 1 つの Nexus HTTP サーバーが共有されます。初回の Bridge 接続時にまだ HTTP サーバーが起動していなければ、OS 割当のループバックポートで自動起動します。全 MCP クライアントが切断すると、HTTP サーバーは自動的に停止し、プロジェクトの `endpoint.json` 記述子も削除されます。

managed server の descriptor は `<storage.rootDir>/endpoint.json` に保存され、`instanceId`（起動ごとのランダム UUID）、`pid`、`projectRoot`、`url` を含みます。コネクターは、descriptor の `projectRoot` 一致、`url` が `127.0.0.1`（ループバック）であること、`pid` の生存、`GET /health` が同一 `instanceId`/`projectRoot` を返すこと、というすべての条件で健全性を判定し、いずれかを満たさない場合は descriptor を削除して再起動候補とします。`127.0.0.1` 以外を指す URL は健全とは判定されないため、本機能はループバックのみを対象とし、ネットワーク公開や systemd 等の外部プロセス管理には依存しません。

同一プロジェクトに対して複数の MCP クライアントが同時に接続できます。各クライアントは独立した MCP セッションを持ちますが、SQLite・LanceDB・File Watcher は 1 つの managed server プロセスに集約されます。アクティブなクライアントが 0 になると、managed server は runtime を閉じて descriptor とプロセスロックを削除し終了します（`--idle-shutdown-ms` / `NEXUS_IDLE_SHUTDOWN_MS` で遅延を調整可能、デフォルト `0`）。起動後 30 秒以内にクライアントが 1 つも接続しない場合も同様に自動終了します。

> **トラブルシューティング**: `nexus http-bridge` 自体も、descriptor が既定のタイムアウト（30 秒）以内に健全な状態で公開されない場合、原因を標準エラー出力（stderr）に書き込んで異常終了します。接続がハングする場合は、stderr のログを確認してください。

### プロジェクトルートの指定

managed server の descriptor 保存先やロック名はプロジェクトルートから導出されます。カレントディレクトリ以外を対象にする場合は `--project-root <path>` 引数または `NEXUS_PROJECT_ROOT` 環境変数を指定してください。

```bash
nexus http-bridge --project-root /path/to/project
```

### URL の指定方法

明示的に外部サービスへ中継したい場合は、`--url` 引数または `NEXUS_BRIDGE_URL` 環境変数で上書きできます。

```text
--url > NEXUS_BRIDGE_URL
```

```bash
# 環境変数で指定
NEXUS_BRIDGE_URL=http://127.0.0.1:4000/mcp nexus http-bridge

# CLI 引数で指定（最優先）
nexus http-bridge --url http://127.0.0.1:4000/mcp
```

### OpenCode 設定例

```json
{
  "mcpServers": {
    "nexus": {
      "command": "nexus",
      "args": ["http-bridge"]
    }
  }
}
```

> **注意**: 引数なしの Bridge は必要に応じて Nexus HTTP サーバーを自動起動・停止します。Bridge の診断メッセージはすべて stderr に出力されるため、stdout は MCP クライアントとのプロトコル通信に専有されます。
