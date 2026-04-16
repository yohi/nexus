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
│                             │    │  127.0.0.1:9464        │   │  │
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

- バインドアドレス: `127.0.0.1`（localhost 限定、外部ネットワークからのアクセスを遮断）
- デフォルトポート: `9464`（Prometheus exporter ポート帯）
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
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source?: string): void;

  /** Pipeline.processEvents() 完了時に呼ばれる */
  onChunksIndexed(count: number): void;

  /** Pipeline.reindex() 成功時に呼ばれる */
  onReindexComplete(durationMs: number, fullRebuild: boolean): void;

  /** DLQ のエントリ数変動時に呼ばれる */
  onDlqSnapshot(size: number, source?: string): void;

  /** DLQ.recoverySweep() 完了時に呼ばれる */
  onRecoverySweepComplete(retried: number, purged: number, skipped: number, source?: string): void;
}
```

### メトリクス定義一覧

| メトリクス名 | 種別 | ラベル | ソース |
|---|---|---|---|
| `nexus_event_queue_size` | Gauge | `queue_id` | EventQueue.size() |
| `nexus_event_queue_state` | Gauge | `queue_id`, `state` (normal/overflow/full_scan) | EventQueue.getState() ※ 現在の state のみ値 1、他は 0 |
| `nexus_event_queue_dropped_total` | Counter | `queue_id` | EventQueue.getDroppedEventCount() |
| `nexus_indexing_chunks_total` | Counter | — | Pipeline.processEvents() |
| `nexus_reindex_duration_seconds` | Histogram | `full_rebuild` (true/false) | Pipeline.reindex() |
| `nexus_dlq_size` | Gauge | `dlq_id` | DLQ.snapshot().size |
| `nexus_dlq_recovery_total` | Counter | `dlq_id`, `result` (retried/purged/skipped) | DLQ.recoverySweep() |

### MetricsCollector 実装方針

- `prom-client` をラップした薄いアダプタークラス
- `MetricsHooks` インターフェースを実装
- コンストラクタで `prom-client.Registry` を受け取る（テスト時にカスタム
  Registry を注入可能）
- デフォルトは `prom-client.register`（グローバル Registry）を使用
- `nexus_reindex_duration_seconds` の Histogram バケット:
  `[0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]`（秒単位）
- **`nexus_event_queue_dropped_total` のデルタ計算**:
  `prom-client` の `Counter` は `.inc(amount)` のみ（`.set()` 不可）。
  `onQueueSnapshot` が受け取る `droppedTotal` は `EventQueue.getDroppedEventCount()`
  の累積絶対値のため、MetricsCollector 内部で前回値を保持してデルタを算出する:

  ```typescript
  private readonly prevDroppedBySource = new Map<string, number>();

  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source = 'default'): void {
    const labels = { queue_id: source };
    this.queueSizeGauge.labels(labels).set(size);
    // ...state gauge labels 更新...

    const prevDropped = this.prevDroppedBySource.get(source) ?? 0;
    if (droppedTotal < prevDropped) {
      if (droppedTotal > 0) this.droppedCounter.labels(labels).inc(droppedTotal);
    } else {
      const delta = droppedTotal - prevDropped;
      if (delta > 0) this.droppedCounter.labels(labels).inc(delta);
    }
    this.prevDroppedBySource.set(source, droppedTotal);
  }
  ```

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
- **バインドアドレス**: `127.0.0.1` 固定（セキュリティ要件: ローカルアクセスのみ許可）
- **ライフサイクル**: `start(port): Promise<void>` / `stop(): Promise<void>`
- **エラー処理**: `EADDRINUSE` 時は警告ログのみ。MCP サーバー本体には影響なし
- **シャットダウン**: `NexusRuntime.close()` のシャットダウンチェーンに組み込む

---

## Phase 2: TUI ダッシュボード

### CLI エントリポイント

```text
nexus dashboard [--port 9464] [--interval 2000]
```

- `src/bin/nexus.ts` で `process.argv[2]` を先に検査してサブコマンドを判定する
  （`util.parseArgs` はサブコマンドをネイティブサポートしないため）
- `process.argv[2] === 'dashboard'` の場合は MCP サーバーを起動せず、
  残余の引数（`--port`, `--interval`）を `parseArgs` でパースして ink TUI を起動
- それ以外の場合は従来通り MCP サーバーとして動作
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

### `useMetrics` フックの返却型

```typescript
type MetricsStatus = 'connecting' | 'connected' | 'waiting' | 'reconnecting';

