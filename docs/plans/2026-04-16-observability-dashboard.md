# Observability Dashboard 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Nexus MCP サーバーの内部状態をリアルタイムに可視化する Observability 機能を実装する（メトリクス収集基盤 + HTTP エンドポイント + TUI ダッシュボード）

**Architecture:** コアモジュール（EventQueue, Pipeline, DLQ）に optional なコールバック（MetricsHooks）を注入し、prom-client で集計。node:http で JSON/Prometheus エンドポイントを公開。TUI は別パッケージ（npm workspace）として ink で実装し、HTTP ポーリングでメトリクスを取得する。

**Tech Stack:** prom-client, node:http, ink, react, vitest

**設計書:** `docs/superpowers/specs/2026-04-15-observability-dashboard-design.md`

---

## PR/ブランチ構成（積み上げ方式）

| PR | ブランチ | ベース | 内容 | 想定差分 |
|---|---|---|---|---|
| PR1 | `feature/observability-types-collector` | `master` | MetricsHooks 型 + MetricsCollector + テスト | ~300 行 |
| PR2 | `feature/observability-core-hooks` | PR1 マージ後 master | コアモジュールへのフック注入 + 既存テスト通過確認 | ~50 行 |
| PR3 | `feature/observability-http-server` | PR2 マージ後 master | MetricsHttpServer + E2E テスト + サーバーライフサイクル統合 | ~400 行 |
| PR4 | `feature/observability-dashboard-tui` | PR3 マージ後 master | TUI ダッシュボードパッケージ + CLI サブコマンド | ~500 行 |

---

## PR1: MetricsHooks 型 + MetricsCollector

### Task 1: MetricsHooks インターフェース定義

**Files:**

- Create: `src/observability/types.ts`

**Step 1: 型定義ファイルを作成**

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

**Step 2: ビルド確認**

Run: `npx tsc --noEmit`
Expected: PASS（型定義のみなので当然通る）

**Step 3: コミット**

```bash
git add src/observability/types.ts
git commit -m "feat(observability): MetricsHooks インターフェースを定義"
```

---

### Task 2: MetricsCollector 実装 — テストを先に書く

**Files:**

- Create: `tests/unit/observability/metrics-collector.test.ts`

**Step 1: テストファイルを作成**

設計書のテストケース表に基づき、以下のテストを記述する:

1. `onQueueSnapshot` で Gauge が更新される
2. `onQueueSnapshot` で dropped Counter が累積する（デルタ計算）
3. 急激な Queue サイズ変動に追従する
4. state の高速遷移を正確に追跡する
5. `onChunksIndexed` で Counter が加算される
6. `onChunksIndexed` にゼロを渡しても安全
7. `onReindexComplete` で Histogram にサンプルが記録される
8. `onReindexComplete` の極端な duration
9. `onDlqSnapshot` で Gauge が更新される
10. `onRecoverySweepComplete` で Counter が加算される
11. カスタム Registry を注入できる

各テストは `prom-client` の `Registry` をテストごとに新規作成し、隔離する。
メトリクス値の取得は `registry.getSingleMetricAsString(name)` または
`registry.getMetricsAsJSON()` を使用する。

**Step 2: テスト実行 → 全て FAIL を確認**

Run: `npx vitest run tests/unit/observability/metrics-collector.test.ts`
Expected: FAIL（MetricsCollector が存在しない）

---

### Task 3: MetricsCollector 実装 — プロダクションコード

**Files:**

- Create: `src/observability/metrics-collector.ts`

**Step 1: prom-client を依存に追加**

Run: `npm install prom-client`

**Step 2: MetricsCollector クラスを実装**

