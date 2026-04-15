# Nexus Observability Dashboard 設計書

## 概要

Nexus（ローカル MCP サーバー）の内部状態をリアルタイムに可視化するための
Observability 機能を 2 フェーズで実装する。

- **Phase 1**: メトリクス収集基盤 + HTTP エンドポイント
- **Phase 2**: Terminal UI (TUI) ダッシュボード

### 目的

バックグラウンドで非同期実行されるインデックス処理・EventQueue のバック
プレッシャー・DLQ の状態をリアルタイムに把握し、問題の早期発見と運用品質
の向上を実現する。

### 設計原則

1. **パフォーマンスの保護**: メトリクス収集はインメモリ同期操作のみ。I/O なし
2. **疎結合**: コアモジュールへの変更は optional コールバックの追加のみ
3. **Zero-Config**: Prometheus サーバー不要で TUI 単体動作可能
4. **既存パターン踏襲**: `onProgress` / `onFullScanRequired` と同じコールバック注入パターン

---

## アーキテクチャ

### レイヤー構成

```text
┌─────────────────── Nexus MCP Process ──────────────────────────┐
│                                                                 │
│  ┌─── Core Modules ───┐    ┌─── Observability Layer ────────┐  │
│  │                     │    │                                │  │
│  │  EventQueue         │──callback──▶ MetricsCollector       │  │
│  │  IndexPipeline      │──callback──▶   (prom-client wrap)   │  │
│  │  DeadLetterQueue    │──callback──▶       │                │  │
│  │                     │    │               ▼                │  │
│  └─────────────────────┘    │        prom-client Registry    │  │
│                             │               │                │  │
│                             │    ┌──────────▼────────────┐   │  │
│                             │    │  MetricsHttpServer     │   │  │
│                             │    │  (node:http)           │   │  │
│                             │    │  :9464                 │   │  │
│                             │    │  GET /metrics (text)   │   │  │
│                             │    │  GET /metrics/json     │   │  │
│                             │    │  GET /health           │   │  │
│                             │    └────────────────────────┘   │  │
│                             └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                        ▲
                                        │ HTTP polling (2s)
                              ┌─────────┴──────────┐
                              │  nexus dashboard    │
                              │  (ink TUI, 別途起動) │
                              └────────────────────┘
```

### データフロー（時系列）

1. **起動時**: `NexusServerFactory.createRuntime()` 内で `MetricsCollector` を生成
2. **コールバック注入**: 各コアモジュールの `options` に MetricsCollector の
   コールバック関数を渡す
3. **イベント発生時**: コアモジュールがコールバックを fire-and-forget で呼ぶ
   （async 不要、同期的にカウンター更新）
4. **HTTP サーバー起動**: MCP ランタイム初期化と同時に `node:http` サーバーを起動
5. **TUI 接続**: 別ターミナルで `nexus dashboard` を実行し `/metrics/json` を
   ポーリング

### ホスティング戦略

メトリクス HTTP サーバーは既存 MCP プロセス内で共存する。Nexus はシングル
プロセス MCP サーバーであり、メトリクスは軽量な読み取り専用エンドポイントの
ため、プロセス内共存が最もオーバーヘッドが少なく、内部状態へのアクセスも自然。

### ポート設定

- デフォルト: `9464`（Prometheus exporter ポート帯）
- 環境変数 `NEXUS_METRICS_PORT` でオーバーライド可能
- TUI 側も同じ環境変数または CLI 引数 `--port` で指定

---

## Phase 1: メトリクス収集基盤

### MetricsHooks インターフェース

コアモジュールに注入するコールバック群の型定義。すべて `void` 返却・同期的。

```typescript
// src/observability/types.ts
import type { BackpressureState } from '../indexer/event-queue.js';

export interface MetricsHooks {
  /** EventQueue の enqueue/drain 完了時に呼ばれる */
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number): void;

  /** Pipeline.processEvents() 完了時に呼ばれる */
  onChunksIndexed(count: number): void;

  /** Pipeline.reindex() 成功時に呼ばれる */
  onReindexComplete(durationMs: number, fullRebuild: boolean): void;

  /** DLQ のエントリ数変動時に呼ばれる */
  onDlqSnapshot(size: number): void;

  /** DLQ.recoverySweep() 完了時に呼ばれる */
  onRecoverySweepComplete(retried: number, purged: number, skipped: number): void;
}
```

### メトリクス定義一覧

