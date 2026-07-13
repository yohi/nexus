# Nexus: Local Codebase Index MCP Server 仕様書

本ドキュメントは、Nexus (Local Codebase Index MCP Server) のアーキテクチャ、コンポーネント構成、および主要な設計仕様をまとめたものです。

## 1. プロジェクト概要

Nexus は、ローカル環境で完結する高度なコードベースインデックスサーバーであり、複数の AI エージェントから Model Context Protocol (MCP) を通じてクロスファンクショナルにアクセスできるように設計されています。

**基本原則:**

- **Zero External Data Transmission**: すべてのインデックスデータはローカル (`<projectRoot>/.nexus/`) に保存され、外部へのデータ送信は行われません。デフォルトの Embedding もローカルのエンドポイント (Ollama 等) を使用します。
- **Event-Driven Pipeline**: ファイルシステムの変更を常時監視し、バックグラウンドで非同期にインデックスを更新するパイプラインアーキテクチャを採用しています。

## 2. アーキテクチャ構成

単一プロセス内に、MCP サーバー (トランスポート層・ツールハンドラ) とバックグラウンドのインデックスパイプラインが共存し、非同期イベントキューで疎結合に連携します。

```text
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server Process                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │  Transport   │───>│        Tool Handlers                 │   │
│  │  (SSE/HTTP)  │    │  hybrid_search / semantic_search /   │   │
│  └──────────────┘    │  grep_search / get_context /         │   │
│                      │  index_status / reindex              │   │
│                      └────────────┬─────────────────────────┘   │
│                                   │                             │
│                      ┌────────────v────────────┐                │
│                      │   Search Orchestrator   │                │
│                      │   (RRF Fusion Engine)   │                │
│                      └──┬─────────────────┬────┘                │
│                         │                 │                     │
│              ┌──────────v──┐    ┌─────────v───────┐             │
│              │  Semantic   │    │  Grep Search    │             │
│              │  Search     │    │  (ripgrep)      │             │
│              │  (LanceDB)  │    │                 │             │
│              └──────────────┘    └─────────────────┘             │
│                                                                 │
│  ┌──────────────────────── Index Pipeline ────────────────────┐ │
│  │                                                            │ │
│  │  [FS Watcher] --> [Event Queue] --> [Diff Detector]        │ │
│  │  (chokidar)       (async queue)     (Merkle Tree)          │ │
│  │                                          │                 │ │
│  │                   [Vector Store] <-- [Embedder] <-- [Chunker]│
│  │                    (LanceDB)      (Plugin)     (Custom/AST)  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### stdio-only クライアント向け HTTP Bridge

stdio 接続のみに対応した MCP クライアント（OpenCode など）から、Nexus HTTP サーバーに接続するには、`nexus http-bridge` サブコマンドを使います。Bridge は独立したローカルプロセスとして起動し、標準入出力の JSON-RPC を Nexus の Streamable HTTP エンドポイントに転送します。同一プロジェクトに対しては常に 1 つの Nexus HTTP サーバーを共有し、最後の MCP クライアントが切断すると自動的に停止します。

```text
┌──────────────────┐   stdio   ┌──────────────────┐   HTTP    ┌──────────────────┐
│    MCP Client    │  ──────>  │     nexus        │  ──────>  │     nexus        │
│  (OpenCode etc.) │           │   http-bridge    │           │   --managed      │
└──────────────────┘           └──────────────────┘           └──────────────────┘
```

Bridge はデフォルトで自動的にプロジェクト専用のループバック HTTP サーバーを発見または起動します。既存の HTTP サーバーが `endpoint.json` 記述子で健全性を示していればそれを再利用し、なければ `nexus --port 0 --managed` を detached な子プロセスとして起動します。デフォルトの自動動作は、`--url` 引数または `NEXUS_BRIDGE_URL` 環境変数で外部サービスへ明示的に中継する際にのみ上書きされます。

## 3. インデックスパイプライン

### 3.1. FS Watcher と Event Queue

- **常時稼働の Watcher**: OS レベルのファイル監視 (`chokidar`) は停止せず、変更イベントを取りこぼしません。
- **Event Queue と Backpressure**: 変更イベントはキューでバッファリングされ、デバウンス (100ms) されます。キューサイズが閾値 (`fullScanThreshold`: 5,000) を超えた場合はオーバーフロー状態となり、新規イベントを破棄した上でフルスキャン (Reconciliation) へフォールバックし、デススパイラルを防ぎます。

### 3.2. Diff Detector (Merkle Tree)

- **差分検出**: `xxhash` を用いた Merkle Tree により、ファイルシステムの変更 (`added`, `modified`, `deleted`) を高速に検出します。
- **リネーム最適化**: 同一ハッシュの削除と追加が検知された場合、Embedding の再計算をスキップし、データベース上のパスのみを更新 (Rename) して GPU コストを削減します。
- **削除処理**: 削除イベントでは Vector Store 上の該当チャンクと Merkle Tree のノード状態を削除し、存在しないファイルに対する不要な Embedding 再計算を行いません。
- **ディレクトリハッシュ整合性**: add / modify / delete / move の各イベント後に親ディレクトリの Merkle hash を更新し、未変更コンテンツでは root hash が安定し、内容変更時のみ変化する状態を維持します。

### 3.3. Chunker (Custom/AST Parser)

- AST ベースの構文解析により、関数やクラスなどの意味的な単位でコードをチャンク分割します。
- **Failsafe**: AST パースに失敗した場合は、固定行のオーバーラップ分割 (Sliding Window) にフォールバックし、インデックス落ちを防ぎます。
- **Event Loop Protection**: 巨大なファイルのパース時は一定ノードごとにイベントループに処理を譲る (cooperative yielding) ことで、サーバーの応答性を維持します。

### 3.4. Embedder

- `Ollama` や `openai-compat` プラグインを利用し、抽出されたチャンクをベクトル化します。`bedrock` プラグインで AWS Bedrock Runtime を直接呼び出すこともできます（詳細は §9.1）。
- **Concurrency Control**: パイプラインの並行度とは独立して、プロバイダーレベルのセマフォ (`p-limit`) で同時リクエスト数を制限し、GPU VRAM の枯渇やタイムアウトを防ぎます。

- **CPU 負荷抑制 (Ollama Thread Limit)**: Ollama プロバイダーは `/api/embed` リクエストに `options.num_thread` を含めます。デフォルト値は `2` であり、環境変数 `NEXUS_OLLAMA_NUM_THREAD` または `.nexus.json` の `embedding.ollamaNumThread` で変更できます。受付可能な範囲は整数 `1` から `16` までで、無効な値（`0`、負数、小数、`16` 超過など）は安全なデフォルト `2` にフォールバックします。OpenAI-compatible プロバイダーにはこの Ollama 専用オプションは送信されません。
- **Cache-Aware Embedding Path**: 同一チャンクの再計算を避けるため、L1（インメモリ `Map`）キャッシュと L2（SQLite `embedding_cache` テーブル）キャッシュの二層構造を持ちます。
  - L1 ヒット: `processEventWindow()` 内で `getL1Cache()` 経由にて即座に解決され、`embeddingProvider.embed()` は呼ばれません。キャッシュヒット時は LRU semantics を保つため `delete` & `set` によって Map の insertion order を更新します。
  - L1 ミス & L2 ヒット: `metadataStore.getEmbeddings()` で永続キャッシュを照合し、ヒットしたベクトルを `setL1Cache()` で L1 に hydration します。
  - L2 ミス（True Miss）: `embeddingProvider.embed()` を呼び出し、取得結果を L1 (`setL1Cache`) および L2 (`metadataStore.setEmbeddings`) の両方に書き戻します。L1 は `embeddingCacheSize` で上限が定められており、超過時は最も古いエントリを evict します。
  - **L2 エラーハンドリング**: L2 (SQLite) キャッシュの読み書きに失敗した場合、暗黙的に Embedding の再計算へフォールバックすることはなく、パイプラインの既存エラー動作（DLQ への委譲等）を通じて表出されます。
- **AWS Bedrock Provider**: `bedrock` provider（`src/plugins/embeddings/bedrock.ts`）は `InvokeModelCommand` で Titan v2 埋め込みモデルを直接呼び出します。Titan v2 はバッチ非対応（1 リクエスト = 1 テキスト）のため、`embed(texts[])` は `maxConcurrency` で束ねた N 本の並列 `InvokeModel` 呼び出しにマップします。認証は AWS SDK v3 のデフォルト認証チェーン（環境変数 → SSO → 名前付きプロファイル → IAM ロール）に委譲し、資格情報をコードに保持しません。`region` 未設定時は `us-east-1` にフォールバックし警告ログを出力します。`AccessDeniedException` / `ValidationException` / `ResourceNotFoundException` / `ExpiredTokenException` / `UnrecognizedClientException` は非リトライで即座に失敗させ、`ThrottlingException` や 5xx 相当のエラーは指数バックオフ + full jitter でリトライします（`RetryExhaustedError`）。返却次元が設定次元と異なる場合は `DimensionMismatchError` を即座に投げ、リトライしません。`healthCheck()` はエラー種別ごとに診断メッセージ（認証切れなら `aws sso login`、モデル未有効化なら Bedrock コンソールでのモデルアクセス有効化を促す等）を `console.warn` に出力してから `false` を返します。

## 4. ストレージ層 (Dual-Store)

### 4.1. Metadata Store (SQLite)

- Merkle Tree の状態とインデックス統計情報を管理します。
- 同時読み書きを可能にする WAL モードを有効化。
- ブロッキングを防ぐため、バルク操作 (INSERT/DELETE) はバッチトランザクションで分割実行され、定期的にイベントループを yield します。

### 4.2. Vector Store (LanceDB)

- チャンクのテキストデータと Embedding ベクトルを保存し、ANN (Approximate Nearest Neighbor) / Exact KNN 検索を提供します。
- **インジェクション対策**: フィルタ値には厳密なホワイトリスト検証 (`validateFilterValue`) と、SQLインジェクション対策のエスケープ (`escapeFilterValue`, `escapeLikeValue`) を行います。
- **In-flight I/O トラッキング**: サーバー終了時 (`close()` 呼び出し時) に実行中の I/O 操作の完了を待機し、安全にリソースを解放します。

### 4.3. Compaction (コンパクション)

LanceDB のフラグメンテーションを防ぐため、以下のタイミングで排他制御 (`AsyncMutex`) のもとコンパクション (`optimize`) が実行されます:

1. **Post-reindex**: リインデックス完了後
2. **Idle-time**: パイプラインが一定時間 (5分) アイドル状態になった時

## 5. 検索エンジン

### 5.1. RRF Fusion (Search Orchestrator)

- **Semantic Search**: LanceDB によるベクトル類似度検索。
- **Grep Search**: `ripgrep` の子プロセスを呼び出した高速なテキスト・正規表現検索。タイムアウト付きの `AbortController` でゾンビプロセスを防止。
- **RRF (Reciprocal Rank Fusion)**: Semantic 検索と Grep 検索の結果を統合し、最適なランキング (`topK`) を返します。

## 6. MCP ツール

AI エージェントに公開される MCP ツールとそれぞれの設計役割・ユースケースは以下の通りです:

- **`hybrid_search`**
  - **役割**: セマンティック（ベクトル）検索と ripgrep によるテキスト検索をハイブリッドに行い、RRF (Reciprocal Rank Fusion) で統合した最適ランキング (`topK`) を返します。
  - **ユースケース**: 概念的な探索や、曖昧な要件に関連するコード箇所を見つける場合に最も推奨されます。
- **`semantic_search`**
  - **役割**: LanceDB に対する純粋なベクトル類似度検索です。
  - **ユースケース**: 「これと似たような処理を行っている関数」など、文字列の一致に依らない類似構造・セマンティクスに基づく探索に適しています。
- **`grep_search`**
  - **役割**: ripgrep 子プロセスを使用した、高速かつ厳密なキーワード・正規表現検索です。
  - **ユースケース**: 特定のクラス名、関数定義、エラーメッセージ、定数など、一致する文字列を正確に特定したい場合に有効です。
- **`get_context`**
  - **役割**: 指定されたファイルから、必要な行範囲（`startLine` 〜 `endLine`）を切り出してコンテキストとして取得します。
  - **引数**: `startLine` および `endLine` はオプションです。これらが指定されない場合、ファイル全体のコンテンツを取得します。
  - **ユースケース**: 検索で見つかったファイルの詳細を把握するために使用します。LLMのコンテキストウィンドウを無駄に消費しないよう、極力取得範囲を絞り込んで使用する設計となっています。
- **`index_status`**
  - **役割**: インデックス構築の進捗状況、登録ファイル数、DLQの未処理/失敗イベント数などの統計情報を返します。
  - **ユースケース**: 検索を実行する前に、インデックスが構築中（`pipelineProgress.status === 'running'`）か完了しているかをエージェント自身が確認するために使用されます。
- **`reindex`**
  - **役割**: 既存のインデックスデータを一旦クリアまたは整合性検証し、最初からファイルをスキャンし直してインデックスを再作成します。
  - **ユースケース**: 大規模なファイル更新やブランチ切り替えによってインデックスが不整合を起こした際、手動でリフレッシュするために使用します。

**Path Sanitization (セキュリティ)**:
すべてのツールハンドラで入力パスに対する2段階検証 (論理パス・物理パスの検証および symlink 解決) を行い、プロジェクト外へのパストラバーサル攻撃を防御します。

## 7. 耐障害性とエッジケース (Resilience)

### 7.1. Dead Letter Queue (DLQ)

- Embedding のリトライが上限に達したイベントは DLQ に退避され、インデックスパイプラインの停止を防ぎます。
- バックグラウンドのリカバリループが定期的にヘルスチェックを行い、プロバイダー復旧後に再処理 (Reprocess) を試みます。DLQ内のリカバリスイープ処理は排他制御されており、二重起動は防止されます。
- **リカバリ試行制限**: リカバリ試行回数の上限（`maxRecoveryAttempts`、デフォルト5回）に達したエントリは、無限ループ防止のためキューから自動的に破棄（abandoned）され、手動でのリインデックスを促す警告を出力します。
- **TTLパージ**: リカバリスイープの実行開始時に、作成から一定時間（`ttlMs`、デフォルト24時間）が経過した期限切れエントリを自動的にクリーンアップします。
- 古くなった (stale) イベント (キューイング後にファイルが更に変更された等) は、ハッシュ比較により自動的に破棄されます。

### 7.2. Startup Reconciliation

- サーバー起動時に SQLite の Merkle ハッシュと実際のファイルシステムのハッシュを突き合わせます。
- クラッシュ等によって生じた LanceDB と SQLite 間のデータ不整合 (Orphan, Missing, Stale) を検出し、自動的に修復・再インデックスを行います。
- これにより、複雑な Write-Ahead Log (WAL) なしに結果整合性を保証します。

#### Project-Level Lock (プロジェクト単位ロック)

- 同一の `storage.rootDir` に対して複数の Nexus プロセスが同時に起動し、データベースの破損やファイル監視の競合を引き起こすのを防ぎます。
- 起動時、`storage.rootDir` 直下に `.nexus-lock` ファイルを作成し、排他的なアクセス権を獲得します。
- ロック獲得に失敗した場合（既に他のプロセスが使用中）、即座にエラーを返して起動を中止します。
- プロセス終了時（正常終了・エラー終了の両方）にロックは自動的に解放されます。`proper-lockfile` はクラッシュ時の stale lock を自動検出・解除します。
- 自動管理される HTTP サーバーは追加で `project-start-<hash>` 名前のグローバル起動ロックを使用し、同じプロジェクトに対して複数の Bridge から同時に子プロセスが起動するのを防ぎます。
#### Global Ollama Lock (Ollama グローバルロック)

- 同一マシン上で複数の Nexus プロセスが Ollama に同時にアクセスし、CPU を奪い合うのを防止します。
- `/tmp/nexus-global-ollama.lock` をシステム全体で共有し、`embed` の実行をプロセス間で直列化します。
- 同一プロセス内の並列度（`p-limit`）は維持され、インタープロセス間のみ排他制御が働きます。
- **Bounded Retry / Stale Policy**: グローバルロックは `proper-lockfile` のファイルベースロックを使用します。stale lock の検出タイムアウトは `60_000ms`、ロック獲得の retry 回数は `10` 回、retry 間隔は最低 `100ms`・最高 `1000ms` に制限されています。これにより、クラッシュしたプロセスの stale lock は自動回復しつつ、後続プロセスが無限待ちになることを防ぎます。
- **Error Safety**: `embed()` 呼び出しは `try { ... } finally { lock.release() }` で囲まれており、成功・失敗・例外のいずれでもロック解放が試行されます。解放失敗は元のエラーを隠蔽しません。

## 8. Observability (可視化)

Nexus は、単一プロセスの内部状態だけでなく、複数プロジェクト・複数 Nexus プロセスを横断したアプリケーション層メトリクスを Prometheus / Grafana で監視できるように設計されています。

### 8.1. Metrics Collector & HTTP Server

- 各コアモジュール (EventQueue, IndexPipeline, DLQ) に `metricsHooks` を注入し、非同期でメトリクスを収集します。
- MCP ツール、検索結果数、コンテキスト取得行数、Embedding provider 呼び出しも同じ `MetricsCollector` に集約されます。
- `prom-client` を使用してインメモリで状態を集計します。メトリクス収集自体はパフォーマンス保護のため I/O を行いません。
- `MetricsCollector` は `project` と `pid` を default label として全メトリクスに付与します。`project` は `projectName`、`NEXUS_PROJECT_NAME`、プロジェクトルートのベース名の順で解決されます。
- メトリクスレジストリが有効な場合、バックグラウンドで HTTP サーバーが起動し、`127.0.0.1` 上で以下のエンドポイントを提供します。`metricsPort` / `NEXUS_METRICS_PORT` が未指定の場合は OS により空きポートが自動割当され、解決済みポートは `storage.rootDir` 配下の `metrics.port` に書き込まれます。
  - `GET /metrics`: Prometheus 形式のメトリクス
  - `GET /metrics/json`: `prom-client` の JSON 配列形式メトリクス
  - `GET /health`: メトリクスサーバーのヘルスチェック

### 8.2. Application-level Metrics

既存の Queue / Indexing / DLQ メトリクスに加え、AI エージェント利用状況と検索品質を把握するために以下のアプリケーション層メトリクスを公開します。

| Metric | Type | Labels | Purpose |
| --- | --- | --- | --- |
| `nexus_tool_calls_total` | Counter | `project`, `pid`, `tool_name`, `status` | MCP ツール呼び出し回数とエラー率 |
| `nexus_tool_duration_seconds` | Histogram | `project`, `pid`, `tool_name` | MCP ツール実行レイテンシ |
| `nexus_search_results_hits` | Histogram | `project`, `pid`, `search_type` | 検索ヒット件数分布 |
| `nexus_context_lines_fetched_total` | Counter | `project`, `pid`, `tool_name` | エージェントが取得したコード行数 |
| `nexus_embedding_requests_total` | Counter | `project`, `pid`, `provider`, `status` | Embedding provider 呼び出し回数 |
| `nexus_embedding_duration_seconds` | Histogram | `project`, `pid`, `provider` | Embedding provider レイテンシ |
| `nexus_embedding_batch_size` | Histogram | `project`, `pid`, `provider` | Embedding request の batch size 分布 |

MCP ツールは `withToolMetrics` によりハンドラー外側で成否とレイテンシを計測します。検索結果数や `get_context` の取得行数などの固有メトリクスは、ハンドラー内で結果オブジェクトが確定した後に記録します。Embedding provider は Decorator (`InstrumentedEmbeddingProvider`) でラップされ、既存 provider 実装を変更せずに `embed()` の成功・失敗・処理時間・バッチサイズを記録します。

### 8.3. Telemetry Aggregator

`nexus dashboard` は TUI と同じプロセス内で Telemetry Aggregator を起動します。Aggregator は複数 Nexus プロセスを登録・監視し、Grafana / Prometheus 向けの単一 scrape endpoint を提供します。

```text
Nexus Process A (:metricsPort) ─┐
Nexus Process B (:metricsPort) ─┼─ POST /api/discovery/register ─┐
Nexus Process C (:metricsPort) ─┘                                │
                                                                  ▼
                                                   nexus dashboard Aggregator
                                                   GET /metrics -> JSON merge -> Prometheus text
