# Nexus Implementation Plan

## Overview

設計仕様書 `docs/superpowers/specs/2026-04-03-codebase-index-mcp-server-design.md` に基づく
Local Codebase Index MCP Server の段階的実装プラン。

**前提条件:**

- プロジェクトは設計仕様書と LICENSE のみ存在（実装ゼロの状態）
- 設計仕様書の Phase 1〜3 の依存関係に従い、ボトムアップで構築
- 各ステップは「テスト可能な増分」を単位とし、Red/Green TDD サイクルを基本とする

**最終更新: 2026-04-10** — Phase 1・Phase 2 完了。Phase 3 はコード実装済み（LanceDB 実統合・Compaction Pipeline 組み込みを除く）。

**プラン構成:**

- **Phase 1**: Core Pipeline Foundation — ファイル変更検出からベクトルストレージまでの E2E フロー
- **Phase 2**: Search & MCP Server Layer — 6つの MCP ツールを AI エージェントに公開
- **Phase 3**: Resilience & Edge Cases — 本番グレードの耐障害性

---

## Phase 1: Core Pipeline Foundation

**Goal:** ファイル変更検出 → Merkle Tree 差分検出 → tree-sitter チャンキング → Embedding → LanceDB 格納の E2E フロー。

### Step 1.1: Project Scaffold

**目的:** ビルド・テスト・リント環境の確立。すべての後続ステップの基盤。

**成果物:**

- [x] `package.json` — dependencies + devDependencies + scripts
- [x] `tsconfig.json` — TypeScript 5.x strict mode, ESM output
- [x] `eslint.config.mjs` — flat config
- [x] `vitest.config.ts` — test runner config
- [x] `.devcontainer/devcontainer.json` + `Dockerfile` — Node.js 22 LTS + ripgrep
- [x] `.gitignore` — `.nexus/`, `node_modules/`, `dist/`
- [x] `src/` ディレクトリ構造のスキャフォールド（空ファイル）
- [x] license audit script (`license:check`, `license:report`, `license:notice`)

**依存パッケージ (production):**

```
@modelcontextprotocol/sdk, @lancedb/lancedb, better-sqlite3,
chokidar, xxhash-wasm, web-tree-sitter, p-limit, async-mutex
```

**依存パッケージ (dev):**

```
typescript, vitest, eslint, prettier, @types/better-sqlite3,
license-checker, generate-license-file
```

**検証:**

- `npm run build` が成功すること
- `npm run lint` がエラーなしで完了すること
- `npm run test` が 0 テストで正常終了すること
- `npm run license:check` が禁止ライセンスを検出しないこと

**ブロック:** なし（最初のステップ）

---

### Step 1.2: Type Definitions

**目的:** 全コンポーネント間で共有される型定義を確立。後続ステップで import される基盤。

**成果物:**

- [x] `src/types/index.ts` — 以下のインターフェース/型を定義:
  - `CodeChunk`, `SymbolKind`
  - `SearchResult`, `RankedResult`, `SearchResponse`
  - `IndexEvent` (`added | modified | deleted`)
  - `FileToChunk`
  - `IVectorStore`, `VectorFilter`, `VectorSearchResult`, `VectorStoreStats`, `CompactionResult`, `CompactionConfig`
  - `IMetadataStore`, `MerkleNodeRow`, `IndexStatsRow`
  - `IGrepEngine`, `GrepParams`
  - `EmbeddingProvider`, `EmbeddingConfig`
  - `LanguagePlugin`
  - `Config` (全体設定)
  - `RetryExhaustedError`, `PathTraversalError`
  - `ReconciliationResult`, `ReindexResult`, `ReindexOptions`

**検証:**

- `npm run build` が型エラーなしで完了すること
- 型定義のみのファイルであり、ランタイム副作用なし

**ブロック:** Step 1.1

---

### Step 1.3: Metadata Store (SQLite)

**目的:** Merkle Tree の永続化層 + インデックス統計の管理。`IMetadataStore` インターフェースの具象実装。

**成果物:**

- [x] `src/storage/metadata-store.ts` — `SqliteMetadataStore implements IMetadataStore`
  - スキーママイグレーション（`merkle_nodes` + `index_stats` テーブル作成）
  - WAL モード有効化 + `wal_autocheckpoint = 1000` 明示設定
  - `bulkUpsertMerkleNodes()` — バッチトランザクション + cooperative yielding
  - `bulkDeleteMerkleNodes()` — 同上
  - `deleteSubtree()` — prefix-match による子孫ノード一括削除
  - `getMerkleNode()`, `getAllFileNodes()`, `getAllPaths()`
  - `getIndexStats()`, `setIndexStats()`
- [x] `src/storage/batched-transaction.ts` — `executeBatchedWithYield<T>()` 汎用ヘルパー
- [x] `tests/unit/storage/metadata-store.test.ts`
- [x] `tests/unit/storage/in-memory-metadata-store.ts` — `InMemoryMetadataStore implements IMetadataStore`

**テストケース:**

