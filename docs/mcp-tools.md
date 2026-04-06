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

## Transport 補足

- Nexus は通常 `createStreamableHttpHandler()` を通じて公開します。
- MCP session は session ID 単位で追跡され、idle timeout 後に cleanup されます。
- `1 MB` を超える request body は HTTP transport 層で reject されます。
