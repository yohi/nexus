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
│  │                    (LanceDB)      (Plugin)     (tree-sitter) │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## 3. インデックスパイプライン

### 3.1. FS Watcher と Event Queue
- **常時稼働の Watcher**: OS レベルのファイル監視 (`chokidar`) は停止せず、変更イベントを取りこぼしません。
- **Event Queue と Backpressure**: 変更イベントはキューでバッファリングされ、デバウンス (100ms) されます。キューサイズが閾値 (`fullScanThreshold`: 5,000) を超えた場合はオーバーフロー状態となり、新規イベントを破棄した上でフルスキャン (Reconciliation) へフォールバックし、デススパイラルを防ぎます。

### 3.2. Diff Detector (Merkle Tree)
- **差分検出**: `xxhash` を用いた Merkle Tree により、ファイルシステムの変更 (`added`, `modified`, `deleted`) を高速に検出します。
- **リネーム最適化**: 同一ハッシュの削除と追加が検知された場合、Embedding の再計算をスキップし、データベース上のパスのみを更新 (Rename) して GPU コストを削減します。

### 3.3. Chunker (tree-sitter)
- AST ベースの構文解析により、関数やクラスなどの意味的な単位でコードをチャンク分割します。
- **Failsafe**: AST パースに失敗した場合は、固定行のオーバーラップ分割 (Sliding Window) にフォールバックし、インデックス落ちを防ぎます。
- **Event Loop Protection**: 巨大なファイルのパース時は一定ノードごとにイベントループに処理を譲る (cooperative yielding) ことで、サーバーの応答性を維持します。

### 3.4. Embedder
- `Ollama` や `openai-compat` プラグインを利用し、抽出されたチャンクをベクトル化します。
- **Concurrency Control**: パイプラインの並行度とは独立して、プロバイダーレベルのセマフォ (`p-limit`) で同時リクエスト数を制限し、GPU VRAM の枯渇やタイムアウトを防ぎます。

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
  - **ユースケース**: 検索で見つかったファイルの詳細を把握するために使用します。LLMのコンテキストウィンドウを無駄に消費しないよう、極力取得範囲を絞り込んで使用する設計となっています。
- **`index_status`**
  - **役割**: インデックス構築の進捗状況、登録ファイル数、DLQの未処理/失敗イベント数などの統計情報を返します。
  - **ユースケース**: 検索を実行する前に、インデックスが構築中（`isIndexing: true`）か完了しているかをエージェント自身が確認するために使用されます。
- **`reindex`**
  - **役割**: 既存のインデックスデータを一旦クリアまたは整合性検証し、最初からファイルをスキャンし直してインデックスを再作成します。
  - **ユースケース**: 大規模なファイル更新やブランチ切り替えによってインデックスが不整合を起こした際、手動でリフレッシュするために使用します。

**Path Sanitization (セキュリティ)**: 
すべてのツールハンドラで入力パスに対する2段階検証 (論理パス・物理パスの検証および symlink 解決) を行い、プロジェクト外へのパストラバーサル攻撃を防御します。

## 7. 耐障害性とエッジケース (Resilience)

### 7.1. Dead Letter Queue (DLQ)
- Embedding のリトライが上限に達したイベントは DLQ に退避され、インデックスパイプラインの停止を防ぎます。
- バックグラウンドのリカバリループが定期的にヘルスチェックを行い、プロバイダー復旧後に再処理 (Reprocess) を試みます。二重起動防止機能付き。
- 古くなった (stale) イベント (キューイング後にファイルが更に変更された等) は、ハッシュ比較により自動的に破棄されます。

### 7.2. Startup Reconciliation
- サーバー起動時に SQLite の Merkle ハッシュと実際のファイルシステムのハッシュを突き合わせます。
- クラッシュ等によって生じた LanceDB と SQLite 間のデータ不整合 (Orphan, Missing, Stale) を検出し、自動的に修復・再インデックスを行います。
- これにより、複雑な Write-Ahead Log (WAL) なしに結果整合性を保証します。

## 8. Observability (可視化)

Nexus の内部状態をリアルタイムに把握するため、メトリクス収集とTUIダッシュボードを提供します。

### 8.1. Metrics Collector & HTTP Server
- 各コアモジュール (EventQueue, IndexPipeline, DLQ) に optional なコールバック (`metricsHooks`) を注入し、非同期でメトリクスを収集します。
- `prom-client` を使用してインメモリで状態を集計します。パフォーマンスを保護するため I/O 操作は行いません。
- メトリクスレジストリが有効な場合、バックグラウンドで HTTP サーバーが起動し、以下のエンドポイントを提供します。
  - デフォルトで `127.0.0.1` にバインドされます。
  - デフォルトポートは `9464` ですが、環境変数 `NEXUS_METRICS_PORT` で上書き可能です。
  - `GET /metrics` : Prometheus 形式のメトリクス
  - `GET /metrics/json` : JSON 配列形式のメトリクス
  - `GET /health` : ヘルスチェック

### 8.2. TUI Dashboard
- 独立した npm workspace パッケージ (`@yohi/nexus-dashboard`) として実装されています。
- `nexus dashboard` サブコマンドで起動し、React と ink を使用した 3 パネル構成 (Queue, Throughput, DLQ Health) の TUI を提供します。
- `--port <number>` (デフォルト: `9464`) で接続先メトリクスサーバーのポートを、`--interval <ms>` (デフォルト: `2000`) でポーリング間隔をそれぞれ指定できます。
- HTTP エンドポイント (`/metrics/json`) を定期的にポーリングし、サーバーの再起動時にも自動的に再接続を試みます。