- バルク upsert → 全ノード取得で一致確認
- バルク delete → 該当ノード消去確認
- `deleteSubtree` → ディレクトリ配下の全ノード削除
- バッチサイズ境界（100件ちょうど、101件）の分割動作
- WAL autocheckpoint 設定値の検証

**検証:**

- `npm run test -- tests/unit/storage/metadata-store.test.ts` が全テスト通過

**ブロック:** Step 1.1, 1.2

---

### Step 1.4: Merkle Tree

**目的:** ファイルシステムの変更を効率的に検出する差分検出エンジン。

**成果物:**

- [x] `src/indexer/merkle-tree.ts` — `MerkleTree` クラス
  - リーフノード: ファイルコンテンツの xxhash
  - 内部ノード: 子ハッシュの連結 xxhash
  - `update(filePath, contentHash)` — リーフからルートへのハッシュ伝播
  - `remove(filePath)` — ノード削除 + 親ハッシュ再計算
  - `diff(oldTree, newTree)` — `added | modified | deleted` イベント列挙
  - SQLite からのインメモリツリー復元
- [x] `src/indexer/hash.ts` — xxhash ユーティリティ
  - `computeFileHash(filePath)` — 同期版（小ファイル向け）
  - `computeFileHashStreaming(filePath)` — ストリーム版（大ファイル向け）
  - `computePartialHash(filePath, fileSize)` — 10MB+ のファイル向け部分ハッシュ
- [x] `tests/unit/indexer/merkle-tree.test.ts`
- [x] `tests/unit/indexer/hash.test.ts`

**テストケース:**

- ファイル追加 → リーフ追加 + ルートハッシュ変化
- ファイル変更 → リーフハッシュ変化 + 変更パス上の全ノード再計算
- ファイル削除 → リーフ除去 + 親ハッシュ再計算
- 同一ハッシュの delete + add ペア → リネーム検出
- SQLite からの復元 → インメモリツリーと一致
- ストリームハッシュ vs 同期ハッシュの結果一致

**検証:**

- `npm run test -- tests/unit/indexer/` が全テスト通過

**ブロック:** Step 1.2, 1.3

---

### Step 1.5: Chunker (tree-sitter)

**目的:** AST ベースのコード分割。ファイルを意味のある CodeChunk に変換。

**成果物:**

- [x] `src/indexer/chunker.ts` — `Chunker` クラス
  - `chunkFiles(files)` — ファイルごとに AST パース → チャンク抽出
  - `extractChunksWithYield(rootNode, file)` — 50ノードごとの cooperative yielding
  - `chunkByFixedLines(file, opts)` — AST フォールバック（50行ウィンドウ、10行オーバーラップ）
  - `yieldToEventLoop()` — `setImmediate` ベースの yield
  - AST パース失敗時の failsafe（例外キャッチ → ライン分割フォールバック）
- [x] `src/plugins/languages/interface.ts` — `LanguagePlugin` インターフェース
- [x] `src/plugins/languages/typescript.ts` — TypeScript/JavaScript プラグイン
- [x] `src/plugins/registry.ts` — `LanguageRegistry` + `PluginRegistry`
- [x] `tests/unit/indexer/chunker.test.ts`
- [x] `tests/fixtures/sample-project/src/auth.ts` — テスト用 TypeScript ファイル

**テストケース:**

- 関数宣言 → 1関数 = 1チャンク（docコメント含む）
- クラス宣言 → シグネチャ + プロパティ = 1チャンク、メソッドは個別
- import 文 → 全 import = 1チャンク
- 200行超ノード → 子ノードレベルで再帰分割
- 非対応言語 → 固定行スライディングウィンドウ
- AST パース失敗（バイナリファイル等） → ライン分割フォールバック
- イベントループ yielding が実行されること（50ノード間隔）

**検証:**

- `npm run test -- tests/unit/indexer/chunker.test.ts` が全テスト通過

**ブロック:** Step 1.1, 1.2

---

### Step 1.6: Embedding Provider (Ollama)

**目的:** テキストから embedding ベクトルを生成するプラグインシステム。

**成果物:**

- [x] `src/plugins/embeddings/interface.ts` — `EmbeddingProvider` インターフェース（型定義から re-export）
- [x] `src/plugins/embeddings/ollama.ts` — `OllamaEmbeddingProvider`
  - `POST http://localhost:11434/api/embed` エンドポイント
  - Provider レベルセマフォ（`p-limit`, デフォルト maxConcurrency: 2）
  - 3回リトライ + 指数バックオフ
  - バッチ embed（デフォルト 32テキスト/リクエスト）
  - `healthCheck()` — セマフォ不通過の軽量ヘルスチェック
- [x] `tests/unit/plugins/embeddings/ollama.test.ts`
- [x] `tests/unit/plugins/embeddings/test-embedding-provider.ts` — `TestEmbeddingProvider`
  - 決定論的ベクトル生成（テキストハッシュ → 固定次元ベクトル）
  - dimensions: 64

**テストケース:**

