# Nexus HTTP／MCP v2 移行 設計書

## 1. 文書情報

| 項目 | 内容 |
|---|---|
| 文書名 | Nexus HTTP／MCP v2 移行 設計書 |
| 対象システム | `yohi/nexus` |
| 対象プロトコル | Model Context Protocol `2026-07-28` |
| 設計対象 | Phase 1（内部構造分離）+ Phase 2（MCP SDK v2 移行） |
| 設計日 | 2026年8月7日 |
| 関連要件 | `REQUIREMENTS.md`「Nexus HTTP／MCP v2移行 要件定義書」 |

## 2. 背景と目的

Nexus はローカル MCP サーバーとして AST チャンキング、ベクトル検索、ripgrep 検索、ファイルコンテキスト取得を提供している。現行実装は SDK v1（`@modelcontextprotocol/sdk`）を使用した stdio 接続中心であり、Streamable HTTP はセッション Map + `Mcp-Session-Id` を前提としている。

本設計では、MCP プロトコル `2026-07-28` に準拠した SDK v2 ベースの HTTP サーバー（`nexus serve`）を新規に追加する。**既存の `nexus`（stdio）と `nexus http-bridge` は v1 のまま維持**し、Cloud モード（Sync Agent、Cloudflare Workers 等）は本設計の範囲外とする。

## 3. 設計対象（スコープ）

本設計書がカバーする範囲は、要件定義書 §19 にある **Phase 1 と Phase 2** である。

### 3.1 含む範囲

- Phase 1a: ツールハンドラと Transport の分離、SDK 中立スキーマの導入
- Phase 1b: MetadataStore / VectorStore インターフェースの整理、ContentStore の新設
- Phase 2a: MCP SDK v2 への移行、`Mcp-Session-Id` およびセッション Map の廃止
- Phase 2b: `/mcp` エンドポイント、`server/discover`、ヘッダー検証、`/health`・`/ready` の実装
- Phase 2c: 新規 `nexus serve` サブコマンド（loopback デフォルト、非 loopback host 指定時は fail-closed）

### 3.2 含まない範囲（将来の設計に委譲）

- Phase 3: Local HTTP v2 の完全機能化（`--allow-network`、認証、http-bridge lease + heartbeat）
- Phase 4: Sync Agent
- Phase 5: Cloud Storage Adapter（D1 / Vectorize / R2 / S3 / Supabase 等）
- Phase 6: Cloud MCP Worker / Cloudflare デプロイ
- Phase 7: 正式移行と stdio の Legacy 明示化

なお、Phase 2 の `nexus serve` は `--allow-network` および認証を含まないため、loopback インターフェース以外での bind は起動時に拒否する。`--host 127.0.0.1`（または `--host localhost` などの loopback）のみ許可する。`--allow-network` 自体は Phase 3 で導入する。

## 4. 確定した設計判断

以下は設計時に対話で確定させた決定事項である。

| # | 決定事項 | 理由 |
|---|---|---|
| 1 | **stdio は SDK v1 のまま維持** | 最も利用されている経路の回帰リスクをゼロにする。v2 は新規 `serve` に閉じ込める。 |
| 2 | **Phase 1 は必要最小限の抽象化 + ContentStore 新設** | 既存 `IMetadataStore` / `IVectorStore` を整理し、`ContentStore` を新設して `loadFileContent` を包摂。Sync Queue Store 等の Cloud 専用 I/F は後工程。 |
| 3 | **http-bridge は現行 v1 のまま据え置き** | 既存 UX を維持し、v2 化は新 `serve` に委ねる。管理方式は lease + heartbeat を将来導入。 |
| 4 | **スキーマは SDK 中立で定義し、アダプタで変換** | zod v4 移行を局所化。v1 アダプタで zod v3、v2 アダプタで zod v4 へ変換する。 |
| 5 | **実装はボトムアップ段階移行（Phase 1a → 1b → 2a → 2b）** | 各段階でテストが通る中間状態を確保し、失敗時の切り戻しを容易にする。 |

### 4.1 移行対象の整理