```

Aggregator のエンドポイントは以下の通りです。

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/discovery/register` | Nexus プロセスの登録・Heartbeat。`metricsPort` を key として upsert します。 |
| `GET` | `/metrics` | 全登録ノードの `/metrics/json` を集約し、Prometheus テキスト形式で返します。 |
| `GET` | `/health` | Aggregator 自身のヘルスと登録ノード数を返します。 |
| `GET` | `/api/discovery/nodes` | 登録ノード一覧をデバッグ用に返します。 |

`POST /api/discovery/register` は `projectId`、`metricsPort`、`pid` を必須フィールドとして検証します。不正な登録 payload は `400 Bad Request` として拒否され、該当ノードはスタンドアロンの Nexus プロセスとして稼働を継続します。

`GET /metrics` は登録済みノードを並列に取得し、`Promise.allSettled` の fulfilled 結果だけを採用します。個別ノードの失敗はスキップされ、他ノードの結果は返却されます。全ノード取得に失敗した場合も Prometheus 互換の空テキストを HTTP 200 で返します。メトリクスは名前ごとにグループ化され、`values` は単純結合されます。各 Nexus プロセスが `project` / `pid` default label を付与するため、異なるノードの label set は一意であり、Histogram の `_bucket` / `_sum` / `_count` も算術加算せずそのまま再構築できます。