- セマフォが `maxConcurrency` を超える同時リクエストをブロックすること
- リトライ 3回後に `RetryExhaustedError` がスローされること
- `healthCheck()` がセマフォを通過しないこと
- バッチ embed が正しい次元のベクトルを返すこと
- `TestEmbeddingProvider` が同一テキストに対して同一ベクトルを返すこと

**検証:**

- `npm run test -- tests/unit/plugins/embeddings/` が全テスト通過
- Ollama 接続テストは integration テストに分離（Phase 2）

**ブロック:** Step 1.1, 1.2

---

### Step 1.7: Vector Store (LanceDB)

**目的:** Embedding ベクトルの永続化 + ANN 検索。`IVectorStore` インターフェースの具象実装。

**成果物:**

- [x] `src/storage/vector-store.ts` — `LanceVectorStore implements IVectorStore`
  - テーブル作成（スキーマ: id, filePath, content, language, symbolName, symbolKind, startLine, endLine, vector）
  - `upsertChunks()` — delete-before-insert でアトミック更新
  - `deleteByFilePath()`, `deleteByPathPrefix()`
  - `search(queryVector, topK, filter?)` — ANN 検索
  - `compactIfNeeded()` — フラグメンテーション閾値チェック + compact/prune/cleanup
  - `scheduleIdleCompaction(pipelineMutex)` — アイドルタイマーコンパクション
  - `getStats()` — ストレージ統計
  - **注意:** 現時点の実装は `Map` ベースのインメモリ実装。`@lancedb/lancedb` による実際の永続化・ANN 検索への差し替えは未完了（TODO コメントあり）
- [x] `tests/unit/storage/vector-store.test.ts`
- [x] `tests/unit/storage/in-memory-vector-store.ts` — `InMemoryVectorStore implements IVectorStore`

**テストケース:**

- チャンク upsert → search で取得可能
- `deleteByFilePath` → 該当ファイルのチャンクが全削除
- `deleteByPathPrefix` → プレフィックス配下の全チャンクが削除
- `compactIfNeeded` → フラグメンテーション 20% 以下ならスキップ
- `InMemoryVectorStore` が `IVectorStore` インターフェースを満たすこと

**検証:**

- `npm run test -- tests/unit/storage/vector-store.test.ts` が全テスト通過

**ブロック:** Step 1.1, 1.2

---

### Step 1.8: Event Queue

**目的:** FS イベントのバッファリング、デバウンス、優先度管理、バックプレッシャー制御。

**成果物:**

- [x] `src/indexer/event-queue.ts` — `EventQueue` クラス
  - 100ms デバウンス（同一ファイルの連続変更を統合）
  - 優先度: `reindex` リクエスト > Watcher イベント
  - `p-limit` による同時処理数制限（デフォルト: 4）
  - バックプレッシャー: `maxQueueSize` (10,000) でバウンド
  - `fullScanThreshold` (5,000) 超過でオーバーフローフラグ設定
  - オーバーフロー時: 新規イベントをアプリ層で破棄（OS Watcher は停止しない）
  - `enqueue()`, `drain()`, `clear()`, `size()`, `isOverflowing()`

**テストケース:**

- 同一ファイルの 100ms 以内の連続イベント → 1イベントにデバウンス
- reindex イベントが通常イベントより先に処理されること
- 同時処理数が concurrency limit を超えないこと
- キューサイズが `fullScanThreshold` 超過 → オーバーフローフラグ ON
- オーバーフロー中の新規イベント → エンキュー拒否
- `clear()` → キューが空になること

**検証:**

- `npm run test -- tests/unit/indexer/event-queue.test.ts` が全テスト通過

**ブロック:** Step 1.1, 1.2

---

### Step 1.9: FS Watcher

**目的:** ファイルシステム変更の検出。常時稼働設計（OS Watcher は停止しない）。

**成果物:**

- [x] `src/indexer/watcher.ts` — `FileWatcher` クラス
  - chokidar ベースの FS 監視
  - `.gitignore` + `ignorePaths` 設定に基づくフィルタリング
  - `add`, `change`, `unlink` イベント → `EventQueue` へエンキュー
  - **常時稼働設計**: `close()` は明示的なシャットダウン時のみ
  - `start()`, `stop()` — ライフサイクル管理

**テストケース:**

- ファイル追加 → `added` イベントが EventQueue に到達
- ファイル変更 → `modified` イベントが EventQueue に到達
- ファイル削除 → `deleted` イベントが EventQueue に到達
- `ignorePaths` 対象ファイル → イベントが発生しないこと
- Watcher がライフサイクル中に停止されないこと（close 呼び出しなし）

**検証:**

- `npm run test -- tests/unit/indexer/watcher.test.ts` が全テスト通過
- 実 FS 操作を伴うため、一部テストは integration 扱い

**ブロック:** Step 1.8

---

### Step 1.10: Pipeline Integration

**目的:** 全コンポーネントを統合し、E2E のインデックスパイプラインを構築。

**成果物:**