| 経路 | 使用パッケージ | `/mcp` 接続先 | 移行フェーズ | 備考 |
|---|---|---|---|---|
| Legacy stdio | `@modelcontextprotocol/sdk` v1 | 該当なし | 変更なし | 最も利用されている経路の回帰リスクをゼロにする |
| `nexus http-bridge` | `@modelcontextprotocol/sdk` v1 | 既存 managed HTTP server `/mcp` | 変更なし | 既存 UX を維持。v2 化は新 `serve` に委ねる |
| `nexus serve` | `@modelcontextprotocol/server` v2 | SDK v2 `createMcpHandler` `/mcp` | Phase 2 | 新規 loopback HTTP 経路 |

## 5. 前提となる検証済み事実

外部ドキュメント調査により以下が確認されている。

1. **MCP SDK v2 のパッケージ**: `@modelcontextprotocol/server@2.0.0`、`@modelcontextprotocol/node@2.0.0`、`@modelcontextprotocol/core@2.0.0`。v1 の `@modelcontextprotocol/sdk` は置き換えられる。Source: [v2 package layout](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.html)
2. **プロトコル `2026-07-28` は現行**であり、`Mcp-Session-Id` とプロトコルセッションを削除、`server/discover` を追加する。Source: [official changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9d4a9115126f1356f4b189af3266c1839a4e9bbb/docs/specification/2026-07-28/changelog.mdx)
3. **ステートレスハンドラー**: `createMcpHandler(factory)`（`@modelcontextprotocol/server`）がリクエストごとに新しいサーバーを生成する web-standard handler を返す。Node では `toNodeHandler()` を使用。Source: [SDK HTTP guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)
4. **自動検証**: `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` / `Mcp-Param-*` は SDK v2 側で自動検証する。Source: [SDK handler validation](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/packages/server/src/server/createMcpHandler.ts#L604-L615)
5. **Origin / Host 検証はアプリ側の責務**: SDK ファクトリは DNS Rebinding 対策を行わない。Source: [SDK HTTP guide security](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html#validate-host-and-origin-in-front-of-it)
6. **Cloudflare wrapper は同名だが別物**: `agents/mcp/server` の `createMcpHandler` は SDK v2 `McpServer` を受け入れる Cloudflare 独自ラッパー。設計書では区別する。Source: [Cloudflare handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
7. **Zod v4 必須**: SDK v2 は zod v3 をサポートしない。Source: [v1→v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/cc4b41617ce3601b1290d67216ea0b194a3cd9ac/docs/migration/upgrade-to-v2.md#L155-L181)

## 6. アーキテクチャ

```text
                          ┌──────────────────────┐
                          │      MCP Client      │
                          └──────────┬───────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
           ┌────────▼────────┐              ┌─────────▼────────┐
            Legacy stdio      │              │ Local HTTP v2    │
            SDK v1            │              │ nexus serve      │
            (維持)            │              │ SDK v2           │
           └────────┬────────┘              └─────────┬────────┘
                    │                                 │
                    └─────────────┬───────────────────┘
                                  ▼
                   Tool Registration Layer（SDK 中立）
                                  │
                                  ▼
                        Application Services
                        （既存 execute* を維持）
                                  │
                                  ▼
                   Storage Interfaces
                   MetadataStore / VectorStore / ContentStore
                                  │
                                  ▼
                   Storage Adapters
                   SQLite / LanceDB / Local FS
```

### 6.1 主要な設計判断

- **SDK v1 / v2 共存**: `package.json` に両方を併存させる。import は層ごとに厳格に分離する。
- **ツール登録の抽象化**: ツール定義を SDK 非依存の中立 DSL で保持し、v1 / v2 用アダプタでそれぞれの SDK へ変換する。
- **共有リソースのクロージャ注入**: `createMcpHandler` はリクエストごとに `McpServer` を生成するが、SQLite / LanceDB / Watcher / Embedding Provider は serve プロセス起動時に1つ構築し、ファクトリクロージャで共有する。これにより要件 §4.1「MCP クライアント接続単位で SQLite 等を生成しない」を満たす。
- **Origin/Host 検証の自前実装**: SDK v2 側が行わないため、`serve` 側に薄いミドルウェアを挟む。

#### Local HTTP v2 の local-only 契約

Local HTTP v2 では、ソースコード・インデックス・Embedding 処理を一切外部に送信しない。これを保証するため:

- `storage-profile: local`（または専用の local-only 設定）では、外部 Embedding Provider（`openai-compat` / `bedrock` 等）を `loadConfig` 時に拒否し、fail-fast とする。
- ローカル実装（`LocalContentStore` / SQLite / LanceDB / `ollama` 等のローカル Embedding）が強制される。
- 外部ネットワーク接続なしで `index` / `search` / `get_context` が成功することを検証するテストを追加する。
- remote provider 設定（`openai-compat` / `bedrock`）が local-only モードで拒否されることを検証するテストを追加する。

Package Mode（`NEXUS_PACKAGE_MODE=1`）は既存の bedrock 固定動作を維持するが、Local HTTP v2 の local-only 契約とは区別して扱う。

## 7. モジュール分割

### 7.1 新設: `src/server/tools/registry/`（Phase 1a）

```text
src/server/tools/registry/
  ├── definitions.ts        # 6ツールのメタデータ（名前、説明、パラメータ定義）
  ├── schemas-neutral.ts    # SDK 中立スキーマ DSL
  └── adapters/
      ├── v1-adapter.ts     # zod v3 変換 + 既存 McpServer.registerTool へ登録
      └── v2-adapter.ts     # zod v4 変換 + SDK v2 registerTool へ登録
```

**中立 DSL**: JSON Schema ベースの素朴なオブジェクト。サポート型は `string / integer / number / boolean / string[] / enum` の6種に限定する。値域クランプ等のビジネスルールは既存 `execute*` 側に残し、アダプタには持ち込まない。

### 7.2 新設: `src/server/http-v2/`（Phase 2）

```text
src/server/http-v2/
  ├── server-factory.ts     # createMcpHandler ベースの v2 サーバー生成
  ├── transport.ts          # Node.js HTTP ↔ Web Standard 変換（toNodeHandler）
  ├── headers.ts            # Origin/Host 検証、セキュリティヘッダー
  ├── routes.ts             # /mcp, /health, /ready ルーティング
  └── entry.ts              # nexus serve コマンドのエントリーポイント
```

### 7.3 変更: `src/storage/`（Phase 1b）

```text
src/storage/
  ├── interfaces/
  │   ├── metadata-store.ts   # 既存 IMetadataStore の移設・整理
  │   ├── vector-store.ts     # 既存 IVectorStore の移設・整理
  │   └── content-store.ts    # 新設
  ├── local/
  │   ├── sqlite-metadata-store.ts
  │   ├── lancedb-vector-store.ts
  │   └── local-content-store.ts  # 新設
  └── batched-transaction.ts
```

**ContentStore インターフェース（新設）**:

```typescript
interface ContentStore {
  put(contentHash: string, content: Uint8Array): Promise<void>;
  get(contentHash: string): Promise<Uint8Array | null>;
  delete(contentHash: string): Promise<void>;
  exists(contentHash: string): Promise<boolean>;
  readRange(path: string, startLine: number, endLine: number): Promise<string>;
}
```

Phase 2 では `LocalContentStore` のみ実装。
`get_context` 等は `loadFileContent` の代わりに `ContentStore.readRange(path, startLine, endLine)` 経由に切り替える。
`readRange` は PathSanitizer 検証後、必要に応じて Merkle Tree（`MetadataStore`）で `path` → `contentHash` を解決し、`get` でバイト列を取得して行範囲を抽出する。
`put/delete` は Phase 4（Sync Agent）まで未実装としてもよい（Local 検索では読み取り専用で足りる）。

### 7.4 変更: `src/bin/`（Phase 2）

```text
src/bin/
  ├── nexus.ts              # serve サブコマンド判定のみ追加
  ├── commands/
  │   └── serve.ts          # 新設：nexus serve の実装
  └── http-bridge.ts        # 変更なし
```

`nexus.ts` は `serve` というサブコマンドを検知した場合のみ `commands/serve.ts` を動的インポートする。既存 stdio / HTTP ロジックには触れない。

### 7.5 依存方向ルール

```text
Transport (stdio / v1-http / v2-http)
    ↓
Tool Registry adapters
    ↓
Tool Handlers / Search Orchestrator
    ↓
Storage Interfaces
    ↓
Storage Adapters
```

禁止事項:

- Transport 層から Storage Adapter 層への直接 import
- `v2-adapter.ts` および `server-factory.ts` 以外での `@modelcontextprotocol/server` import
- `entry.ts` 以外での `toNodeHandler` 使用

責務:

- `server-factory.ts` は `@modelcontextprotocol/server` から `createMcpHandler` を import し、ファクトリ関数を組み立てる。
- `v2-adapter.ts` は `server-factory.ts` から渡された `McpServer`（v2）インスタンスにツールを登録する。
- `transport.ts` は `toNodeHandler()` の変換のみを責務とし、`entry.ts` から呼び出される。`entry.ts` 以外からの使用は禁止する。
- 上記を除く `@modelcontextprotocol/server` / `toNodeHandler` の使用は、設計書の改訂なしには追加しない。

## 8. データフロー

### 8.1 `nexus serve` リクエストライフサイクル

```text
起動時（1回のみ）:
  nexus serve --port 9200
    → loadConfig()
    → NexusRuntime 構築（SQLite / LanceDB / Watcher / Pipeline を1つだけ生成）
    → runtime.initialize()（既存 stdio と同じ遅延初期化パターン）
    → createMcpHandler(factory, { legacy: "reject" }) を構築（2025-era リクエストは拒否）
    → /health, /ready ルート登録
    → 127.0.0.1:9200 で listen

`createMcpHandler` の `legacy` オプションは `"accept"` / `"reject"` を取る。Phase 2 では `2026-07-28` のみをサポートするため `"reject"` とし、2025-era のリクエストは SDK 側で 400 または 406 を返す。将来両世代を受け付ける場合は、`legacy: "accept"` に変更し、リクエストの `MCP-Protocol-Version` ヘッダーに応じて v1 / v2 のハンドラを切り替えるルーティング方針を別途設計する。
リクエストごと（POST /mcp）:
  1. headers.ts: Origin / Host 検証 → 失敗時 403
  2. createMcpHandler: Content-Type / Accept / MCP-Protocol-Version /
                      Mcp-Method / Mcp-Name 自動検証 → 失敗時 400
  3. factory: 新しい McpServer(v2) を生成。ツール登録は v2-adapter 経由。
              共有 Runtime はクロージャ参照。
  4. ツールハンドラ実行 → Storage Interfaces 経由で SQLite/LanceDB/ContentStore へ
  5. structuredContent に結果を格納して返却

シャットダウン:
  SIGINT/SIGTERM → HTTP server close → runtime.close()
```

### 8.2 スキーマ変換フロー

```text
schemas-neutral.ts（SDK 非依存）
       │
       ├─ v1-adapter.ts → zod v3 → 既存 McpServer.registerTool
       │
       └─ v2-adapter.ts → zod v4 → SDK v2 registerTool
```

### 8.3 ContentStore 導入フロー

```text
現状:
  get_context / hybrid_search snippet
    → loadFileContent(filePath)

Phase 1b 以降:
  同ハンドラ
    → ContentStore.readRange(path, startLine, endLine)
         └─ LocalContentStore
              → PathSanitizer 検証後に FS 読み出し
```

## 9. エラーハンドリング

### 9.1 3層の責務分離

| 層 | 責務 | 例 |
|---|---|---|
| Layer 1: HTTP 層 | トランスポート・プロトコル検証 | 403（Origin/Host 不正）、400（ヘッダ不一致）、413（サイズ超過）、404（/mcp 以外）、503（ready 未） |
| Layer 2: ツール実行層 | MCP レスポンス内のエラー表現 | `isError: true` + `structuredContent.error.code` |
| Layer 3: 内部ログ | 詳細情報の出力 | `console.error` のみ。MCP レスポンスには含めない |

### 9.2 エラーコード（§17 準拠、段階的）

```typescript
type NexusErrorCode =
  | "NEXUS_STORAGE_UNAVAILABLE"
  | "NEXUS_VECTOR_DIMENSION_MISMATCH"
  | "NEXUS_CONTENT_NOT_FOUND"
  | "NEXUS_INDEXING_IN_PROGRESS"
  // 以下は Phase 3〜5 で実装
  | "NEXUS_AUTH_REQUIRED"
  | "NEXUS_ACCESS_DENIED"
  | "NEXUS_WORKSPACE_NOT_FOUND"
  | "NEXUS_REVISION_NOT_READY"
  // 以下は Phase 4/5（Sync Agent / Cloud）で実装
  | "NEXUS_SYNC_OUT_OF_ORDER"
  | "NEXUS_SYNC_RECONCILE_REQUIRED"
  | "NEXUS_RATE_LIMITED";
```

実装済み機能で到達可能なコードのみを Phase 1+2 で発火させる。到達不能なコードは型定義のみ。

### 9.3 v1/v2 間のエラー互換（§15.3）

- v1 側: 既存 `errorResult()` を一切変更しない。
- v2 側: 同じ `errorResult()` を再利用し、`structuredContent.error.code` を追加するのみ（既存フィールドの削除・改名なし）。
- 内部スタックトレースは `console.error` のみ。MCP レスポンスには含めない（既存 `sanitizeErrorMessage` を v2 アダプタからも経由）。

### 9.4 `/ready` の応答

```text
GET /ready
  → SQLite / LanceDB / Watcher / Pipeline の状態確認
  → 未初期化 or 接続失敗 → 503 { status: "not_ready", reason: "NEXUS_STORAGE_UNAVAILABLE" }
  → 正常              → 200 { status: "ready" }
```

## 10. テスト戦略

### 10.1 基本方針

- **v1 経路のテストは1件も変更しない**。全件パスをもって後方互換性を証明する。
- v2 経路は、schema-parity と結果集合一致で差分を担保する。

### 10.2 新規テスト

| 種別 | 内容 | 配置 |
|---|---|---|
| 単体 | 中立スキーマ → zod v3 / v4 変換の正当性 | `tests/unit/server/tools/registry/` |
| 単体 | v1/v2 スキーマ等価性（同一入力の accept/reject 一致） | 同上 |
| 単体 | Origin/Host 検証ミドルウェア | `tests/unit/server/http-v2/` |
| 単体 | `/health` `/ready` の各応答 | 同上 |
| 統合 | 実ポートで listen した `nexus serve` への Streamable HTTP 接続 | `tests/integration/http-v2/` |
| 統合 | `tools/list` で6ツールが v1 と同一で返る | 同上 |
| 統合 | `tools/call hybrid_search` で v1 と同一結果集合が返る | 同上 |
| 統合 | 不正ヘッダーで 400 HeaderMismatch | 同上 |
| 統合 | `/mcp` 以外への POST で 404 | 同上 |
| 統合 | レスポンスに `Mcp-Session-Id` が含まれないこと | 同上 |
| E2E | `npx tsx` または `node dist/bin/nexus.js serve` を実プロセス起動し SDK v2 クライアントで接続 | `tests/e2e/`（`NEXUS_E2E=1` ゲート） |
| 統合 | 非 loopback host（`0.0.0.0` 等）指定で `nexus serve` が起動失敗すること | `tests/integration/http-v2/` |
| 統合 | loopback host（`127.0.0.1` / `localhost`）指定で `nexus serve` が正常起動すること | 同上 |
| 統合 | local-only 設定で外部 Embedding Provider（`openai-compat` / `bedrock`）が拒否されること | `tests/integration/config/` |
| 統合 | 外部ネットワークなしで `index` / `search` / `get_context` が成功すること | `tests/integration/http-v2/` |

### 10.3 リソース制御の追加

v2 経路でのみ `maxResults` / `topK` に上限を設ける。v1 経路（`src/server/index.ts`、既存 `nexus` / `nexus http-bridge`）の入力契約は変更せず、`topK` / `maxResults` は引き続き任意の正の整数を受け付ける。v2 経路は中立 DSL に追加した `maximum` を zod v4 の `.max()` に落とし、初期上限を `topK ≤ 100`、`maxResults ≤ 1000` とする。`.nexus.json` または環境変数で上書き可能にする。既存クライアントの無指定動作は不変。

実装方針: v2 アダプタ（`v2-adapter.ts`）でスキーマ変換時に `.max()` を適用する。実行層（`execute*`）は引き続き値域クランプを行わず、入力検証層で拒否する。

## 11. Phase 3 以降への接続点

Phase 2 の実装は、Phase 3 以降を見据えた構造にする。

| 将来機能 | Phase 2 で確保する接続点 |
|---|---|
| http-bridge lease + heartbeat | Phase 3 で設計。Phase 2 では serve の起動・停止フックを1箇所に集約し、将来的に外部 lease エンドポイントを受け入れ可能にしておく |
| `--allow-network` + 認証 | `serve.ts` に認証ミドルウェアを差し込むインターフェースを準備（Phase 2 では未使用） |
| `.nexus.json` の `transport` 設定 | `loadConfig` 側で読み込み可能な型を拡張（Phase 2 では CLI 引数を優先し、未指定時は `.nexus.json` / 環境変数 / デフォルトを参照）。`NEXUS_HTTP_*` 系環境変数も Phase 2 からサポートする。 |
| Cloud Storage Adapter | `src/storage/interfaces/` に D1 / Vectorize / R2 受け入れ可能な形状を整備 |
| ワークスペース・テナント概念 | 既存 `projectRoot` を `workspace_id` にマッピングする箇所を1箇所に集約しておく |

## 12. 後方互換性と受入基準対応

| 受入基準 | 本設計での対応 |
|---|---|
| §20.1 MCP v2 `/mcp` 接続 | Phase 2a/b で実装 |
| §20.1 `Mcp-Session-Id` 不使用・セッション Map 不在 | `createMcpHandler` の使用 + テストでレスポンスヘッダー確認 |
| §20.1 `server/discover` 成功 | SDK v2 `createMcpHandler` 標準の挙動。server identity は `_meta["io.modelcontextprotocol/serverInfo"]`（`SERVER_INFO_META_KEY`）に返却され、`McpServer` コンストラクタの `name` / `version` が使用される。レスポンス例を 12.1 に記載。 |
| §20.1 必要ヘッダー検証 | SDK v2 自動 + Origin/Host 自前 |
| §20.2 従来 `nexus` stdio 利用 | 変更なし、既存テスト全件パスで担保 |
| §20.2 `nexus http-bridge` 利用 | 変更なし |
| §20.2 既存 Tool 利用 | v1 アダプタ経由で既存パスを維持 |
| §20.4 Local HTTP loopback デフォルト | `serve` は `127.0.0.1` のみ bind |
| §20.4 外部ネットワーク不要 | LocalContentStore / SQLite / LanceDB のみ使用 |
| §16.5 `topK` 上限 | Phase 2 で追加 |

### 12.1 `server/discover` レスポンス例

SDK v2 `createMcpHandler` により、`McpServer({ name: "nexus", version: "0.1.0" })` で構築した場合、以下のようなレスポンスが返る。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2026-07-28",
    "capabilities": {
      "tools": { "listChanged": true }
    },
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "nexus",
        "version": "0.1.0"
      }
    }
  }
}
```

なお、`serverInfo` のカスタマイズは SDK v2 の `McpServer` コンストラクタ引数で行う。`createMcpHandler` 側で独自の `serverInfo` を注入するわけではない。

## 13. リスクと前提

- **zod v3/v4 共存**: 中立 DSL 導入によりアダプタ層に閉じ込めるが、変換器のバグが v1/v2 間の入力判定差異を生む可能性がある。schema-parity テストで検出する。
- **SDK v2 の未踏挙動**: `createMcpHandler` の内部実装やエラーコードはまだ運用実績が少ない。E2E テストで早めに炙り出す。
- **ブランチ戦略**: 本変更は `master` からの feature ブランチで実施。v1 経路を変更しないため、段階的に master へマージ可能。

---

## 参考資料

- REQUIREMENTS.md: `Nexus HTTP／MCP v2移行 要件定義書`
- [MCP TypeScript SDK v2 packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages.html)
- [MCP 2026-07-28 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/9d4a9115126f1356f4b189af3266c1839a4e9bbb/docs/specification/2026-07-28/changelog.mdx)
- [MCP SDK v2 HTTP guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)
- [Cloudflare MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