```typescript
// src/observability/metrics-collector.ts
import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import type { MetricsHooks } from './types.js';
import type { BackpressureState } from '../indexer/event-queue.js';

const BACKPRESSURE_STATES: readonly BackpressureState[] = ['normal', 'overflow', 'full_scan'];

const REINDEX_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];

export class MetricsCollector implements MetricsHooks {
  readonly registry: Registry;

  private readonly queueSizeGauge: Gauge;
  private readonly queueStateGauge: Gauge;
  private readonly droppedCounter: Counter;
  private readonly chunksCounter: Counter;
  private readonly reindexHistogram: Histogram;
  private readonly dlqSizeGauge: Gauge;
  private readonly recoveryCounter: Counter;

  private readonly prevDroppedBySource = new Map<string, number>();

  constructor(registry?: Registry) {
    this.registry = registry ?? new Registry();

    this.queueSizeGauge = new Gauge({
      name: 'nexus_queue_size',
      help: 'Current number of events in the queue',
      labelNames: ['queue_id'] as const,
      registers: [this.registry],
    });

    this.queueStateGauge = new Gauge({
      name: 'nexus_queue_state',
      help: 'Current backpressure state (0=idle, 1=active)',
      labelNames: ['queue_id', 'state'] as const,
      registers: [this.registry],
    });

    this.droppedCounter = new Counter({
      name: 'nexus_event_queue_dropped_total',
      help: 'Total dropped events',
      labelNames: ['queue_id'] as const,
      registers: [this.registry],
    });

    this.chunksCounter = new Counter({
      name: 'nexus_indexing_chunks_total',
      help: 'Total chunks indexed',
      registers: [this.registry],
    });

    this.reindexHistogram = new Histogram({
      name: 'nexus_reindex_duration_seconds',
      help: 'Reindex duration in seconds',
      labelNames: ['full_rebuild'] as const,
      buckets: REINDEX_BUCKETS,
      registers: [this.registry],
    });

    this.dlqSizeGauge = new Gauge({
      name: 'nexus_dlq_size',
      help: 'Current number of events in the Dead Letter Queue',
      labelNames: ['dlq_id'] as const,
      registers: [this.registry],
    });

    this.recoveryCounter = new Counter({
      name: 'nexus_dlq_recovery_total',
      help: 'DLQ recovery sweep results',
      labelNames: ['dlq_id', 'result'] as const,
      registers: [this.registry],
    });
  }

  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source = 'default'): void {
    const labels = { queue_id: source };
    this.queueSizeGauge.labels(labels).set(size);
    for (const s of BACKPRESSURE_STATES) {
      this.queueStateGauge.labels({ ...labels, state: s }).set(s === state ? 1 : 0);
    }
    const prevDropped = this.prevDroppedBySource.get(source) ?? 0;
    if (droppedTotal < prevDropped) {
      if (droppedTotal > 0) this.droppedCounter.labels(labels).inc(droppedTotal);
    } else {
      const delta = droppedTotal - prevDropped;
      if (delta > 0) this.droppedCounter.labels(labels).inc(delta);
    }
    this.prevDroppedBySource.set(source, droppedTotal);
  }

  onChunksIndexed(count: number): void {
    if (count > 0) {
      this.chunksCounter.inc(count);
    }
  }

  onReindexComplete(durationMs: number, fullRebuild: boolean): void {
    this.reindexHistogram.labels(String(fullRebuild)).observe(durationMs / 1000);
  }

  onDlqSnapshot(size: number, source = 'default'): void {
    this.dlqSizeGauge.labels({ dlq_id: source }).set(size);
  }

  onRecoverySweepComplete(retried: number, purged: number, skipped: number, source = 'default'): void {
    const labels = { dlq_id: source };
    if (retried > 0) this.recoveryCounter.labels({ ...labels, result: 'retried' }).inc(retried);
    if (purged > 0) this.recoveryCounter.labels({ ...labels, result: 'purged' }).inc(purged);
    if (skipped > 0) this.recoveryCounter.labels({ ...labels, result: 'skipped' }).inc(skipped);
  }
}
```

**Step 3: テスト実行 → 全て PASS を確認**

Run: `npx vitest run tests/unit/observability/metrics-collector.test.ts`
Expected: PASS

**Step 4: lint 確認**

Run: `npm run lint`
Expected: PASS

**Step 5: コミット**

```bash
git add src/observability/metrics-collector.ts tests/unit/observability/metrics-collector.test.ts package.json package-lock.json
git commit -m "feat(observability): MetricsCollector を prom-client ベースで実装"
```

---

### Task 4: PR1 の下書き作成

**Step 1: ブランチ作成・プッシュ**

```bash
git checkout -b feature/observability-types-collector
git push -u origin feature/observability-types-collector
```