### 8.4. Registration & Health Checking

各 Nexus プロセスはメトリクス HTTP サーバー起動後、`RegistrationClient` により Aggregator へ登録されます。

- 起動直後に `POST /api/discovery/register` を送信し、その後 30 秒間隔で Heartbeat を送ります。
- 登録リクエストのタイムアウトは 1 秒です。
- Aggregator 未起動、停止、ネットワーク遅延、タイムアウトは debug ログのみで扱われ、Nexus 本体の稼働を停止させません。
- Aggregator は 15 秒間隔で登録ノードの `/health` を確認し、失敗または非 OK 応答のノードを即座に evict します。誤判定された場合も、次回 Heartbeat により最大 30 秒程度で再登録されます。
- **Package Mode での登録スキップ**: `NEXUS_PACKAGE_MODE=1` で起動した場合、`registrationClient` は生成されず（`null`）、Aggregator への登録・Heartbeat は行われません。ローカルの metrics HTTP サーバーおよび `nexus dashboard`（TUI）はこのモードでも変わらず起動します（§9.1 参照）。

### 8.5. TUI Dashboard, Standalone Aggregator & Grafana

- Dashboard は独立した npm workspace パッケージ (`@yohi/nexus-dashboard`) として実装されています。
- `nexus dashboard` サブコマンドで起動し、React と ink を使用した Queue / Throughput / DLQ Health の TUI を提供します。
- `nexus aggregator` サブコマンドは、TUI画面を立ち上げず、メトリクス集約サーバー（AggregatorServer）のみをバックグラウンド（単体プロセスやデーモン）で起動するために使用します。
- `--port <number>` で接続先メトリクスサーバーのポートを指定できます。指定がない場合は `metrics.port` ファイルから自動検出し、自動検出できない場合はエラー終了します。
- `--aggregator-port <number>` (または `aggregator` コマンドにおける `--port`) で Aggregator の待受ポートを指定できます。解決順序はオプション引数、`.nexus.json` の `aggregatorPort`、`NEXUS_AGGREGATOR_PORT`、`9470` です。
- Aggregator 起動時に `EADDRINUSE` が発生した場合は、既に別プロセスで Aggregator が起動済みとみなし、TUI クライアント（または集約プロセス）として継続、あるいはスキップします。
- Grafana ダッシュボード定義は `docs/observability/grafana-dashboard.json`、セットアップ手順とメトリクスカタログは `docs/observability/README.md` にあります。

