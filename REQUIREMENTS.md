# Nexus HTTP／MCP v2移行 要件定義書

## 1. 文書情報

| 項目       | 内容                                  |
| -------- | ----------------------------------- |
| 文書名      | Nexus HTTP／MCP v2移行 要件定義書           |
| 対象システム   | `yohi/nexus`                        |
| 文書バージョン  | 1.0                                 |
| 作成日      | 2026年8月7日                           |
| 対象プロトコル  | Model Context Protocol `2026-07-28` |
| 主対象パッケージ | `@yohi/nexus`                       |
| 基本方針     | 既存ローカル利用を維持しながら、HTTPを標準接続方式へ移行する    |

---

# 2. 背景

Nexusは、AIエージェントがコードベースを検索・理解するためのMCPサーバーであり、以下の機能を持つ。

* ASTベースのコードチャンク生成
* Embeddingによるセマンティック検索
* ripgrepによる文字列・正規表現検索
* RRFによるハイブリッド検索
* ファイルコンテキスト取得
* File Watcherによる自動インデックス更新
* SQLiteによるメタデータ・キャッシュ管理
* LanceDBによるベクトル管理
* stdioおよびStreamable HTTPによるMCP接続

現行実装は、ローカルコードベースと同一マシン上で実行され、SQLite、LanceDB、File Watcherなどのランタイム資源を単一プロセス内で共有する構成である。

一方、今後は以下を実現する必要がある。

1. MCP接続方式を、`npx`によるstdio中心の利用からMCP v2 HTTP中心へ移行する。
2. 複数のAIエージェントから同一のNexusへHTTP接続できるようにする。
3. Cloudflare MCP Portalなどから管理可能なリモートMCPサーバーとして提供する。
4. 未commit、未stage、untrackedを含む最新のローカル作業ツリーを検索対象にする。
5. 業務・機密コードでは、データを外部へ送らない完全ローカル構成を選択可能にする。
6. 現在のstdio、npx、SQLite、LanceDBを利用する方法はレガシー互換として維持する。

---

# 3. 目的

本開発の目的は、Nexusを以下の3つの実行モードに対応させることである。

## 3.1 Legacy Localモード

現在の利用方法を維持する。

```bash
npx @yohi/nexus
```

または、インストール済みCLIを使用する。

```bash
nexus
```

接続方式はstdio、保存先はローカルSQLiteおよびLanceDBとする。

## 3.2 Local HTTP v2モード

Nexus MCP HTTPサーバーを、対象リポジトリと同一のローカルマシン上で実行する。

```bash
nexus serve \
  --transport streamable-http \
  --host 127.0.0.1 \
  --port 9200 \
  --path /mcp
```

業務・機密情報など、ソースコードやインデックスを外部サービスへ送信できない環境で使用する。

## 3.3 Cloud HTTP v2モード

MCPサーバーおよび検索用インデックスをクラウドで提供する。

ローカルマシンには、MCPサーバーではなく作業ツリー同期用の軽量なSync Agentを配置する。

```bash
nexus sync \
  --project-root /path/to/project \
  --workspace my-workstation
```

Sync Agentは、保存済みの未commit、未stage、staged、untrackedファイルをクラウドへ同期する。

---

# 4. MUST要件

## 4.1 MCP v2 HTTPへの移行

Nexusは、MCP `2026-07-28`に準拠したStreamable HTTPサーバーを提供しなければならない。

HTTPエンドポイントは以下とする。

```text
POST /mcp
```

必要に応じてStreamable HTTPの仕様に従ったGETまたはストリーミング応答を提供する。

MCP `2026-07-28`ではプロトコルレベルのセッションと`Mcp-Session-Id`が削除され、サーバーは通常のHTTPインフラ上でステートレスに処理できる設計となっている。

NexusのHTTP v2実装は、以下を満たさなければならない。

* `Mcp-Session-Id`を使用しない。
* MCPセッションMapを保持しない。
* `initialize`を前提としたサーバー生成を行わない。
* MCPクライアント接続単位でSQLite、Watcher、Vector Storeを生成しない。
* 1回のHTTPリクエストを自己完結的に処理する。
* 必要な状態は、明示的な`workspace_id`、`revision`、`job_id`などで識別する。
* `MCP-Protocol-Version`を検証する。
* `Mcp-Method`および必要な場合は`Mcp-Name`を検証する。
* `server/discover`に対応する。
* MCP SDK v2の公式サーバーパッケージを使用する。

TypeScript実装は、現在の`@modelcontextprotocol/sdk` v1系から、SDK v2の`@modelcontextprotocol/server`を中心とした構成へ移行する。SDK v2で`2026-07-28`を利用する場合は、対応プロトコルを明示的に有効化する。

## 4.2 既存利用方法の維持

以下の既存利用方法は削除してはならない。

```bash
nexus
npx @yohi/nexus
nexus http-bridge
nexus --reindex
nexus --reindex --full
nexus dashboard
nexus-aggregator
```

既存の以下の設定も継続して利用可能でなければならない。