| メトリクス名 | 種別 | ラベル | ソース |
|---|---|---|---|
| `nexus_event_queue_size` | Gauge | — | EventQueue.size() |
| `nexus_event_queue_state` | Gauge | `state` (normal/overflow/full_scan) | EventQueue.getState() ※ 現在の state のみ値 1、他は 0 |
| `nexus_event_queue_dropped_total` | Counter | — | EventQueue.getDroppedEventCount() |
| `nexus_indexing_chunks_total` | Counter | — | Pipeline.processEvents() |
| `nexus_reindex_duration_seconds` | Histogram | `full_rebuild` (true/false) | Pipeline.reindex() |
| `nexus_dlq_size` | Gauge | — | DLQ.snapshot().size |
| `nexus_dlq_recovery_total` | Counter | `result` (retried/purged/skipped) | DLQ.recoverySweep() |

### MetricsCollector 実装方針

- `prom-client` をラップした薄いアダプタークラス
- `MetricsHooks` インターフェースを実装
- コンストラクタで `prom-client.Registry` を受け取る（テスト時にカスタム
  Registry を注入可能）
- デフォルトは `prom-client.register`（グローバル Registry）を使用
- `nexus_reindex_duration_seconds` の Histogram バケット:
  `[0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]`（秒単位）

### コアモジュールへのフック注入

各コアモジュールの `options` インターフェースに `metricsHooks?` を追加する。

#### EventQueue

```typescript
export interface EventQueueOptions {
  // ...existing fields...
  metricsHooks?: Pick<MetricsHooks, 'onQueueSnapshot'>;
}
```

**発火ポイント**（末尾に 1 行追加）:

- `enqueue()` 完了後
- `drain()` 完了後

```typescript
this.options.metricsHooks?.onQueueSnapshot(
  this.size(), this.state, this.droppedEventCount
);
```

#### IndexPipeline

```typescript
interface IndexPipelineOptions {
  // ...existing fields...
  metricsHooks?: Pick<MetricsHooks, 'onChunksIndexed' | 'onReindexComplete'>;
}
```

**発火ポイント**:

- `processEvents()` の return 直前:

  ```typescript
  this.options.metricsHooks?.onChunksIndexed(chunksIndexed);
  ```

- `reindex()` の成功パス、result 構築後:

  ```typescript
  this.options.metricsHooks?.onReindexComplete(durationMs, !!fullRebuild);
  ```

#### DeadLetterQueue

```typescript
export interface DeadLetterQueueOptions {
  // ...existing fields...
  metricsHooks?: Pick<MetricsHooks, 'onDlqSnapshot' | 'onRecoverySweepComplete'>;
}
```

**発火ポイント**:

- `enqueue()` 完了後:

  ```typescript
  this.options.metricsHooks?.onDlqSnapshot(this.entries.size);
  ```

- `recoverySweep()` の finally 直前:

  ```typescript
  this.options.metricsHooks?.onRecoverySweepComplete(retried, purged, skipped);
  ```

- `removeByFilePath()` / `removeByPathPrefix()` 完了後:

  ```typescript
  this.options.metricsHooks?.onDlqSnapshot(this.entries.size);
  ```

### 影響範囲

- 既存テストへの影響: **なし**（`metricsHooks` は optional）
- 既存インターフェース `IIndexPipeline` への影響: **なし**（hooks は内部
  options にのみ追加）
- 各モジュールへの追加行数: **1 〜 3 行 / 発火ポイント**

### MetricsHttpServer

- **実装**: `node:http` のみ（フレームワーク不要）
- **エンドポイント**:
  - `GET /metrics` → `register.metrics()` (text/plain; Prometheus 形式)
  - `GET /metrics/json` → `register.getMetricsAsJSON()` (application/json)
  - `GET /health` → `{ "status": "ok" }` (application/json)
  - その他 → 404
- **ライフサイクル**: `start(port): Promise<void>` / `stop(): Promise<void>`
- **エラー処理**: `EADDRINUSE` 時は警告ログのみ。MCP サーバー本体には影響なし
- **シャットダウン**: `NexusRuntime.close()` のシャットダウンチェーンに組み込む

---

## Phase 2: TUI ダッシュボード

### CLI エントリポイント

```text
nexus dashboard [--port 9464] [--interval 2000]
```