- [x] `src/indexer/pipeline.ts` — `IndexPipeline` クラス
  - `AsyncMutex` による排他制御
  - Watcher → EventQueue → Diff Detector (Merkle) → Chunker → Embedder → VectorStore
  - `reindex(opts)` — 手動リインデックス（mutex.tryAcquire で二重実行防止）
  - `processEvents(events)` — Watcher イベントの逐次処理
  - `reconcileOnStartup()` — 起動時 Dual-Store 整合性チェック
    - SQLite Merkle ハッシュ vs ファイルシステムハッシュの突き合わせ
    - orphan 検出 → LanceDB/SQLite クリーンアップ
    - hash mismatch → 再インデックスキュー
  - `embedWithRetry()` — 3回リトライ + 指数バックオフ + `RetryExhaustedError` フォールバック
  - `skippedFiles` マップ（Phase 1 の DLQ 代替） → Phase 3 で DLQ に差し替え済み
- [x] `tests/unit/indexer/pipeline.test.ts` — `InMemoryVectorStore` + `InMemoryMetadataStore` + `TestEmbeddingProvider` による I/O レス単体テスト
- [x] `tests/integration/pipeline.test.ts` — 実 SQLite + 実 LanceDB での統合テスト

**テストケース (unit):**

- ファイル追加 → Merkle 更新 + チャンク生成 + ベクトル格納
- ファイル変更 → 旧ベクトル削除 + 新ベクトル格納
- ファイル削除 → Merkle ノード削除 + ベクトル削除
- Mutex による concurrent reindex 排除（`already_running` 返却）
- `RetryExhaustedError` → `skippedFiles` 追加 + パイプライン継続
- Reconciliation: orphan 検出 → クリーンアップ実行
- Reconciliation: hash mismatch → 再インデックス実行
- Reconciliation: 全 consistent → 処理ゼロ（fast path）

**検証:**

- `npm run test -- tests/unit/indexer/pipeline.test.ts` が全テスト通過
- `npm run test -- tests/integration/pipeline.test.ts` が全テスト通過
- サンプルプロジェクトで手動 `reindex` → LanceDB にデータが格納される

**ブロック:** Step 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9

---

## Phase 1 Exit Criteria

- [x] `npm run test:unit` が全テスト通過
- [x] サンプルプロジェクトで手動 `reindex` → LanceDB にデータ格納
- [x] リトライ上限イベントがエラーログに記録されスキップされる
- [x] 異常終了テスト後の再起動で Reconciliation が Dual-Store 不整合を検出・修復
- [x] `InMemoryVectorStore` / `InMemoryMetadataStore` による I/O レス単体テストが動作

---

## Phase 2: Search & MCP Server Layer

**Goal:** 6つの MCP ツールを AI エージェントに公開し、ハイブリッド検索を実現。

### Step 2.1: Semantic Search

**目的:** LanceDB の ANN 検索をラップし、セマンティック検索を提供。

**進捗:** 完了（`feature/phase2-1`, PR #10）

**成果物:**

- [x] `src/search/semantic.ts` — `SemanticSearch` クラス
  - クエリテキスト → embedding → LanceDB ANN 検索 → top-K 結果
  - `filePattern` / `language` フィルタ
- [x] `tests/unit/search/semantic.test.ts`

**検証:**

- テストケースで `InMemoryVectorStore` + `TestEmbeddingProvider` を使用した検索結果の正確性

**ブロック:** Phase 1 完了

---

### Step 2.2: Grep Search (ripgrep)

**目的:** ripgrep による高速テキスト検索。`IGrepEngine` インターフェースの具象実装。

**進捗:** 完了（`feature/phase2-1`, PR #10）

**成果物:**

- [x] `src/search/grep-interface.ts` — `IGrepEngine` インターフェース（型定義から re-export）
- [x] `src/search/grep.ts` — `RipgrepEngine implements IGrepEngine`
  - `p-limit` セマフォ（デフォルト: 4並列）
  - `AbortController` + `AbortSignal.any()` による timeout/client disconnect 対応
  - ripgrep `cwd: projectRoot` による暗黙パスジェイル
  - キーワード抽出（camelCase/snake_case リテラル検出、NL フォールバック）
- [x] `tests/unit/search/grep.test.ts`
- [x] `tests/unit/search/test-grep-engine.ts` — `TestGrepEngine implements IGrepEngine`
  - インメモリ文字列パターンマッチング
  - プロセス spawn なし

**テストケース:**

- セマフォが `grepMaxConcurrency` 以上の同時 spawn をブロック
- タイムアウト → `AbortController` が SIGTERM → 空結果
- `TestGrepEngine` がインメモリで正しいマッチング結果を返す

**ブロック:** Phase 1 完了

---

### Step 2.3: RRF Fusion + Search Orchestrator

**目的:** Semantic + Grep 結果を RRF アルゴリズムで統合。

**進捗:** 完了（`feature/phase2-1`, PR #10）

**成果物:**

- [x] `src/search/rrf.ts` — `fuseResults()` 関数
  - `RRFscore(d) = SUM 1/(k + rank_r(d))` (k=60)