* `.nexus.json`
* `NEXUS_STORAGE_ROOT_DIR`
* `NEXUS_PROJECT_ROOT`
* `NEXUS_WATCHER_IGNORE_PATHS`
* Embedding関連環境変数
* Package Mode
* MetricsおよびAggregator関連設定

現行CLIは、引数なしの場合にstdio MCPとして起動し、SQLite、LanceDB、File Watcherなどの重い初期化をMCP接続後に行う。HTTP Bridgeはstdio-onlyクライアントからHTTP Nexusへ接続する役割を持つ。

## 4.3 未commit情報の取得

Cloud HTTP v2モードでも、以下を検索対象に含めなければならない。

* HEADに含まれるファイル
* staged変更
* unstaged変更
* untrackedファイル
* renameされたファイル
* 削除されたファイル
* ブランチ切り替え後の作業ツリー
* rebase、reset、merge後の作業ツリー

通常検索のデフォルト対象は、GitHub上の最新commitではなく、選択されたワークスペースの最新`working-tree`とする。

対象は、ローカルファイルシステムへ保存済みのファイルとする。

エディタ上だけに存在し、まだファイルシステムへ保存されていない編集内容は、本要件の対象外とする。未保存バッファまで取得する場合は、将来のIDE拡張機能として別途定義する。

## 4.4 完全ローカル運用

業務・機密情報を扱う環境では、以下を満たすLocal HTTP v2モードを提供しなければならない。

* ソースコードを外部へ送信しない。
* インデックスを外部へ送信しない。
* SQLiteおよびLanceDBをローカルに保存する。
* File Watcher、AST解析、ripgrepをローカルで実行する。
* MCP HTTPサーバーを対象リポジトリへアクセス可能なローカルマシン上で実行する。
* デフォルトでは`127.0.0.1`のみで待ち受ける。
* 外部ネットワーク接続を必須にしない。
* ローカルEmbeddingプロバイダーを選択可能にする。
* Cloudflare、SaaS DB、外部Vector DBを利用しなくても全機能が動作する。

---

# 5. システム構成

## 5.1 全体構成

```text
                         ┌──────────────────────┐
                         │      MCP Client      │
                         │ Claude / Gemini /    │
                         │ OpenCode / Agents    │
                         └──────────┬───────────┘
                                    │
                         MCP v2 Streamable HTTP
                                    │
                 ┌──────────────────┴──────────────────┐
                 │                                     │
                 ▼                                     ▼
       Local HTTP v2モード                  Cloud HTTP v2モード
 ┌──────────────────────────┐       ┌──────────────────────────┐
 │ ローカル Nexus Server    │       │ Cloud Nexus MCP Server   │
 │                          │       │                          │
 │ SQLite                   │       │ Metadata Store           │
 │ LanceDB                  │       │ Vector Store             │
 │ Local Content            │       │ Content Store            │
 │ Watcher / ripgrep        │       └────────────┬─────────────┘
 └────────────┬─────────────┘                    ▲
              │                                  │ HTTPS Sync
              ▼                                  │
      Local Working Tree              ┌──────────┴─────────────┐
                                      │ Nexus Local Sync Agent │
                                      │                        │
                                      │ Watcher / Git status   │
                                      │ AST / Hash / Queue     │
                                      └──────────┬─────────────┘
                                                 │
                                                 ▼
                                         Local Working Tree
```

## 5.2 責務分離

システムは、以下の論理コンポーネントへ分割する。

### MCP Server

* MCP Toolの登録
* Tool入力の検証
* 認証コンテキストの解決
* ワークスペースの解決
* 検索サービスの呼び出し
* MCPレスポンスの生成

### Search Service

* セマンティック検索
* テキスト検索
* RRF統合
* コンテキスト取得
* 検索結果のフィルタリング

### Indexing Service

* ファイル差分検出
* ASTチャンク生成
* Embedding生成
* メタデータ更新
* Vector Store更新
* 削除・rename処理
* DLQ処理

### Sync Agent

* ローカル作業ツリー監視
* Git状態取得
* 差分送信
* オフラインキュー管理
* 再送
* 定期的な整合性検証

### Storage Adapter

* Metadata Store
* Vector Store
* Content Store
* Sync Queue Store

---

# 6. 実行モード

## 6.1 Legacy Local stdio

### 起動方法

```bash
nexus
```

または、

```bash
npx @yohi/nexus
```

### 使用コンポーネント

| 機能             | 実装       |
| -------------- | -------- |
| MCP Transport  | stdio    |
| Metadata Store | SQLite   |
| Vector Store   | LanceDB  |
| Content Store  | ローカルファイル |
| 更新検知           | chokidar |
| Exact Search   | ripgrep  |
| Embedding      | 現行プラグイン  |
| データ送信          | なし       |

### 互換要件

* 現在の起動コマンドを変更しない。
* 現在のTool名を変更しない。
* 現在必須でないTool引数を必須にしない。
* 現在のレスポンス構造を破壊しない。
* `.nexus.json`の既存キーを削除しない。
* 既存環境変数を削除しない。
* `.nexus/`の既存データは、必要なマイグレーション後も利用可能とする。

## 6.2 Local HTTP v2

### 起動方法