**Step 2: Draft PR 作成**

```bash
gh pr create --draft --title "feat(observability): MetricsHooks 型 + MetricsCollector" --body "$(cat <<'EOF'
## Summary

- `MetricsHooks` インターフェースを `src/observability/types.ts` に定義
- `MetricsCollector`（prom-client ラッパー）を実装
- 設計書のテストケース 11 件をすべてカバー

## 関連

- 設計書: `docs/superpowers/specs/2026-04-15-observability-dashboard-design.md`
- 積み上げ PR: **1/4**（次: コアモジュールへのフック注入）

## Test plan

- [ ] `npx vitest run tests/unit/observability/metrics-collector.test.ts` が全件 PASS
- [ ] `npx tsc --noEmit` が PASS
- [ ] `npm run lint` が PASS

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR2: コアモジュールへのフック注入

### Task 5: EventQueue にメトリクスフックを追加

**Files:**

- Modify: `src/indexer/event-queue.ts:7-13` (EventQueueOptions に `metricsHooks?` 追加)
- Modify: `src/indexer/event-queue.ts:110` (enqueue 末尾に発火)
- Modify: `src/indexer/event-queue.ts:248` (drain 末尾に発火)

**Step 1: EventQueueOptions を拡張**

`src/indexer/event-queue.ts:7-13` の `EventQueueOptions` インターフェースに追加:

```typescript
import type { MetricsHooks } from '../observability/types.js';

export interface EventQueueOptions {
  debounceMs: number;
  maxQueueSize: number;
  fullScanThreshold: number;
  concurrency: number;
  onFullScanRequired?: () => Promise<void>;
  metricsHooks?: Pick<MetricsHooks, 'onQueueSnapshot'>;
}
```

**Step 2: enqueue() 末尾に発火ポイントを追加**

`enqueue()` の `return true;`（L110）の直前:

```typescript
this.options.metricsHooks?.onQueueSnapshot(
  this.size(), this.state, this.droppedEventCount, this.options.name
);
```

`return false;` のパス（L49, L88）の直前にも同様に追加（drop 時にも状態通知）。

**Step 3: drain() 末尾に発火ポイントを追加**

`drain()` の `return results;`（L247）の直前:

```typescript
this.options.metricsHooks?.onQueueSnapshot(
  this.size(), this.state, this.droppedEventCount, this.options.name
);
```

**Step 4: 既存テスト通過確認**

Run: `npx vitest run tests/unit/indexer/event-queue.test.ts`
Expected: PASS（`metricsHooks` は optional なので既存テストに影響なし）

**Step 5: コミット**

```bash
git add src/indexer/event-queue.ts
git commit -m "feat(observability): EventQueue に metricsHooks コールバックを注入"
```

---

### Task 6: IndexPipeline にメトリクスフックを追加

**Files:**

- Modify: `src/indexer/pipeline.ts:23-31` (IndexPipelineOptions に `metricsHooks?` 追加)
- Modify: `src/indexer/pipeline.ts:195` (processEvents 末尾に発火)
- Modify: `src/indexer/pipeline.ts:248` (reindex 成功パスに発火)

**Step 1: IndexPipelineOptions を拡張**

```typescript
import type { MetricsHooks } from '../observability/types.js';

interface IndexPipelineOptions {
  // ...existing fields...
  metricsHooks?: Pick<MetricsHooks, 'onChunksIndexed' | 'onReindexComplete'>;
}
```

**Step 2: processEvents() の return 直前に発火**

`src/indexer/pipeline.ts:195` の `return { chunksIndexed };` の直前:

```typescript
this.options.metricsHooks?.onChunksIndexed(chunksIndexed);
```

**Step 3: reindex() の成功パスに発火**

`src/indexer/pipeline.ts` の reindex 内、result オブジェクト構築後（`this.progress.status = 'idle';` の直前、L242 付近）:

```typescript
this.options.metricsHooks?.onReindexComplete(durationMs, !!fullRebuild);
```

**Step 4: 既存テスト通過確認**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts`
Expected: PASS

**Step 5: コミット**

```bash
git add src/indexer/pipeline.ts
git commit -m "feat(observability): IndexPipeline に metricsHooks コールバックを注入"
```

---