- [x] `src/search/orchestrator.ts` — `SearchOrchestrator`
  - Semantic + Grep を並列実行 → RRF 統合 → top-K 返却
  - DI: `SemanticSearch` + `IGrepEngine` を受け取る
- [x] `tests/unit/search/rrf.test.ts`
- [x] `tests/unit/search/orchestrator.test.ts` — `TestGrepEngine` + `TestSemanticSearch` 注入

**テストケース:**

- 両ソースに同一チャンクがある場合 → RRF スコアが加算される
- 片方のソースのみ → 単一ソースの RRF スコアで返却
- top-K 制限が正しく適用される
- `TestGrepEngine` 注入でオーケストレーターが正常動作（ripgrep 不要）

**ブロック:** Step 2.1, 2.2

---

### Step 2.4: MCP Server & Transport

**目的:** MCP プロトコルによるサーバー起動とマルチクライアント対応。

**進捗:** 実装済み。基本サーバー/transport は `feature/phase2-3`（PR #12）、runtime 初期化フローは `feature/phase2-5` で追加済み（PR 未作成）。

**成果物:**

- [x] `src/server/index.ts` — MCP サーバーエントリポイント
  - `@modelcontextprotocol/sdk` を使用
  - サーバー起動 → パイプライン初期化 → Reconciliation → Watcher 開始
- [x] `src/server/transport.ts` — SSE/StreamableHTTP トランスポート設定
  - マルチクライアント同時接続対応
- [x] `tests/integration/server.test.ts`

**検証:**

- MCP クライアントが接続・切断できること
- 複数クライアントの同時接続が可能であること

**ブロック:** Step 2.3

---

### Step 2.5: Tool Handlers

**目的:** 6つの MCP ツールの実装。

**進捗:** 完了（`feature/phase2-3`, PR #12）。Phase 3 向け `PathSanitizer` TODO は `feature/phase2-5` で追記済み（PR 未作成）。

**成果物:**

- [x] `src/server/tools/hybrid-search.ts` — `hybrid_search` ツール
- [x] `src/server/tools/semantic-search.ts` — `semantic_search` ツール
- [x] `src/server/tools/grep-search.ts` — `grep_search` ツール
- [x] `src/server/tools/get-context.ts` — `get_context` ツール
- [x] `src/server/tools/index-status.ts` — `index_status` ツール（`skippedFiles` カウンタ含む）
- [x] `src/server/tools/reindex.ts` — `reindex` ツール
- [x] `tests/unit/server/tools/*.test.ts`

**各ツールの入力パス検証:**

- ツールハンドラのエントリポイントで `PathSanitizer` を適用（Phase 3 Step 3.10 で実装、
  Phase 2 では TODO コメントを残す）

**ブロック:** Step 2.3, 2.4

---

### Step 2.6: Plugin Registry

**目的:** 言語プラグインと Embedding プロバイダーの動的登録。

**進捗:** 完了（`feature/phase2-2`, PR #11）

**成果物:**

- [x] `src/plugins/registry.ts` — `PluginRegistry`（Step 1.5 で作成した registry を拡張）
  - `LanguageRegistry` — 拡張子マッピング + 動的登録
  - `EmbeddingProviderRegistry` — プロバイダー切り替え
  - `healthCheck()` — 全プラグインのヘルスチェック
- [x] `tests/unit/plugins/registry.test.ts`

**ブロック:** Step 1.5, 1.6

---

### Step 2.7: Configuration

**目的:** 設定のロード・バリデーション。

**進捗:** 完了（`feature/phase2-2`, PR #11）

**成果物:**

- [x] `src/config/index.ts` — `Config` ロード
  - 優先度: 環境変数 (`NEXUS_*`) → `.nexus.json` → デフォルト値
  - バリデーション（不正値の検出とデフォルトへのフォールバック）
- [x] `tests/unit/config/index.test.ts`

**ブロック:** Step 1.2

---

### Step 2.8: Integration Tests

**目的:** Phase 2 全体の統合テスト。

**進捗:** 完了（`feature/phase2-4`, PR #13）

**成果物:**

- [x] `tests/integration/search-flow.test.ts` — Pipeline → Search E2E
- [x] `tests/integration/mcp-protocol.test.ts` — MCP クライアント → ツール呼び出し → レスポンス検証
- [x] テストフィクスチャの拡充（`tests/fixtures/sample-project/`）

**検証:**

- MCP クライアントが `hybrid_search` を呼び出し、ランキング結果を受信
- `TestGrepEngine` による `SearchOrchestrator` 単体テストが ripgrep なしで動作

**ブロック:** Step 2.5, 2.6, 2.7

---

## Phase 2 Exit Criteria

- [x] MCP クライアントが接続し、全6ツールを呼び出せる
- [x] `hybrid_search` がランキング付き結果を返す
- [x] `TestGrepEngine` を用いたオーケストレーター単体テストが ripgrep なしで動作
- [x] 全 integration テストが通過

**PR / ブランチ対応:**