```bash
nexus serve
```

完全指定例：

```bash
nexus serve \
  --transport streamable-http \
  --host 127.0.0.1 \
  --port 9200 \
  --path /mcp \
  --storage-profile local
```

### デフォルト値

| 項目              | デフォルト             |
| --------------- | ----------------- |
| transport       | `streamable-http` |
| host            | `127.0.0.1`       |
| port            | OS自動割当または設定値      |
| path            | `/mcp`            |
| storage-profile | `local`           |
| auth            | loopbackでは無効      |
| project-root    | カレントディレクトリ        |

### 要件

* SQLite、LanceDB、Watcher、ripgrepを同一ランタイムで共有する。
* MCPリクエストごとにランタイムを再生成しない。
* MCPプロトコル上はステートレスとする。
* HTTPサーバープロセスのライフサイクルはMCPセッション数に依存させない。
* 常駐起動または明示的な停止まで稼働する。
* `GET /health`を提供する。
* `GET /ready`を提供する。
* `/mcp`以外へ送られたMCPリクエストは404とする。
* REST APIを残す場合は、MCPとは別パスへ明示的に分離する。

### ネットワーク公開

デフォルトではloopback以外へバインドしてはならない。

以下のいずれかを指定した場合のみ、LANまたは外部インターフェースへバインドできる。

```bash
nexus serve --host 192.168.1.20 --allow-network
```

または、

```bash
nexus serve --host 0.0.0.0 --allow-network
```

loopback以外へバインドする場合は、認証を必須とする。

## 6.3 Cloud HTTP v2

### 構成

```text
Cloudflare MCP Portal
        │
        ▼
Nexus MCP Worker / Server
        │
        ├─ Metadata Store
        ├─ Vector Store
        └─ Content Store
        ▲
        │
Nexus Sync Agent
        ▲
        │
Local Working Tree
```

### 参照実装

Cloudflareを使用する場合の参照構成は以下とする。

| 論理ストア          | Cloudflare参照実装            |
| -------------- | ------------------------- |
| MCP Server     | Cloudflare Workers        |
| Metadata Store | D1                        |
| Vector Store   | Vectorize                 |
| Content Store  | R2                        |
| 非同期処理          | Queues                    |
| 認証             | Cloudflare AccessまたはOAuth |
| MCP集約          | Cloudflare MCP Portal     |

Cloudflareの新規MCPサーバーでは、SDK v2のサーバーファクトリからステートレスなStreamable HTTPハンドラーを作る`createMcpHandler()`が推奨されている。

ただし、ビジネスロジックをCloudflare固有APIへ直接依存させてはならない。

D1、Vectorize、R2はStorage Adapterを介して利用する。

将来的に以下へ差し替え可能とする。

* PostgreSQL
* Supabase
* pgvector
* Qdrant
* Turso
* S3互換Object Storage
* 他のコンテナ・サーバーレス基盤

---

# 7. ストレージ要件

## 7.1 抽象化方針

汎用的なSQL実行インターフェースだけではなく、用途別のインターフェースを定義する。

```typescript
interface MetadataStore {
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  getLatestRevision(workspaceId: string): Promise<WorkspaceRevision | null>;
  applySyncBatch(batch: SyncBatch): Promise<ApplySyncResult>;
  searchText(query: TextSearchQuery): Promise<TextSearchResult[]>;
  getIndexStatus(workspaceId: string): Promise<IndexStatus>;
}

interface VectorStore {
  upsert(chunks: EmbeddedChunk[]): Promise<void>;
  delete(chunkIds: string[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
}

interface ContentStore {
  put(contentHash: string, content: Uint8Array): Promise<void>;
  get(contentHash: string): Promise<Uint8Array | null>;
  delete(contentHash: string): Promise<void>;
  exists(contentHash: string): Promise<boolean>;
  readRange(path: string, startLine: number, endLine: number): Promise<string>;
}
```

## 7.2 ローカル実装

| インターフェース      | 実装               |
| ------------- | ---------------- |
| MetadataStore | SQLite           |
| VectorStore   | LanceDB          |
| ContentStore  | ローカル作業ツリー        |
| Queue Store   | SQLiteまたはメモリ＋DLQ |

現行NexusはSQLiteをMerkle状態、統計、Embeddingキャッシュなどへ使用し、LanceDBをチャンクとEmbeddingの検索へ使用している。

## 7.3 クラウド実装

| インターフェース      | Cloudflare参照実装 |
| ------------- | -------------- |
| MetadataStore | D1             |
| VectorStore   | Vectorize      |
| ContentStore  | R2             |
| Queue Store   | Queues＋D1      |

## 7.4 データ分離

すべてのクラウドデータは、最低限以下のキーで分離する。

```text
tenant_id
repository_id
workspace_id
revision_id
```

異なるtenantまたはworkspaceの検索結果が混在してはならない。

## 7.5 データモデル

### Repository

```typescript
interface Repository {
  id: string;
  tenantId: string;
  name: string;
  remoteUrl?: string;
  createdAt: string;
}
```

### Workspace