## 9. パッケージ版としての配布 (Package Mode & Distribution)

Nexus は単一コードベース上で、開発者向けのオリジナル動作（`packageMode=false`、デフォルト）と、社内向けに統制されたパッケージ版プラグイン（`packageMode=true`）の両方を提供します。フォークやコード複製ではなく、設定駆動で差分を表現します。

### 9.1. Package Mode (`NEXUS_PACKAGE_MODE`)

#### 設計前提と実装の乖離（背景）

パッケージ版の設計時には、当初「Grafana/Prometheus への aggregator 登録は `aggregatorPort` 未設定で既定オフなので、外部連携除外にコード変更は不要」と前提していました。しかし実装を追うと、この前提は成立していません：

- `src/server/index.ts:354-370` の `metricsServer` は factory から常に起動し、`preferredPort = metricsPort ?? 0`（ポート 0 = 自動採番）で `resolvedPort` は**常に定義される**。
- `src/server/index.ts:87-107` の `createRegistrationClient` は `resolvedPort === undefined` の時のみ `null` を返しますが、上記のとおり `resolvedPort` は常に定義されるため、**登録クライアントは常に起動**し、`aggregatorPort ?? 9470` に対し 30 秒間隔で POST を試みます。

つまり登録は「`aggregatorPort` 未設定で既定オフ」ではなく、**常に `127.0.0.1:9470` へ登録を試行**します（aggregator 不在時は debug ログのみで非致命）。パッケージ版が明示的に除外したい「外部連携」が、実際にはバックグラウンドで動作し続けます。