### Task 7: DeadLetterQueue にメトリクスフックを追加

**Files:**

- Modify: `src/indexer/dead-letter-queue.ts:12-21` (DeadLetterQueueOptions に `metricsHooks?` 追加)
- Modify: `src/indexer/dead-letter-queue.ts:91` (enqueue 後に発火)
- Modify: `src/indexer/dead-letter-queue.ts:169` (recoverySweep 成功パスに発火)
- Modify: `src/indexer/dead-letter-queue.ts:214` (removeByFilePath 後に発火)
- Modify: `src/indexer/dead-letter-queue.ts:227` (removeByPathPrefix 後に発火)

**Step 1: DeadLetterQueueOptions を拡張**

```typescript
import type { MetricsHooks } from '../observability/types.js';

export interface DeadLetterQueueOptions {
  // ...existing fields...
  metricsHooks?: Pick<MetricsHooks, 'onDlqSnapshot' | 'onRecoverySweepComplete'>;
}
```

**Step 2: 各発火ポイントにコールバックを追加**

- `enqueue()` は内部で `trimToCapacity()` を呼び出すため、通知は `trimToCapacity()` 内で一括して行われる。

- `recoverySweep()` の `return { retried, purged, skipped };`（L169）の直前:

  ```typescript
  this.safeNotifyMetrics((h) => { h.onRecoverySweepComplete(retried, purged, skipped, this.options.name); });
  ```

- `removeByFilePath()` / `removeByPathPrefix()` などの完了後、`safeNotifyMetrics` を経由して通知される（L246, L281 等のロジックと同様に更新）。


**Step 3: 既存テスト通過確認**

Run: `npx vitest run tests/unit/indexer/dead-letter-queue.test.ts`
Expected: PASS

**Step 4: 全テスト通過確認**

Run: `npx vitest run`
Expected: PASS（全件）

**Step 5: コミット**

```bash
git add src/indexer/dead-letter-queue.ts
git commit -m "feat(observability): DeadLetterQueue に metricsHooks コールバックを注入"
```

---

### Task 8: PR2 の下書き作成

**Step 1: ブランチ作成・プッシュ**

```bash
git checkout -b feature/observability-core-hooks
git push -u origin feature/observability-core-hooks
```

**Step 2: Draft PR 作成**

```bash
gh pr create --draft --title "feat(observability): コアモジュールに metricsHooks を注入" --body "$(cat <<'EOF'
## Summary

- `EventQueue`, `IndexPipeline`, `DeadLetterQueue` の Options に `metricsHooks?` を追加
- 各モジュールの適切なポイントでコールバックを fire-and-forget 呼び出し
- 既存テストへの影響なし（optional フィールドのため）

## 関連

- 設計書: `docs/superpowers/specs/2026-04-15-observability-dashboard-design.md`
- 積み上げ PR: **2/4**（前: MetricsHooks 型 + MetricsCollector、次: MetricsHttpServer）

## Test plan

- [ ] `npx vitest run` で全件 PASS（既存テストのリグレッションなし）
- [ ] `npx tsc --noEmit` が PASS
- [ ] `npm run lint` が PASS

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR3: MetricsHttpServer + サーバーライフサイクル統合

### Task 9: MetricsHttpServer テストを先に書く

**Files:**

- Create: `tests/unit/observability/metrics-server.test.ts`

**Step 1: テストファイルを作成**

設計書のテストケース表に基づき、以下のテストを記述する:

1. `GET /metrics` が Prometheus 形式を返す（200, text/plain, `nexus_event_queue_size` を含む）
2. `GET /metrics/json` が JSON 配列を返す（200, application/json, パース可能）
3. `GET /health` が `{ "status": "ok" }` を返す（200）
4. 未定義パスに 404 を返す
5. EADDRINUSE 時に MCP サーバーが継続稼働する（start() が reject せず resolve、`isListening()` が `false`）
6. EADDRINUSE 後もメトリクスコールバックが動作する
7. `stop()` が未起動状態でも安全

テストではランダム空きポートを使用する（`net.createServer` で port 0 → 割り当てポート取得）。

**Step 2: テスト実行 → FAIL 確認**

Run: `npx vitest run tests/unit/observability/metrics-server.test.ts`
Expected: FAIL（MetricsHttpServer が存在しない）

**Step 3: コミット**

```bash
git add tests/unit/observability/metrics-server.test.ts
git commit -m "test(observability): MetricsHttpServer のユニットテストを作成"
```

---

### Task 10: MetricsHttpServer 実装

**Files:**

- Create: `src/observability/metrics-server.ts`

**Step 1: MetricsHttpServer を実装**

```typescript
// src/observability/metrics-server.ts
import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