```typescript
interface Workspace {
  id: string;
  repositoryId: string;
  deviceId: string;
  displayName: string;
  defaultBranch?: string;
  lastSeenAt: string;
}
```

### WorkspaceRevision

```typescript
interface WorkspaceRevision {
  id: string;
  workspaceId: string;
  sequence: number;
  baseCommitSha: string | null;
  branch: string | null;
  dirty: boolean;
  status: "receiving" | "indexing" | "ready" | "failed";
  createdAt: string;
}
```

### FileRecord

```typescript
interface FileRecord {
  workspaceId: string;
  revisionId: string;
  path: string;
  contentHash: string;
  gitStatus:
    | "committed"
    | "staged"
    | "modified"
    | "untracked"
    | "deleted"
    | "renamed";
  oldPath?: string;
  size: number;
  language?: string;
}
```

### ChunkRecord

```typescript
interface ChunkRecord {
  id: string;
  repositoryId: string;
  workspaceId: string;
  revisionId: string;
  filePath: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  chunkText: string;
  embeddingModel: string;
  embeddingDimensions: number;
}
```

---

# 8. Sync Agent要件

## 8.1 目的

Cloud HTTP v2モードにおいて、ローカル作業ツリーの最新状態をクラウドNexusへ反映する。

Sync AgentはMCPサーバーではない。

Sync Agentは、ローカルマシンからクラウドへの外向きHTTPS通信だけを行う。

## 8.2 起動方法

対話実行：

```bash
nexus sync \
  --project-root /path/to/project \
  --workspace ai-agent-pc
```

デーモン実行：

```bash
nexus sync start \
  --project-root /path/to/project \
  --workspace ai-agent-pc
```

状態確認：

```bash
nexus sync status
```

停止：

```bash
nexus sync stop
```

フル同期：

```bash
nexus sync --full
```

## 8.3 監視対象

Sync Agentは以下を監視する。

* 対象ファイルの作成
* 内容変更
* 削除
* rename
* Git index変更
* `.git/HEAD`変更
* ブランチ切り替え
* rebase
* reset
* merge
* checkout
* ignore設定の変更

## 8.4 同期対象

* committed状態
* staged変更
* unstaged変更
* untrackedファイル
* 削除情報
* rename情報
* ファイル本文
* ファイルハッシュ
* ASTチャンク
* Git状態
* base commit SHA
* branch名

## 8.5 除外対象

以下はデフォルトで同期しない。

* `.git`
* `.nexus`
* `node_modules`
* ビルド成果物
* キャッシュ
* バイナリ
* `.env`
* `.env.*`
* 現行Nexusのデフォルト除外パス
* 設定で明示された除外パス

現行Nexusでも`.env`および`.env.*`は常時除外され、`node_modules`、`.git`、`.nexus`などがデフォルト除外対象となっている。

## 8.6 同期方式

初回はフルスナップショットを送信する。

2回目以降はcontent hashを利用して差分だけを送信する。

```text
ファイル保存
  ↓
Watcherイベント
  ↓
デバウンス
  ↓
content hash計算
  ↓
差分バッチ生成
  ↓
HTTPS送信
  ↓
クラウド側で検証
  ↓
メタデータ・本文・Vector更新
  ↓
Revisionをreadyへ変更
  ↓
AgentへACK
```

## 8.7 一貫性

同期バッチには、単調増加する`sequence`を付与する。

クラウド側は、以下を満たさなければならない。

* 同一バッチの再送を冪等に処理する。
* sequenceの逆転を検知する。
* 欠落sequenceを検知する。
* 不整合時はフル同期を要求する。
* Revisionが`ready`になるまで最新検索対象へ切り替えない。
* Metadata、Content、Vectorの更新失敗を検知する。
* 部分更新されたRevisionを検索対象にしない。

## 8.8 オフライン対応

ネットワーク切断中は、変更イベントをローカル永続キューへ保存する。

復旧後は順番に再送する。

キュー上限を超えた場合は、イベントを無制限に保持せず、フル同期要求へ切り替える。

## 8.9 定期整合性確認

Watcherだけに依存してはならない。

一定間隔で以下を実行する。

* `git status --porcelain=v2`相当の状態確認
* ファイル一覧照合
* content hash照合
* 最新ACK sequence照合
* branchおよびHEAD照合

差異を検出した場合は差分同期またはフル同期を実行する。

---

# 9. MCP Tool要件

## 9.1 既存Tool

以下のTool名を維持する。

* `hybrid_search`
* `semantic_search`
* `grep_search`
* `get_context`
* `index_status`
* `reindex`

現行仕様では、これらのToolがハイブリッド検索、ベクトル検索、ripgrep、ファイルコンテキスト、インデックス状態、再構築を提供している。

## 9.2 互換性

Legacy Localモードでは、既存入力Schemaをそのまま利用できなければならない。

Cloudモードで追加する以下の項目は、原則として任意入力とする。

```typescript
interface WorkspaceSelector {
  repository?: string;
  workspace?: string;
  revision?: string;
}
```

認証情報またはサーバー設定から一意に解決できる場合は、省略可能とする。

デフォルト値：

```text
workspace = ユーザーまたはTokenに設定されたデフォルト
revision  = working-tree
```