interface UseMetricsResult {
  status: MetricsStatus;
  data: MetricsJSON | null;
  error: string | null;
}
```

| ステータス | 意味 |
|---|---|
| `connecting` | 初回接続試行中（データ未取得） |
| `connected` | 正常にデータ取得済み |
| `waiting` | 接続できたが有効な JSON を受信できない |
| `reconnecting` | 一度成功した後に接続が切れ、再接続試行中。最後に取得した `data` を保持 |

---

## ファイル構成

Nexus コアパッケージ（`@yohi/nexus`）と TUI ダッシュボードパッケージ
（`@yohi/nexus-dashboard`）を npm workspace で分離する。これにより
`ink` / `react` が MCP サーバーのコア `dependencies` に混入することを防ぐ。

```text
# Nexus コアパッケージ
src/
├── observability/
│   ├── types.ts              # MetricsHooks インターフェース
│   ├── metrics-collector.ts  # prom-client ラッパー（MetricsHooks 実装）
│   └── metrics-server.ts     # node:http エンドポイント
├── indexer/
│   ├── event-queue.ts        # (変更) metricsHooks 追加
│   ├── pipeline.ts           # (変更) metricsHooks 追加
│   └── dead-letter-queue.ts  # (変更) metricsHooks 追加
├── server/
│   ├── index.ts              # (変更) MetricsHttpServer の起動/停止
│   └── factory.ts            # (変更) MetricsCollector の生成・注入
└── bin/
    └── nexus.ts              # (変更) dashboard サブコマンド分岐

# TUI ダッシュボードパッケージ (packages/dashboard/)
packages/dashboard/
├── package.json              # ink, react を独自の dependencies として管理
├── tsconfig.json             # jsx: "react-jsx" を含む TUI 用設定
└── src/
    ├── cli.ts                # TUI エントリポイント
    ├── app.tsx               # ink ルートコンポーネント
    ├── components/
    │   ├── queue-panel.tsx    # Event Queue パネル
    │   ├── throughput-panel.tsx # Indexing Throughput パネル
    │   └── dlq-panel.tsx     # DLQ Health パネル
    └── hooks/
        └── use-metrics.ts    # ポーリングカスタムフック
```

### テストファイル

```text
# Nexus コアパッケージ
tests/
├── unit/
│   └── observability/
│       ├── metrics-collector.test.ts  # コールバック→prom-client 変換
│       └── metrics-server.test.ts     # HTTP エンドポイント応答・ポート競合
└── integration/
    └── observability/
        └── metrics-e2e.test.ts        # コアモジュール→HTTP→JSON 一気通貫

# TUI ダッシュボードパッケージ (packages/dashboard/)
packages/dashboard/tests/
└── unit/
    └── use-metrics.test.ts            # ポーリングフック・接続フォールバック