export class MetricsHttpServer {
  private server: Server | undefined;
  private listening = false;

  constructor(private readonly registry: Registry) {}

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        if (req.url === '/metrics') {
          const metrics = await this.registry.metrics();
          res.writeHead(200, { 'Content-Type': this.registry.contentType });
          res.end(metrics);
        } else if (req.url === '/metrics/json') {
          const json = await this.registry.getMetricsAsJSON();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        } else if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.warn(`[Nexus] Metrics port ${port} already in use. Metrics HTTP server disabled.`);
          this.listening = false;
          resolve();
        } else {
          reject(err);
        }
      });

      this.server!.listen(port, host, () => {
        this.listening = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server || !this.listening) {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.listening = false;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  isListening(): boolean {
    return this.listening;
  }
}
```

**Step 2: テスト実行 → 全て PASS を確認**

Run: `npx vitest run tests/unit/observability/metrics-server.test.ts`
Expected: PASS

**Step 3: コミット**

```bash
git add src/observability/metrics-server.ts
git commit -m "feat(observability): MetricsHttpServer を node:http で実装"
```

---

### Task 11: E2E 統合テスト

**Files:**

- Create: `tests/integration/observability/metrics-e2e.test.ts`

**Step 1: 統合テストを作成**

設計書の統合テストケース表に基づき、以下のテストを記述する:

1. EventQueue 操作が `/metrics/json` に反映される
2. DLQ 操作が `/metrics/json` に反映される
3. 極端なメトリクス変動のエンドツーエンド追従
4. ポート競合時もコアモジュール→メトリクス収集は動作する
5. シャットダウンチェーンが正常に完了する

実際の `MetricsCollector` + `MetricsHttpServer` を起動する。
ランダム空きポートを使用する。
EventQueue と DLQ はモック不要の軽量インスタンスを作成し、`metricsHooks` に
MetricsCollector を注入する。

**Step 2: テスト実行 → PASS 確認**

Run: `npx vitest run tests/integration/observability/metrics-e2e.test.ts`
Expected: PASS

**Step 3: コミット**

```bash
git add tests/integration/observability/metrics-e2e.test.ts
git commit -m "test(observability): メトリクス E2E 統合テストを作成"
```

---

### Task 12: サーバーライフサイクルに統合

**Files:**

- Modify: `src/server/factory.ts:270-488` (createRuntime 内で MetricsCollector 生成 + 各モジュールへ注入)
- Modify: `src/server/index.ts:199-270` (initializeNexusRuntime 内で MetricsHttpServer 起動 + close チェーンに追加)

**Step 1: factory.ts を修正**

`NexusServerFactory.createRuntime()` 内で:

1. `MetricsCollector` を生成
2. `EventQueue` 生成時の options に `metricsHooks` を追加
3. `IndexPipeline` 生成時の options に `metricsHooks` を追加
4. `DeadLetterQueue` には Pipeline 経由で間接的に渡す（Pipeline のコンストラクタ内で DLQ を生成しているため、`IndexPipelineOptions` に `dlqMetricsHooks` を追加するか、Pipeline 内の DLQ 生成ロジックを修正する）

**注意**: `IndexPipeline` は内部で `DeadLetterQueue` を生成している（`pipeline.ts:63-68`）。DLQ に metricsHooks を渡すため、`IndexPipelineOptions` に `dlqMetricsHooks` を追加し、DLQ コンストラクタに伝播する。

5. `NexusRuntimeOptions` に `metricsCollector?` を追加

**Step 2: index.ts を修正**

`initializeNexusRuntime()` 内で:

1. `MetricsHttpServer` を生成・起動（`pipeline.start()` の後）
2. ポートは `process.env.NEXUS_METRICS_PORT ?? 9464`
3. `close()` チェーンの先頭に `metricsServer.stop()` を追加

**Step 3: テスト実行 → 全件 PASS 確認**

Run: `npx vitest run`
Expected: PASS

**Step 4: コミット**

```bash
git add src/server/factory.ts src/server/index.ts src/observability/types.ts
git commit -m "feat(observability): MetricsCollector と MetricsHttpServer をサーバーライフサイクルに統合"
```

---

### Task 13: PR3 の下書き作成

**Step 1: ブランチ作成・プッシュ**

```bash
git checkout -b feature/observability-http-server
git push -u origin feature/observability-http-server
```

**Step 2: Draft PR 作成**

```bash
gh pr create --draft --title "feat(observability): MetricsHttpServer + サーバーライフサイクル統合" --body "$(cat <<'EOF'
## Summary

- `MetricsHttpServer`（node:http）を実装し `/metrics`, `/metrics/json`, `/health` を公開
- `NexusServerFactory.createRuntime()` で MetricsCollector を生成しコアモジュールへ注入
- `initializeNexusRuntime()` で HTTP サーバーを起動しシャットダウンチェーンに組み込み
- EADDRINUSE 時は警告ログのみ（MCP サーバー本体には影響なし）
- E2E 統合テスト 5 件を追加

## 関連

- 設計書: `docs/superpowers/specs/2026-04-15-observability-dashboard-design.md`
- 積み上げ PR: **3/4**（前: コアモジュールフック注入、次: TUI ダッシュボード）

## Test plan

- [ ] `npx vitest run tests/unit/observability/metrics-server.test.ts` が全件 PASS
- [ ] `npx vitest run tests/integration/observability/metrics-e2e.test.ts` が全件 PASS
- [ ] `npx vitest run` で全件 PASS（リグレッションなし）
- [ ] `npx tsc --noEmit` が PASS
- [ ] `npm run lint` が PASS
- [ ] 手動確認: `curl http://localhost:9464/metrics` で Prometheus 形式が返る
- [ ] 手動確認: `curl http://localhost:9464/health` で `{"status":"ok"}` が返る

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PR4: TUI ダッシュボードパッケージ

### Task 14: npm workspace セットアップ

**Files:**

- Modify: `package.json` (workspaces フィールド追加)
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/tsconfig.json`

**Step 1: ルート package.json に workspaces を追加**

```json
{
  "workspaces": ["packages/*"]
}
```

**Step 2: packages/dashboard/package.json を作成**

```json
{
  "name": "@yohi/nexus-dashboard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/cli.js",
  "bin": {
    "nexus-dashboard": "./dist/cli.js"
  },
  "exports": {
    ".": "./dist/cli.js",
    "./cli": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "ink": "^5.2.0",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "typescript": "^5.9.3",
    "vitest": "^3.1.1"
  }
}
```

**Step 3: packages/dashboard/tsconfig.json を作成**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "jsx": "react-jsx",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["dist", "node_modules"]
}
```

**Step 4: 依存インストール**

Run: `npm install`

**Step 5: コミット**

```bash
git add package.json packages/dashboard/package.json packages/dashboard/tsconfig.json package-lock.json
git commit -m "chore: npm workspace セットアップと dashboard パッケージ初期化"
```

---

### Task 15: useMetrics フック — テストを先に書く

**Files:**

- Create: `packages/dashboard/tests/unit/use-metrics.test.ts`

**Step 1: テストファイルを作成**

設計書のテストケース表に基づき、以下のテストを記述する:

1. サーバー未起動時に接続待機状態を返す
2. サーバー起動後に正常データを返す
3. 非 JSON レスポンス時に待機状態を返す
4. 接続断後にリトライする
5. ポーリング間隔が設定通り
6. クリーンアップ時にタイマーが解除される
7. カスタムポートが URL に反映される

`fetch` をモック、タイマーは `vi.useFakeTimers()` で制御。
ink の `renderHook` を使用する（`ink-testing-library` または `@testing-library/react` で
hook テスト可能か検討。ink 5.x では `react` 互換のため `@testing-library/react-hooks` が使えるか要調査。
使えない場合は薄いテストコンポーネントで hook をラップする）。

**Step 2: テスト実行 → FAIL 確認**

Run: `cd packages/dashboard && npx vitest run tests/unit/use-metrics.test.ts`
Expected: FAIL

---

### Task 16: useMetrics フック実装

**Files:**

- Create: `packages/dashboard/src/hooks/use-metrics.ts`

**Step 1: フックを実装**

```typescript
// packages/dashboard/src/hooks/use-metrics.ts
import { useState, useEffect, useRef } from 'react';

export type MetricsStatus = 'connecting' | 'connected' | 'waiting' | 'reconnecting';

export interface MetricsJSON {
  // prom-client getMetricsAsJSON の返却型
  [key: string]: unknown;
}

export interface UseMetricsOptions {
  port?: number;
  interval?: number;
}

export interface UseMetricsResult {
  status: MetricsStatus;
  data: MetricsJSON[] | null;
  error: string | null;
}

export function useMetrics(options: UseMetricsOptions = {}): UseMetricsResult {
  const { port = 9464, interval = 2000 } = options;
  const [status, setStatus] = useState<MetricsStatus>('connecting');
  const [data, setData] = useState<MetricsJSON[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hadConnection = useRef(false);

  useEffect(() => {
    hadConnection.current = false; // port/interval 変更時にリセット
    const abortController = new AbortController();
    const url = `http://localhost:${port}/metrics/json`;

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          setStatus('waiting');
          setError('Invalid JSON');
          return;
        }
        const json = await res.json() as MetricsJSON[];
        setData(json);
        setError(null);
        setStatus('connected');
        hadConnection.current = true;
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        if (hadConnection.current) {
          setStatus('reconnecting');
        } else {
          setStatus('connecting');
        }
      }
    };

    void poll();
    const id = setInterval(() => void poll(), interval);
    return () => {
      abortController.abort();
      clearInterval(id);
    };
  }, [port, interval]);

  return { status, data, error };
}
```

**Step 2: テスト実行 → PASS 確認**

Run: `cd packages/dashboard && npx vitest run tests/unit/use-metrics.test.ts`
Expected: PASS

**Step 3: コミット**

```bash
git add packages/dashboard/src/hooks/use-metrics.ts packages/dashboard/tests/unit/use-metrics.test.ts
git commit -m "feat(dashboard): useMetrics ポーリングフックを実装"
```

---

### Task 17: TUI コンポーネント実装

**Files:**

- Create: `packages/dashboard/src/app.tsx`
- Create: `packages/dashboard/src/components/queue-panel.tsx`
- Create: `packages/dashboard/src/components/throughput-panel.tsx`
- Create: `packages/dashboard/src/components/dlq-panel.tsx`

**Step 1: 各パネルコンポーネントを実装**

設計書の TUI レイアウト（3 パネル構成）に従い実装する。
各コンポーネントは `useMetrics` フックの `data` からメトリクスを抽出して表示する。

- **QueuePanel**: `nexus_event_queue_size`, `nexus_event_queue_state`, `nexus_event_queue_dropped_total` を表示。プログレスバー付き（size / maxQueueSize）
- **ThroughputPanel**: `nexus_indexing_chunks_total`, `nexus_reindex_duration_seconds` を表示
- **DlqPanel**: `nexus_dlq_size`, `nexus_dlq_recovery_total` を表示。ヘルスステータスインジケーター付き

**Step 2: App ルートコンポーネントを実装**

ヘッダー（タイトル）、3 パネル、フッター（接続先・リフレッシュ間隔・終了キー）を配置。
`useMetrics` を呼び出し、各パネルに data を渡す。
`useInput` で `q` キー押下時に `process.exit(0)` を呼ぶ。

**Step 3: ビルド確認**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: PASS

**Step 4: コミット**

```bash
git add packages/dashboard/src/app.tsx packages/dashboard/src/components/
git commit -m "feat(dashboard): TUI コンポーネント（QueuePanel, ThroughputPanel, DlqPanel）を実装"
```

---

### Task 18: CLI エントリポイント

**Files:**

- Create: `packages/dashboard/src/cli.ts`
- Modify: `src/bin/nexus.ts` (dashboard サブコマンド分岐を追加)

**Step 1: packages/dashboard/src/cli.ts を作成**

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9464' },
    interval: { type: 'string', default: '2000' },
  },
  strict: false,
});

const port = parseInt(values.port ?? '9464', 10);
const interval = parseInt(values.interval ?? '2000', 10);

const { waitUntilExit } = render(React.createElement(App, { port, interval }));
await waitUntilExit();
```