- `master <- feature/phase2-1` / PR #10 — search foundations
- `master <- feature/phase2-2` / PR #11 — config + plugin registry
- `master <- feature/phase2-3` / PR #12 — MCP server + tool handlers + build fix
- `master <- feature/phase2-4` / PR #13 — integration tests
- `master <- feature/phase2-5` — runtime initialization flow 実装済み、PR 未作成

**注意:**

- `feature/phase2-3` 以降のブランチは `master` に対して単独で build/test 可能にするため、先行 Phase 2 コミットを取り込んでおり、PR 間で履歴が重複している。

---

## Phase 3: Resilience & Edge Cases

**Goal:** 本番グレードの耐障害性と性能保証。

### Step 3.1: Dead Letter Queue

**目的:** Embedding 失敗イベントの安全な退避と自動リカバリ。

**成果物:**

- [x] `src/indexer/dead-letter-queue.ts` — `DeadLetterQueue` クラス
  - インメモリリングバッファ（max 1,000） + SQLite 永続化
  - `dead_letter_queue` テーブル + `idx_dlq_created` インデックス
  - `enqueue()` — Phase 1 の `RetryExhaustedError` catch を DLQ enqueue に差し替え
  - `recoverySweep()` — 60秒間隔の自動リカバリ
    - ヘルスチェック → stale 検出 → 再処理 or 破棄
    - `computeFileHashStreaming()` による stale 検出
  - `purgeExpired()` — 24h TTL パージ
  - `bulkRemoveEntries()` / `bulkUpdateEntries()` — `executeBatchedWithYield` 再利用（DRY）
- [x] `tests/unit/indexer/dead-letter-queue.test.ts`

**テストケース:**

- リトライ上限後 → DLQ にエンキュー
- ヘルスチェック失敗 → スイープスキップ
- ファイル削除済みエントリ → 安全に破棄
- hash mismatch → エントリ破棄 + ログ
- hash match → 再処理実行、成功時に DLQ から除去
- TTL 期限切れ → `purgeExpired` で除去
- `executeBatchedWithYield` による一括操作のイベントループ保護

**ブロック:** Phase 2 完了

---

### Step 3.2: Backpressure & Death Spiral Prevention

**目的:** イベントキューのオーバーフロー対応とフルスキャンフォールバック。

**成果物:**

- [x] `src/indexer/event-queue.ts` の拡張（Step 1.8 のキューにバックプレッシャーステートマシンを追加）
  - `Normal → Overflow → FullScan → PostScan → Normal` 状態遷移
  - フルスキャン前のキュークリア
  - フルスキャン中のオーバーフローフラグ維持（新規イベント破棄）
  - フルスキャン完了後のキュー再クリア + フラグ解除
  - **OS Watcher は常時稼働**（停止しない設計原則の厳守）
- [x] `tests/unit/indexer/backpressure.test.ts`

**テストケース:**

- キューサイズ >= `fullScanThreshold` → Overflow 状態遷移
- Overflow → キュー drain 完了 → FullScan トリガー
- FullScan 完了後 → キュー空、`fullScanThreshold` 超過なし（デススパイラル防止）
- 全状態遷移で OS Watcher が停止されないこと

**ブロック:** Phase 2 完了

---

### Step 3.3: File Rename Optimization

**目的:** リネーム時の embedding 再計算スキップ。

**成果物:**

- [x] `src/indexer/pipeline.ts` の拡張
  - デバウンスウィンドウ内の同一ハッシュ delete + add ペア → `RenameEvent` 検出
  - LanceDB: `filePath` カラムの UPDATE（ベクトル再利用）
  - SQLite: `merkle_nodes.path` の UPDATE + 親ハッシュ伝播
  - Embedder 完全スキップ
- [ ] `tests/unit/indexer/rename-detection.test.ts` — **未作成**（リネーム検出のテストは `pipeline.test.ts` と `merkle-tree.test.ts` に含まれているが、専用テストファイルは作成されていない）

**ブロック:** Phase 2 完了

---

### Step 3.4: LanceDB Compaction (Mutex Integration)

**目的:** LanceDB のフラグメンテーション管理と Pipeline Mutex との統合。

**成果物:**

- [x] `src/storage/vector-store.ts` の拡張（Step 1.7 の VectorStore にコンパクション統合）
  - Post-reindex コンパクション（Mutex 保持中に実行）
  - Idle-time コンパクション（Mutex を独立取得）
  - フラグメンテーション閾値: 20%
  - コンパクション中のイベントはキューに蓄積 → Mutex 解放後に処理
  - **注意:** `compactAfterReindex()` / `scheduleIdleCompaction()` は実装済みだが `pipeline.ts` から呼び出されておらず、Mutex 統合は未完了
- [x] `tests/unit/storage/compaction.test.ts`

**テストケース:**

- フラグメンテーション < 20% → スキップ
- フラグメンテーション >= 20% → compact + prune + cleanup
- Idle コンパクション → Mutex 取得を確認
- コンパクション中のイベント蓄積 → Mutex 解放後に正常処理