```

#### Unit: metrics-collector.test.ts

コールバック呼び出しが prom-client のメトリクスへ正しく変換されることを検証する。

| テストケース | 入力 | 期待出力 |
|---|---|---|
| onQueueSnapshot で Gauge が更新される | `onQueueSnapshot(42, 'normal', 0)` | `nexus_event_queue_size` = 42, `nexus_event_queue_state{state="normal"}` = 1, 他の state ラベル = 0 |
| onQueueSnapshot で dropped Counter が累積する | `onQueueSnapshot(10, 'overflow', 3)` → `onQueueSnapshot(10, 'overflow', 7)` | `nexus_event_queue_dropped_total` = 7（MetricsCollector がデルタ 4 を計算して `.inc(4)` を呼び出す） |
| 急激な Queue サイズ変動に追従する | `onQueueSnapshot(0, 'normal', 0)` → `onQueueSnapshot(10000, 'full_scan', 500)` | Gauge が 0 → 10000 に即時反映。state ラベルが `full_scan` = 1 に切り替わり、`normal` = 0 |
| state の高速遷移を正確に追跡する | `normal` → `overflow` → `full_scan` → `normal` を連続呼び出し | 各呼び出し後に対応する state のみ値 1、他は 0 |
| onChunksIndexed で Counter が加算される | `onChunksIndexed(100)` × 3 回 | `nexus_indexing_chunks_total` = 300 |
| onChunksIndexed にゼロを渡しても安全 | `onChunksIndexed(0)` | Counter 値は変化なし、例外なし |
| onReindexComplete で Histogram にサンプルが記録される | `onReindexComplete(1204, false)` | `nexus_reindex_duration_seconds{full_rebuild="false"}` の count = 1, sum ≈ 1.204 |
| onReindexComplete の極端な duration | `onReindexComplete(0.5, true)` (0.5ms), `onReindexComplete(180000, true)` (3 分) | Histogram に正常記録。0.5ms → 0.0005s は最小バケット (0.1) 以下に分類。180s は最大バケット (120) 超に分類 |
| onDlqSnapshot で Gauge が更新される | `onDlqSnapshot(3)` → `onDlqSnapshot(0)` | `nexus_dlq_size` が 3 → 0 に変化 |
| onRecoverySweepComplete で Counter が加算される | `onRecoverySweepComplete(5, 2, 1)` | `nexus_dlq_recovery_total{result="retried"}` = 5, `{result="purged"}` = 2, `{result="skipped"}` = 1 |
| カスタム Registry を注入できる | コンストラクタに新規 Registry を渡す | デフォルト Registry は汚染されず、カスタム Registry にのみメトリクスが登録される |

#### Unit: metrics-server.test.ts

HTTP エンドポイントの応答内容およびポート競合時の挙動を検証する。

| テストケース | 入力 | 期待出力 |
|---|---|---|
| GET /metrics が Prometheus 形式を返す | `GET /metrics` | ステータス 200, Content-Type: `text/plain`, ボディに `nexus_event_queue_size` を含む |
| GET /metrics/json が JSON 配列を返す | `GET /metrics/json` | ステータス 200, Content-Type: `application/json`, JSON パース可能な配列 |
| GET /health が ok を返す | `GET /health` | ステータス 200, `{ "status": "ok" }` |
| 未定義パスに 404 を返す | `GET /unknown` | ステータス 404 |
| **EADDRINUSE 時に MCP サーバーが継続稼働する** | ポート 9464 を事前に `net.createServer` で占有した状態で `MetricsHttpServer.start()` を呼ぶ | `start()` が reject せず resolve する。警告ログが出力される。`MetricsHttpServer.isListening()` は `false` を返す |
| EADDRINUSE 後もコアモジュールのコールバックが動作する | 上記状態で `onQueueSnapshot()` を呼ぶ | MetricsCollector 内の Gauge が更新される（HTTP サーバーが停止していてもメトリクス収集自体は継続） |
| stop() が未起動状態でも安全 | `start()` 前または EADDRINUSE 後に `stop()` を呼ぶ | 例外なく resolve する |

#### Unit: use-metrics.test.ts

TUI 側のポーリングフックおよび接続フォールバック動作を検証する。
`fetch` をモックし、タイマーは `vi.useFakeTimers()` で制御する。

| テストケース | 入力（fetch モック条件） | 期待出力（hook 返却値） |
|---|---|---|
| サーバー未起動時に接続待機状態を返す | `fetch` が `ECONNREFUSED` で reject | `{ status: 'connecting', data: null, error: 'ECONNREFUSED' }` |
| サーバー起動後に正常データを返す | `fetch` が 200 + JSON を resolve | `{ status: 'connected', data: <MetricsJSON>, error: null }` |
| 非 JSON レスポンス時に待機状態を返す | `fetch` が 200 + `text/plain` を resolve | `{ status: 'waiting', data: null, error: 'Invalid JSON' }` |
| 接続断後にリトライする | 正常応答 → `ECONNREFUSED` → 正常応答 | `connected` → `reconnecting` → `connected` の遷移。`reconnecting` 中も `data` は最後の正常取得値を保持 |
| ポーリング間隔が設定通り | `interval: 2000` を指定 | `setInterval` が 2000ms で呼ばれる |
| クリーンアップ時にタイマーが解除される | hook のアンマウント | `clearInterval` が呼ばれ、以降の fetch は発生しない |
| カスタムポートが URL に反映される | `port: 3000` を指定 | fetch URL が `http://localhost:3000/metrics/json` |