**Step 2: src/bin/nexus.ts にサブコマンド分岐を追加**

`process.argv[2] === 'dashboard'` の場合は MCP サーバーを起動せず、
dynamic import で `@yohi/nexus-dashboard` の CLI を起動する。

```typescript
// src/bin/nexus.ts 冒頭に追加
if (process.argv[2] === 'dashboard') {
  // TUI ダッシュボードを起動（MCP サーバーは起動しない）
  await import('@yohi/nexus-dashboard/cli');
  // import した時点で CLI が実行されるため、ここで終了
} else {
  // 既存の MCP サーバー起動ロジック
  main().catch(...)
}
```

**注意**: `@yohi/nexus-dashboard` は npm workspace 内のパッケージなので
`import` で解決可能。ただし TUI パッケージの `exports` 設定で `./cli`
エントリを公開する必要がある。

**Step 3: ビルド・動作確認**

Run: `npm run build` (workspace 全体)
Run: `node dist/bin/nexus.js dashboard --help` (TUI が起動することを確認)

**Step 4: コミット**

```bash
git add packages/dashboard/src/cli.ts src/bin/nexus.ts
git commit -m "feat(dashboard): CLI エントリポイントと nexus dashboard サブコマンドを実装"
```

---

### Task 19: PR4 の下書き作成