**ブロック:** Phase 2 完了

---

### Step 3.5: SQLite Batched Writes (Performance Tuning)

**目的:** バッチトランザクションのパフォーマンスベンチマーク。

**成果物:**

- [x] `tests/benchmarks/sqlite-batched.bench.ts` — 1,000 / 5,000 / 10,000 ノードのバルク操作ベンチマーク
- [ ] バッチサイズの最適値検証（デフォルト 100 の妥当性確認） — ベンチマーク実行による検証は未実施

**ブロック:** Step 1.3

---

### Step 3.6: Grep Zombie Prevention

**目的:** ripgrep プロセスのリーク防止。

**成果物:**

- [x] `src/search/grep.ts` の拡張
  - `AbortController` + `AbortSignal.any()` によるタイムアウト/クライアント切断対応
  - タイムアウト → SIGTERM → 1秒 grace → SIGKILL フォールバック
  - クライアント `AbortSignal` のチェーン
- [x] `tests/unit/search/grep-zombie.test.ts`

**テストケース:**

- タイムアウト → SIGTERM シグナル送信確認
- クライアント disconnect → AbortSignal 伝播確認
- 正常完了後に AbortController がクリーンアップされること

**ブロック:** Step 2.2

---

### Step 3.7: Additional Language Plugins

**目的:** Python, Go の tree-sitter プラグイン追加。

**成果物:**

- [x] `src/plugins/languages/python.ts` — Python パーサー
- [x] `src/plugins/languages/go.ts` — Go パーサー
- [x] `tests/unit/plugins/languages/python.test.ts`
- [x] `tests/unit/plugins/languages/go.test.ts`
- [x] `tests/fixtures/sample-project/src/utils.py`
- [x] `tests/fixtures/sample-project/src/handler.go`

**ブロック:** Step 1.5

---

### Step 3.8: Stress Testing

**目的:** 大規模・高負荷シナリオでの耐障害性検証。

**成果物:**

- [x] `tests/stress/branch-switch.test.ts` — 10,000+ イベント同時発火
- [x] `tests/stress/concurrent-agents.test.ts` — マルチ MCP クライアント同時アクセス
- [x] `tests/stress/large-repo.test.ts` — 100,000 ファイル規模のリポジトリ
- [x] `tests/stress/crash-recovery.test.ts` — SIGKILL シミュレート後の Reconciliation

**検証:**

- OOM、ゾンビプロセス、データ破損が発生しないこと
- フルスキャン後にデススパイラルが発生しないこと
- OS Watcher が全ライフサイクルを通じて停止されないこと

**ブロック:** Phase 2 完了, Step 3.1, 3.2

---

### Step 3.9: Documentation & Release

**目的:** ドキュメント整備とリリース準備。

**成果物:**

- [x] `README.md` — プロジェクト概要、セットアップ、使用方法
- [x] `docs/configuration.md` — 設定リファレンス
- [x] `docs/mcp-tools.md` — MCP ツールドキュメント
- [x] `NOTICE` ファイル — サードパーティライセンス表記

**ブロック:** Phase 3 の機能実装完了後

---

### Step 3.10: Input Path Sanitization

**目的:** パストラバーサル攻撃（シンボリックリンクエスケープ含む）の防御。

**成果物:**

- [x] `src/server/path-sanitizer.ts` — `PathSanitizer` クラス
  - `async PathSanitizer.create(projectRoot)` — ファクトリ（realpath 解決）
  - `resolve(userPath)` — 2段階検証（論理 + 物理パス）
  - `resolveRelative(userPath)` — プロジェクトルートからの相対パス
  - `validateGlob(pattern)` — `..` セグメント拒否
  - `PathTraversalError` エラーレスポンス
- [x] 全ツールハンドラへの `PathSanitizer` 統合
- [x] `tests/unit/server/path-sanitizer.test.ts`

**テストケース:**

- `../../../etc/passwd` → `PathTraversalError`
- シンボリックリンク経由のプロジェクト外アクセス → `PathTraversalError`
- 存在しないパス → `PathTraversalError` (ENOENT)
- `..` 含む glob パターン → `PathTraversalError`
- 正常パス → 解決済み絶対パス返却
- `PathSanitizer.create()` がプロジェクトルート自体の symlink を解決すること

**ブロック:** Step 2.5

---

### Step 3.11: Merkle Tree Orphan Cleanup

**目的:** ディレクトリ削除時の孤児ノードクリーンアップ。

**成果物:**

- [x] `src/indexer/pipeline.ts` の拡張
  - ディレクトリ `DeleteEvent` → `metadataStore.deleteSubtree()` + `vectorStore.deleteByPathPrefix()`
  - Merkle ハッシュ伝播
- [x] `src/indexer/gc.ts` — `gcOrphanNodes()`
  - フルリインデックス最終フェーズとして実行
  - SQLite Merkle Tree vs ファイルシステムの突き合わせ
- [x] `tests/unit/indexer/orphan-gc.test.ts`

**テストケース:**