## 9.3 hybrid_search

追加要件：

* 選択されたworkspaceおよびrevisionだけを検索する。
* セマンティック検索とテキスト検索をRRFで統合する。
* `includeSnippet`の既存挙動を維持する。
* 検索結果へ`workspaceId`と`revisionId`を付加できる。
* 使用したRevisionの鮮度情報を返す。

## 9.4 semantic_search

追加要件：

* Vector Store実装に依存しない。
* Embeddingモデルと次元の不一致を検出する。
* workspace、revision、repositoryのフィルターを必須で適用する。

## 9.5 grep_search

ローカルモードではripgrepを使用できる。

クラウドモードでは、以下のいずれかを使用する。

* D1 FTS
* SaaS全文検索
* Content Store上の検索インデックス
* 専用Search Service

クラウドMCP Workerからローカルマシン上のripgrepを直接実行する設計にはしない。

ローカル版とクラウド版で正規表現機能に差異が生じる場合は、レスポンスまたは`server/discover`で対応範囲を公開する。

## 9.6 get_context

Cloudモードでは、同期済みのContent Storeからファイル内容を取得する。

検索結果と異なるRevisionの本文を返してはならない。

レスポンスへ以下を含める。

```text
workspaceId
revisionId
filePath
contentHash
startLine
endLine
content
```

既存のeager／deferredモードを維持する。

## 9.7 index_status

以下を返す。

* workspace
* current revision
* latest ready revision
* base commit SHA
* branch
* dirty状態
* staged件数
* modified件数
* untracked件数
* deleted件数
* 同期時刻
* 同期遅延
* indexing状態
* ファイル数
* チャンク数
* DLQ件数
* 使用中のStorage Adapter
* 使用中のEmbedding provider

## 9.8 reindex

ローカルモードでは現在と同様に再インデックスする。

クラウドモードでは非同期ジョブとして扱う。

レスポンス例：

```json
{
  "jobId": "reindex-123",
  "status": "accepted",
  "workspaceId": "workspace-1"
}
```

MCP Tasks Extensionを利用可能なクライアントでは、同Extensionへ統合できる設計とする。ただしTasks非対応クライアント向けに、通常の`jobId`確認方式も提供する。

---

# 10. HTTP API要件

## 10.1 MCP

```text
POST /mcp
```

## 10.2 ヘルスチェック

```text
GET /health
```

プロセスが応答可能であれば200を返す。

## 10.3 Readiness

```text
GET /ready
```

検索を受け付けられる場合だけ200を返す。

以下の場合は503を返す。

* Storage接続不可
* マイグレーション未完了
* 必須インデックス未準備
* 設定不正

## 10.4 Sync API

```text
POST /sync/v1/batches
GET  /sync/v1/workspaces/{workspaceId}/status
POST /sync/v1/workspaces/{workspaceId}/reconcile
```

Sync APIはMCPとは別の認証Scopeを使用する。

MCPクライアント用TokenでSync APIへ書き込めてはならない。

## 10.5 管理API

管理APIを設ける場合は、MCPおよびSync APIとパス・認証Scopeを分離する。

---

# 11. 認証・認可要件

## 11.1 Local stdio

認証不要とする。

## 11.2 Local HTTP loopback

デフォルトでは認証不要とする。

ただし、OS上の別ユーザーからのアクセス制御が必要な環境では、Token認証を有効にできるものとする。

## 11.3 Local HTTP network

loopback以外へバインドする場合は認証必須とする。

最低限、以下のいずれかをサポートする。

* Bearer Token
* Cloudflare Access Service Token
* OAuth 2.0
* mTLS

## 11.4 Cloud HTTP

Cloud HTTPでは認証を必須とする。

認証後に以下を特定する。

```text
tenant_id
user_id
allowed_repository_ids
allowed_workspace_ids
permissions
```

## 11.5 Scope

最低限、以下のScopeを分ける。

```text
nexus:search
nexus:context:read
nexus:index:read
nexus:index:write
nexus:sync:write
nexus:admin
```

## 11.6 Cloudflare MCP Portal

Nexusの`/mcp`をCloudflare MCP Portalのupstreamとして登録可能にする。

Portal経由と直接接続の両方で、同一のMCP Tool仕様を提供する。

upstreamの直接URLも認証で保護し、Portalを迂回したアクセスを許可しない。

---

# 12. セキュリティ要件

## 12.1 パストラバーサル対策

既存の論理パス・物理パス・symlink検証を維持する。

すべてのファイルパスは、登録済みプロジェクトルート内に限定する。

現行NexusもTool入力に対し、論理パスと実パスの検証およびsymlink解決を行っている。

## 12.2 任意ローカルパスの禁止

Cloudクライアントから以下のような任意パスを指定できてはならない。

```json
{
  "projectRoot": "/etc"
}
```

クライアントは登録済みの`repository_id`または`workspace_id`だけを指定できる。

## 12.3 シークレット

以下をログへ出力しない。

* Access Token
* OAuth Token
* AWS資格情報
* Sync Agent Token
* ファイル本文
* Embedding入力全文
* 認証ヘッダー