この乖離を解消するため、**案 B（意図を実現・推奨度高）** を採用し、`packageMode=true` 時に登録をスキップするガードを追加しました：

- `src/server/index.ts` の `registrationClient = options.packageMode ? null : createRegistrationClient(...)`
- `src/server/factory.ts` の `buildNexusRuntime(...)` 呼び出しへの `packageMode: config.packageMode` 伝搬

これにより、パッケージ版で外部連携（Aggregator 登録）を真に除外しながら、ローカル metrics/TUI は維持されます。

#### 設定項目

- `Config.packageMode: boolean`（env `NEXUS_PACKAGE_MODE`、既定 `false`）。
- `true` の場合、`src/server/factory.ts` の `assertPackageModeConstraints()` が `setupPluginRegistry()` の最初に呼ばれ、`embedding.provider !== "bedrock"` なら即座に fail-fast で例外を投げます（サーバー起動失敗）。
- **ロック対象は provider のみ**です。`model` / `dimensions` / `region` はデプロイ時に運用者が変更できる可変値であり、ハードロックの対象外です。
- メトリクス層には非干渉です。`MetricsCollector`・各プロセスの metrics HTTP サーバー・`nexus dashboard`（TUI）は `packageMode` の値に関わらず常に起動します。一方、Grafana/Prometheus 向けの Aggregator への自動登録（`RegistrationClient`）のみ `packageMode=true` でスキップされます（§8.4）。