**Step 1: ブランチ作成・プッシュ**

```bash
git checkout -b feature/observability-dashboard-tui
git push -u origin feature/observability-dashboard-tui
```

**Step 2: Draft PR 作成**

```bash
gh pr create --draft --title "feat(dashboard): TUI ダッシュボードパッケージを追加" --body "$(cat <<'EOF'
## Summary

- npm workspace で `@yohi/nexus-dashboard` パッケージを分離（ink/react がコア依存に混入しない）
- `useMetrics` ポーリングフック（接続フォールバック付き）
- 3 パネル TUI: Event Queue / Indexing Throughput / DLQ Health
- `nexus dashboard [--port] [--interval]` サブコマンド
- useMetrics フックのユニットテスト 7 件

## 関連

- 設計書: `docs/superpowers/specs/2026-04-15-observability-dashboard-design.md`
- 積み上げ PR: **4/4**（完了）

## Test plan

- [ ] `cd packages/dashboard && npx vitest run` が全件 PASS
- [ ] `npx tsc --noEmit` が PASS（workspace 全体）
- [ ] `npm run lint` が PASS
- [ ] 手動確認: Nexus MCP サーバーを起動した状態で `nexus dashboard` を実行し TUI が表示される
- [ ] 手動確認: MCP サーバー未起動時に `nexus dashboard` を実行すると「Connecting...」表示でリトライされる
- [ ] 手動確認: `q` キーで TUI が安全に終了する

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 実装順序のまとめ

```text
Task 1-3  → commit × 3 → PR1 (Draft)
Task 5-7  → commit × 3 → PR2 (Draft)
Task 9-12 → commit × 4 → PR3 (Draft)
Task 14-18 → commit × 5 → PR4 (Draft)
```

各 PR はマージ前に以下を確認:

1. `npx tsc --noEmit` — 型チェック
2. `npm run lint` — ESLint
3. `npx vitest run` — 全テスト
4. PR レビュー承認

積み上げ方式のため、PR1 → PR2 → PR3 → PR4 の順にマージする。



🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 実装順序のまとめ

```text
Task 1-3  → commit × 3 → PR1 (Draft)
Task 5-7  → commit × 3 → PR2 (Draft)
Task 9-12 → commit × 4 → PR3 (Draft)
Task 14-18 → commit × 5 → PR4 (Draft)
```

各 PR はマージ前に以下を確認:

1. `npx tsc --noEmit` — 型チェック
2. `npm run lint` — ESLint
3. `npx vitest run` — 全テスト
4. PR レビュー承認

積み上げ方式のため、PR1 → PR2 → PR3 → PR4 の順にマージする。