## 12.4 暗号化

Cloudモードでは以下を満たす。

* 通信はTLSを使用する。
* SaaS側の保存データ暗号化を有効にする。
* TokenはSecret Storeへ保存する。
* Workspace単位でアクセスを分離する。

## 12.5 データ削除

以下の単位で削除可能にする。

* repository
* workspace
* revision
* user
* tenant

削除時はMetadata、Vector、Contentのすべてからデータを削除する。

---

# 13. 設定要件

## 13.1 設定優先順位

設定の優先順位は以下とする。

```text
CLI引数
  > 環境変数
  > .nexus.json
  > デフォルト値
```

## 13.2 設定例

```json
{
  "mode": "cloud",
  "projectName": "nexus",
  "transport": {
    "type": "streamable-http",
    "host": "127.0.0.1",
    "port": 9200,
    "path": "/mcp"
  },
  "storage": {
    "profile": "cloudflare"
  },
  "sync": {
    "enabled": true,
    "workspace": "ai-agent-pc",
    "endpoint": "https://nexus-sync.example.com",
    "debounceMs": 500,
    "reconcileIntervalMs": 300000
  },
  "embedding": {
    "provider": "bedrock",
    "model": "amazon.titan-embed-text-v2:0",
    "dimensions": 1024
  }
}
```

## 13.3 新規環境変数

```text
NEXUS_MODE
NEXUS_TRANSPORT
NEXUS_HTTP_HOST
NEXUS_HTTP_PORT
NEXUS_HTTP_PATH
NEXUS_ALLOW_NETWORK
NEXUS_AUTH_MODE
NEXUS_STORAGE_PROFILE
NEXUS_SYNC_ENDPOINT
NEXUS_SYNC_WORKSPACE
NEXUS_SYNC_TOKEN
NEXUS_SYNC_DEBOUNCE_MS
NEXUS_SYNC_RECONCILE_INTERVAL_MS
```

Secret値は`.nexus.json`へ平文保存しない。

---

# 14. パッケージ構成

推奨構成：

```text
nexus/
├─ src/
│  ├─ core/
│  ├─ indexing/
│  ├─ search/
│  ├─ server/
│  │  ├─ mcp-server.ts
│  │  ├─ stdio-entry.ts
│  │  ├─ local-http-entry.ts
│  │  └─ protocol-capabilities.ts
│  ├─ storage/
│  │  ├─ interfaces/
│  │  ├─ local/
│  │  │  ├─ sqlite-metadata-store.ts
│  │  │  ├─ lancedb-vector-store.ts
│  │  │  └─ local-content-store.ts
│  │  └─ cloudflare/
│  │     ├─ d1-metadata-store.ts
│  │     ├─ vectorize-vector-store.ts
│  │     └─ r2-content-store.ts
│  ├─ sync/
│  │  ├─ agent.ts
│  │  ├─ watcher.ts
│  │  ├─ git-state.ts
│  │  ├─ local-queue.ts
│  │  └─ protocol.ts
│  └─ bin/
│     └─ nexus.ts
├─ packages/
│  └─ cloudflare-worker/
│     ├─ src/index.ts
│     └─ wrangler.jsonc
└─ migrations/
   ├─ local/
   └─ cloudflare/
```

## 14.1 依存方向

以下の依存方向を守る。

```text
Transport
    ↓
Application Service
    ↓
Domain / Core
    ↓
Storage Interface
    ↓
Storage Adapter
```

CoreおよびTool Handlerから、D1、Vectorize、R2、SQLite、LanceDBを直接参照しない。

---

# 15. 後方互換性

## 15.1 CLI

既存コマンドを破壊しない。

新規HTTP v2モードは、明示的な`serve`サブコマンドとして追加する。

## 15.2 Tool Schema

既存Toolの必須引数を増やさない。

クラウド固有の識別子は任意入力または認証コンテキストから解決する。

## 15.3 レスポンス

既存フィールドを削除・改名しない。

追加フィールドは後方互換な形で追加する。

## 15.4 データ

既存`.nexus/`データに対して、次を提供する。

* Schema version管理
* 自動マイグレーション
* マイグレーション前バックアップ
* 失敗時ロールバック
* `nexus doctor`による検証

## 15.5 HTTP Bridge

`nexus http-bridge`を維持する。

`nexus serve` は MCP v2 `/mcp` を提供する。
`nexus http-bridge` は現行 SDK v1 のまま維持し、既存の managed HTTP server `/mcp` へ接続する。

managed serverの起動・停止は、`Mcp-Session-Id`やプロトコルセッション数では管理しない。

代わりに、以下のいずれかを使用する。

* Bridgeプロセスからのlease
* ローカル参照カウント
* PID／lock file
* idle timeout
* 明示的なprocess manager

---

# 16. 非機能要件

## 16.1 インデックス鮮度

### Localモード

保存済みファイル変更が検索へ反映されるまで：

```text
通常時 p95 5秒以内
```

### Cloudモード

保存済みファイル変更がクラウド検索へ反映されるまで：

```text
通常時 p95 15秒以内
```