### 9.2. ソースミラー配布 (Bitbucket 経由の Claude Code Plugin)

Nexus は社内 Claude Code plugin marketplace（Bitbucket Cloud 上でホスト）を通じて `yohi-nexus` という名前で配布されます。`better-sqlite3` / `@lancedb/lancedb` のネイティブ依存と `tsc` の非バンドルビルドを持つため、一般的な「`dist/` のみを配布する」方式は使えません（ビルド済み `dist/` は実行時に `node_modules` と、利用者プラットフォーム向けにビルドされたネイティブバイナリを必要とするため）。代わりに「ソースミラー」方式を採用します。

**本節では仕組みと設計意図のみを説明します。実行手順（トークン発行、Secret 登録、ワークフロー実行手順、トラブルシューティング等）は [docs/distribution.md](docs/distribution.md) に集約しています。**

- `.github/workflows/deploy-plugin-to-bitbucket.yml`（`workflow_dispatch` トリガ）が、最新の GitHub Release tag を取得し、`npm ci` → lint → test の品質ゲートを通過後、`scripts/stage-plugin-dist.sh dist-staging` でビルド可能な最小ソース一式（`package.json`, `tsconfig*.json`, `src/`, `packages/dashboard`, `.claude-plugin/plugin.json`, `scripts/setup-plugin.sh`, `LICENSE`, `NOTICE`）を staging し、自己完結ビルド検証（`npm install && npm run build`）と `claude plugin validate --strict` を経て Bitbucket `y-ohi/nexus` へ force-push します（常に 1 コミットのクリーンな状態）。
- `stage-plugin-dist.sh` は staging 時に `.claude-plugin/plugin.json` の `userConfig`（ollama/openai-compat 選択 UI）を除去し、`mcpServers.nexus.env` を固定リテラル（`NEXUS_PACKAGE_MODE=1` / `NEXUS_EMBEDDING_PROVIDER=bedrock` / `NEXUS_EMBEDDING_MODEL` / `NEXUS_EMBEDDING_DIMENSIONS` / `NEXUS_EMBEDDING_REGION` / 任意 `NEXUS_EMBEDDING_PROFILE`）へ置換します。これらの固定値の実際の値（region/model/dimensions）は GitHub Actions 変数でデプロイ運用者が変更できます（個々の変数名と既定値は [docs/distribution.md の P6](docs/distribution.md) を参照）。**ソース側の `.claude-plugin/plugin.json` 自体は編集しません**（変換は stage 時のみ）。
- 利用者マシンでは Setup フックの `scripts/setup-plugin.sh` が `npm install --no-audit --no-fund` → `npm run build` を実行します。AWS Bedrock 呼び出しに必要な AWS 資格情報の用意方法は §3.4（Embedder）の認証チェーン説明と [docs/distribution.md の P5](docs/distribution.md) を参照してください。
- 汎用的な「Bitbucket 上の社内 Claude Code plugin marketplace」構築パターン（marketplace リポジトリ、複数 plugin の配布フロー、認証方式など）自体は Nexus 固有ではなく、`.github/workflows/deploy-plugin-to-bitbucket.yml` と `.github/workflows/update-marketplace-entry.yml` の実装が正の参照先です。ネイティブ依存プラグインが「dist のみ」ルールを適用できずソースミラー方式を採る、という例外規定はこのパターンの一部として定義されています。
- marketplace カタログ更新処理（git clone/commit/push の retry ループ + エントリ upsert）は `scripts/update-marketplace-catalog.sh` と `scripts/marketplace-update-entry.mjs` に共通化され、`deploy-plugin-to-bitbucket.yml`（D1）と `update-marketplace-entry.yml`（D2）の両方から呼び出されます（二重実装を回避）。Bitbucket リポジトリ URLは直接指定しない方式を採用し、Repository variable `BITBUCKET_WORKSPACE_NAME`（plugin配布repoとmarketplace catalog repoで共通）+ `BITBUCKET_PLUGIN_REPOSITORY_NAME` / `BITBUCKET_MARKETPLACE_REPOSITORY_NAME` から `https://bitbucket.org/<workspace>/<repository>.git` の形で自動構築します。`PLUGIN_NAME` / `PLUGIN_DESCRIPTION` も含め、これらの Repository variable は両ワークフローで共通参照（[docs/distribution.md の P3・P7](docs/distribution.md) 参照）され、D2 は入力で上書きできますが省略時は D1 と完全に同じ値になるため、手動実行時の値不一致によるカタログの孤立エントリ事故を防いでいます。これらの値にはハードコードの既定値がなく、Repository variable 未設定の場合は `scripts/update-marketplace-catalog.sh` が fail-fast します。
- marketplace エントリの `source` には `ref`（Git tag/branch）を付与してバージョンを pin できます。`deploy-plugin-to-bitbucket.yml` は常に最新の GitHub Release tag を `ref` として自動設定し、`update-marketplace-entry.yml`（手動更新用）は任意の `plugin_ref` 入力で pin 先を指定できます（省略時は unpinned）。