- 現在の `src/bin/nexus.ts` の `parseArgs` にサブコマンド分岐を追加
- `dashboard` サブコマンド時は MCP サーバーを起動せず、ink TUI のみ起動
- TUI は HTTP クライアントとして `/metrics/json` をポーリング

### TUI レイアウト（3 パネル構成）

```text
┌─ Nexus Dashboard ──────────────────────────────────┐
│                                                     │
│  ┌─ Event Queue ─────────────────────────────────┐  │
│  │ State: normal   Size: 42   Dropped: 0         │  │
│  │ ████████░░░░░░░░░░░░  42/10000                │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ Indexing Throughput ─────────────────────────┐  │
│  │ Chunks indexed: 15,234 (total)                │  │
│  │ Last reindex: 1,204ms (full: no)              │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ DLQ Health ──────────────────────────────────┐  │
│  │ Pending: 3   Retried: 12   Purged: 5          │  │
│  │ Status: ● Healthy                             │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  Connected to localhost:9464 | Refresh: 2s | q:quit │
└─────────────────────────────────────────────────────┘
```

### コンポーネント構成

- **App (app.tsx)**: ルートコンポーネント。ヘッダー・フッター・パネル配置
- **QueuePanel**: Event Queue の状態表示。プログレスバー付き
- **ThroughputPanel**: チャンク処理数・最終 reindex 情報
- **DlqPanel**: DLQ 滞留数・リカバリ統計・ヘルスステータス
- **useMetrics hook**: `setInterval` + `fetch` によるポーリング。
  接続エラー時もクラッシュせずリトライ

### 接続フォールバック

- MCP サーバー未起動時: 「Connecting to localhost:9464...」を表示しリトライ
- サーバーが `/metrics/json` を返さない場合: 「Waiting for metrics...」
- `q` キーまたは `Ctrl+C` で安全に終了

---

## ファイル構成

```text
src/
├── observability/
│   ├── types.ts              # MetricsHooks インターフェース
│   ├── metrics-collector.ts  # prom-client ラッパー（MetricsHooks 実装）
│   └── metrics-server.ts     # node:http エンドポイント
├── dashboard/
│   ├── cli.ts                # TUI エントリポイント
│   ├── app.tsx               # ink ルートコンポーネント
│   ├── components/
│   │   ├── queue-panel.tsx    # Event Queue パネル
│   │   ├── throughput-panel.tsx # Indexing Throughput パネル
│   │   └── dlq-panel.tsx     # DLQ Health パネル
│   └── hooks/
│       └── use-metrics.ts    # ポーリングカスタムフック
├── indexer/
│   ├── event-queue.ts        # (変更) metricsHooks 追加
│   ├── pipeline.ts           # (変更) metricsHooks 追加
│   └── dead-letter-queue.ts  # (変更) metricsHooks 追加
├── server/
│   ├── index.ts              # (変更) MetricsHttpServer の起動/停止
│   └── factory.ts            # (変更) MetricsCollector の生成・注入
└── bin/
    └── nexus.ts              # (変更) dashboard サブコマンド分岐
```

### テストファイル

```text
tests/
├── unit/
│   └── observability/
│       ├── metrics-collector.test.ts  # コールバック→prom-client 変換
│       └── metrics-server.test.ts     # HTTP エンドポイント応答
└── integration/
    └── observability/
        └── metrics-e2e.test.ts        # コアモジュール→HTTP→JSON 一気通貫
```

---

## 新規依存パッケージ

| パッケージ | 用途 | 種別 |
|---|---|---|
| `prom-client` | メトリクス集計 | dependencies |
| `ink` | TUI フレームワーク | dependencies |
| `react` | ink の依存 | dependencies |
| `@types/react` | React 型定義 | devDependencies |

---

## Devcontainer 制約

テスト（`vitest`）および静的解析（`eslint`）は `.devcontainer/devcontainer.json`
に定義されたコンテナ環境内で実行されることを前提とする。

- npm scripts はコンテナ内実行を前提とした設定を提供
- ink/React の JSX トランスパイルは `tsconfig.build.json` に
  `"jsx": "react-jsx"` を追加して対応
- `tsconfig.json` の `include` に `src/dashboard/**/*.tsx` を追加

---

## スコープ外（将来検討）

- Grafana 連携（Prometheus remote write）
- メトリクスの永続化（現状はインメモリのみ）
- TUI のカスタムテーマ / カラースキーム設定
- WebSocket ベースのリアルタイム Push（ポーリングで十分な間は不要）