ネットワーク障害、Embedding API障害、大規模変更時は除く。

## 16.2 検索性能

インデックス構築済みの通常検索：

| モード   | p95目標 |
| ----- | ----: |
| Local |  1秒以内 |
| Cloud |  2秒以内 |

Embedding生成を伴う検索、Cold Start、大規模コンテキスト取得は別計測とする。

## 16.3 可用性

Cloud MCP Serverの月間可用性目標：

```text
99.9%
```

Sync Agentが停止していても、最後に`ready`となったRevisionの検索は継続できる。

ただし、レスポンスへデータ鮮度を明示する。

## 16.4 スケーラビリティ

* MCP Serverは水平スケール可能でなければならない。
* MCPプロトコルセッションを特定インスタンスへ固定しない。
* Storageはtenant／workspace単位で分割可能とする。
* 大規模なインデックス更新をMCPリクエスト処理と分離する。
* 再インデックスは非同期実行する。

## 16.5 リソース制御

* Syncバッチサイズに上限を設ける。
* ファイルサイズに上限を設ける。
* 検索`topK`に上限を設ける。
* `get_context`の最大行数・最大バイト数を制限する。
* Embedding並行数を制限する。
* リトライ回数を制限する。
* Queue overflow時はフル同期へフォールバックする。

## 16.6 Observability

最低限以下を記録する。

### Metrics

* MCP Tool呼び出し数
* MCP Toolエラー数
* Toolレイテンシ
* 検索レイテンシ
* 検索ヒット件数
* Syncバッチ件数
* Sync失敗件数
* Sync遅延
* Indexing時間
* Embedding呼び出し数
* Queue長
* DLQ件数
* 最新ready revisionの経過時間

現行NexusはPrometheus形式でTool呼び出し、検索結果、取得行数、Embedding処理などを計測しているため、この指標体系を維持・拡張する。

### Logs

構造化ログを使用し、以下を含める。

```text
request_id
tenant_id
repository_id
workspace_id
revision_id
tool_name
duration
status
error_code
```

ソース本文やTokenは含めない。

### Tracing

CloudモードではOpenTelemetry互換の分散トレースを利用可能にする。

---

# 17. エラー要件

エラーには機械判定可能なコードを付与する。

例：

```text
NEXUS_AUTH_REQUIRED
NEXUS_ACCESS_DENIED
NEXUS_WORKSPACE_NOT_FOUND
NEXUS_REVISION_NOT_READY
NEXUS_SYNC_OUT_OF_ORDER
NEXUS_SYNC_RECONCILE_REQUIRED
NEXUS_STORAGE_UNAVAILABLE
NEXUS_VECTOR_DIMENSION_MISMATCH
NEXUS_CONTENT_NOT_FOUND
NEXUS_INDEXING_IN_PROGRESS
NEXUS_RATE_LIMITED
```

MCPレスポンスでは、内部スタックトレースやSaaSの生エラーを返さない。

---

# 18. デプロイ要件

## 18.1 ローカル

GitHub Packagesから現在と同様に配布する。

```bash
npx @yohi/nexus
```

systemd等でLocal HTTP v2を常駐化できる。

## 18.2 Cloudflare参照実装

以下を独立してデプロイする。

```text
Nexus MCP Worker
Nexus Sync API Worker
D1 migrations
Vectorize index
R2 bucket
Queue consumer
```

MCP WorkerとSync API Workerは、同一Worker内でルート分離してもよいが、認証Scopeとデプロイ権限は論理的に分離する。

## 18.3 Cloudflare MCP Portal

Portalへ登録するupstream例：

```text
https://nexus-mcp.example.com/mcp
```

Tool名の衝突を避ける必要がある場合は、Portal側で別名を設定する。

---

# 19. 移行計画

## Phase 1：内部構造分離

* Tool HandlerとTransportを分離する。
* Metadata Storeをインターフェース化する。
* Vector Storeをインターフェース化する。
* Content Storeをインターフェース化する。
* 既存SQLite／LanceDBをAdapter化する。
* 既存テストを維持する。

## Phase 2：MCP SDK v2移行

* `@modelcontextprotocol/sdk` v1系からv2パッケージへ移行する。
* MCP `2026-07-28`を有効化する。
* `Mcp-Session-Id`依存を削除する。
* セッションMapを削除する。
* `/mcp`エンドポイントを実装する。
* `server/discover`を実装する。
* v2統合テストを追加する。

## Phase 3：Local HTTP v2

* `nexus serve`を追加する。
* loopbackデフォルトを実装する。
* `/health`と`/ready`を追加する。
* 認証オプションを追加する。
* systemd運用を検証する。
* HTTP Bridgeをv2化する。

## Phase 4：Sync Agent

* Watcherを再利用する。
* Git状態取得を追加する。
* Sync Protocolを定義する。
* ローカル永続Queueを追加する。
* フル同期・差分同期を実装する。
* offline／retry／reconciliationを実装する。

## Phase 5：Cloud Storage

* D1 Metadata Adapter
* Vectorize Adapter
* R2 Content Adapter
* Migration管理
* tenant／workspace分離
* Sync API