#### Integration: metrics-e2e.test.ts

コアモジュールからメトリクス HTTP エンドポイントまでの一気通貫テスト。
実際の `MetricsCollector` + `MetricsHttpServer` を起動し、ランダム空きポートを
使用してポート競合を回避する。

| テストケース | 入力 | 期待出力 |
|---|---|---|
| EventQueue 操作が /metrics/json に反映される | EventQueue に 50 件 enqueue → drain | `/metrics/json` のレスポンスに `nexus_event_queue_size` が含まれ、drain 後の値が 0 と一致（`nexus_indexing_chunks_total` は Pipeline 操作なしでは更新されないため検証対象外） |
| DLQ 操作が /metrics/json に反映される | DLQ に 3 件 enqueue → recoverySweep 実行 | `/metrics/json` に `nexus_dlq_size` = 0, `nexus_dlq_recovery_total` の各ラベル値が sweep 結果と一致 |
| 極端なメトリクス変動のエンドツーエンド追従 | Queue に 0 → 10000 件を高速 enqueue → 全件 drain → 再度 5000 件 enqueue | 各段階で `/metrics/json` を取得し、`nexus_event_queue_size` が 10000 → 0 → 5000 と正確に追従 |
| ポート競合時もコアモジュール→メトリクス収集は動作する | 指定ポートを事前占有 → MetricsHttpServer.start() → EventQueue 操作 | HTTP サーバーは起動しないが、MetricsCollector 内部の Registry にメトリクスが記録される（`registry.getMetricsAsJSON()` で直接検証） |
| シャットダウンチェーンが正常に完了する | MetricsHttpServer 起動中 → `close()` 呼び出し | HTTP サーバーが停止し、ポートが解放される。再度同じポートで `listen` 可能 |

---

## 新規依存パッケージ

### Nexus コアパッケージ (`@yohi/nexus`)

| パッケージ | 用途 | 種別 |
|---|---|---|
| `prom-client` | メトリクス集計 | dependencies |

### TUI ダッシュボードパッケージ (`@yohi/nexus-dashboard`)

| パッケージ | 用途 | 種別 |
|---|---|---|
| `ink` | TUI フレームワーク | dependencies |
| `react` | ink の依存 | dependencies |
| `@types/react` | React 型定義 | devDependencies |

> **分離の理由**: `ink` / `react` は TUI 描画にのみ使用され、MCP サーバーの
> コア機能に不要。コアの `dependencies` への混入を防ぐため、npm workspace で
> パッケージを分離する。

---

## Devcontainer 制約

テスト（`vitest`）および静的解析（`eslint`）は `.devcontainer/devcontainer.json`
に定義されたコンテナ環境内で実行されることを前提とする。

- npm scripts はコンテナ内実行を前提とした設定を提供
- ink/React の JSX トランスパイルは `packages/dashboard/tsconfig.json` に
  `"jsx": "react-jsx"` を設定（コアパッケージの tsconfig には影響なし）

---

## スコープ外（将来検討）

- Grafana 連携（Prometheus remote write）
- メトリクスの永続化（現状はインメモリのみ）
- TUI のカスタムテーマ / カラースキーム設定
- WebSocket ベースのリアルタイム Push（ポーリングで十分な間は不要）