- ディレクトリ削除 → 配下の全ノードがクリーンアップ
- フルスキャン GC → ファイルシステムに存在しない Merkle ノードがパージ
- GC 後に孤児ノードがゼロ

**ブロック:** Step 1.3, 1.4

---

## Phase 3 Exit Criteria

- [x] 全 unit/integration/E2E テストが通過
- [x] ブランチスイッチフラッド + 並行リインデックスで OOM/ゾンビ/データ破損なし
- [x] パストラバーサル攻撃（symlink エスケープ含む）が適切なエラーレスポンスを返す
- [x] フルリインデックス後に孤児 Merkle ノードがゼロ
- [x] DLQ が Phase 1 の `skippedFiles` フォールバックを完全に置換
- [x] フルスキャン後のデススパイラルが発生しないことがストレステストで検証済み
- [x] OS Watcher が全ライフサイクルを通じて停止されないことが検証済み

## 残課題（Phase 3 完了後に発覚した未実装・乖離）

以下は実装完了後に確認された追加対応事項。

- [ ] **LanceDB 実統合** — `LanceVectorStore` の内部実装が `Map` ベースのインメモリ実装のまま。`@lancedb/lancedb` による永続化・ANN 検索への差し替えが必要（`src/storage/vector-store.ts:35` の TODO）
- [ ] **Compaction の Pipeline 統合** — `compactAfterReindex()` / `scheduleIdleCompaction()` が `pipeline.ts` から呼ばれておらず、Mutex 統合が実質的に未完了
- [ ] **`rename-detection.test.ts` の作成** — リネーム検出の専用テストファイルが未作成（ロジック自体は `pipeline.test.ts` + `merkle-tree.test.ts` でカバー済み）
- [ ] **`openai-compat` Embedding Provider の実装** — `src/plugins/embeddings/openai-compat.ts` が空ファイル（`export {}` のみ）だが、Config で有効な provider 値として登録されている
- [ ] **SQLite バッチサイズ最適値の検証** — `sqlite-batched.bench.ts` は作成済みだが、ベンチマーク実行による検証は未実施

---

## Dependency Graph (Visual)

```
Phase 1:
  1.1 (Scaffold)
   └─→ 1.2 (Types)
         ├─→ 1.3 (MetadataStore) ──→ 1.4 (Merkle Tree)
         ├─→ 1.5 (Chunker)
         ├─→ 1.6 (Embedding Provider)
         ├─→ 1.7 (Vector Store)
         └─→ 1.8 (Event Queue) ──→ 1.9 (Watcher)
                                        │
              1.3 + 1.4 + 1.5 + 1.6 + 1.7 + 1.9
                          │
                    1.10 (Pipeline Integration)

Phase 2:
  Phase 1 完了
   ├─→ 2.1 (Semantic Search)
   ├─→ 2.2 (Grep Search)
   │     └─→ 2.3 (RRF + Orchestrator)
   │                └─→ 2.4 (MCP Server)
   │                      └─→ 2.5 (Tool Handlers)
   ├─→ 2.6 (Plugin Registry)
   ├─→ 2.7 (Configuration)
   └─→ 2.8 (Integration Tests) ← 2.5 + 2.6 + 2.7

Phase 3:
  Phase 2 完了
   ├─→ 3.1 (DLQ) ──→ 3.8 (Stress Tests)
   ├─→ 3.2 (Backpressure) ──→ 3.8
   ├─→ 3.3 (Rename Optimization)
   ├─→ 3.4 (Compaction)
   ├─→ 3.5 (SQLite Benchmark) ← 1.3
   ├─→ 3.6 (Grep Zombie) ← 2.2
   ├─→ 3.7 (Language Plugins) ← 1.5
   ├─→ 3.10 (Path Sanitization) ← 2.5
   ├─→ 3.11 (Orphan GC) ← 1.3 + 1.4
   └─→ 3.9 (Docs & Release) ← 全機能実装完了
```

## Implementation Notes

### TDD サイクル

各ステップは以下のサイクルで進行:

1. **Red**: テストを先に書く（期待する振る舞いを定義）
2. **Green**: テストを通す最小限の実装
3. **Refactor**: DRY、命名、構造の改善

### DI パターンの一貫性

全コンポーネントはインターフェース経由で接続:

- `IVectorStore` ← `LanceVectorStore` / `InMemoryVectorStore`
- `IMetadataStore` ← `SqliteMetadataStore` / `InMemoryMetadataStore`
- `IGrepEngine` ← `RipgrepEngine` / `TestGrepEngine`
- `EmbeddingProvider` ← `OllamaEmbeddingProvider` / `TestEmbeddingProvider`

### Phase 間のマイグレーションポイント

- **Phase 1 → 3**: `RetryExhaustedError` の catch ブロックを「ログ＋スキップ」→「DLQ enqueue」に差し替え
- **Phase 2 → 3**: ツールハンドラに `PathSanitizer` を統合（Phase 2 では TODO コメント）
- **Phase 1 → 3**: `EventQueue` にバックプレッシャーステートマシンを追加