## Phase 6：Cloud MCP

* Cloudflare Worker版MCPを実装する。
* 認証を追加する。
* Cloudflare MCP Portalへ登録する。
* 負荷試験を実施する。
* セキュリティ試験を実施する。

## Phase 7：正式移行

* HTTP v2を推奨接続方式として文書化する。
* stdioをLegacyとして明示する。
* 既存利用者向け移行ガイドを提供する。
* 互換性期間中はstdioを削除しない。

---

# 20. 受入基準

## 20.1 MCP v2

* [ ] MCP `2026-07-28`として接続できる。
* [ ] `/mcp`でStreamable HTTP接続できる。
* [ ] `Mcp-Session-Id`を使用していない。
* [ ] MCPセッションMapが存在しない。
* [ ] 複数サーバーインスタンス間でSticky Sessionが不要である。
* [ ] `server/discover`が成功する。
* [ ] `MCP-Protocol-Version`を検証する。
* [ ] 必要なMCP HTTPヘッダーを検証する。
* [ ] Cloudflare MCP Portal経由でTool一覧とTool実行が成功する。

## 20.2 Legacy互換

* [ ] 従来の`nexus`起動でstdio接続できる。
* [ ] 従来の`.nexus.json`が利用できる。
* [ ] 従来の環境変数が利用できる。
* [ ] 既存6 Toolが利用できる。
* [ ] `nexus http-bridge`が利用できる。
* [ ] 既存`.nexus/`をマイグレーションできる。
* [ ] ローカルSQLite／LanceDB構成が維持される。

## 20.3 未commit情報

* [ ] unstaged変更が検索結果へ反映される。
* [ ] staged変更が検索結果へ反映される。
* [ ] untrackedファイルが検索対象になる。
* [ ] 削除ファイルが検索結果から消える。
* [ ] rename後のパスが反映される。
* [ ] branch切り替えが反映される。
* [ ] reset／rebase後に整合性が回復する。
* [ ] ネットワーク切断後の変更が復旧時に送信される。
* [ ] イベント欠落時にreconciliationで回復する。
* [ ] 検索結果と`get_context`が同一Revisionを参照する。

## 20.4 Local HTTP

* [ ] デフォルトで`127.0.0.1`だけにバインドする。
* [ ] ローカルSQLite／LanceDBだけで全機能が動作する。
* [ ] 外部ネットワークなしで検索できる。
* [ ] 未commit変更が5秒以内を目標に反映される。
* [ ] loopback以外へバインドする場合は認証が必須になる。

## 20.5 Cloud HTTP

* [ ] Sync Agentから外向きHTTPSだけで同期できる。
* [ ] ローカルPCへの着信接続を必要としない。
* [ ] tenant間で検索結果が分離される。
* [ ] workspace間で検索結果が分離される。
* [ ] Cloud Server停止・再起動後もインデックスが維持される。
* [ ] Sync Agent停止中も最後のready Revisionを検索できる。
* [ ] レスポンスからデータ鮮度を判断できる。
* [ ] Repository／Workspace削除時に全ストアからデータを削除できる。

## 20.6 セキュリティ

* [ ] 任意のローカルパスを指定できない。
* [ ] パストラバーサルを防止できる。
* [ ] symlink経由でproject root外を読めない。
* [ ] `.env`が同期されない。
* [ ] Tokenがログへ出力されない。
* [ ] MCP TokenでSync APIへ書き込めない。
* [ ] upstream直接URLが認証で保護される。

---

# 21. 対象外

本フェーズでは以下を対象外とする。

* エディタの未保存バッファ取得
* AIエージェントによるソースコードの直接編集
* Git commitまたはpushの自動実行
* IDE専用UI
* バイナリ解析
* GitHubを唯一の作業ツリー正本とする構成
* Cloudflare WorkersからローカルPCを直接参照する構成
* stdio機能の廃止
* Legacy Localモードの廃止
* Cloudflare以外の全SaaS Adapterの初期実装

---

# 22. 確定方針

本要件定義では、以下を確定事項とする。

1. Nexusの標準接続方式をMCP v2 Streamable HTTPへ移行する。
2. 現在のnpx／stdio方式はLegacyとして残す。
3. ローカルHTTP v2モードを提供する。
4. 業務・機密用途ではSQLite／LanceDBをローカルに保持できる。
5. クラウドモードではSaaSストレージを使用できる。
6. Cloudflare参照実装はWorkers＋D1＋Vectorize＋R2とする。
7. Cloudflare固有機能はAdapter層の外へ漏らさない。
8. Cloudモードでも未commit、staged、unstaged、untrackedを検索対象にする。
9. 未commit情報はローカルSync Agentからクラウドへ同期する。
10. Sync AgentはMCPサーバーとして動作させない。
11. GitHub上のcommit済みコードだけを検索対象とする構成は採用しない。
12. MCPサーバーはプロトコルセッションを持たない。
13. アプリケーション状態はworkspace、revision、jobなどの明示的な識別子で管理する。
14. MCP Server、Indexing、Sync、Storageを分離する。
15. 既存Tool名および基本的なTool Schemaは維持する。
