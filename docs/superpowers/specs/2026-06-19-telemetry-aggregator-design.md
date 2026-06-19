# Design Spec: テレメトリの高度化と中央集約アーキテクチャ

> **Date**: 2026-06-19
> **Status**: Approved
> **Scope**: アプリケーション層メトリクス追加 + 中央集約サーバー (Aggregator) + Grafana ダッシュボード

---

## 1. 目的

1. **ビジネスメトリクスの可視化**: 既存のインフラ層メトリクス（Queue, Indexing, DLQ）に加え、MCPツール利用状況・検索品質・エンベディングAPI性能をアプリケーション層で計測する。
2. **マルチプロセス監視の透過的統合**: 複数プロジェクトを横断して `nexus dashboard` コマンド内で透過的に常駐する Aggregator を介し、Grafana で一元監視可能にする。

---

## 2. システムアーキテクチャ

```text
┌─────────────────────────────────────────────────────────────────┐
│  Nexus Process A (Project: foo, metricsPort: 9471)              │
│                                                                 │
│  EventQueue ──┐                                                 │
│  Pipeline ────┤── MetricsHooks ──▶ MetricsCollector             │
│  DLQ ─────────┘   (既存+新規)      (prom-client Registry)       │
│                                     defaultLabels:              │
│  MCP Tools ──── withToolMetrics ──▶  { project:"foo",           │
│    (hybrid_search, get_context...)    pid:"12345" }             │
│                                          │                      │
│  EmbeddingProvider                MetricsHttpServer              │
│    └── InstrumentedEmbeddingProvider  :9471                     │
│         (Decorator)                /metrics, /metrics/json      │
│                                    /health                      │
│                                          │                      │
│         RegistrationClient ──────────────┼──── Heartbeat (30s)  │
└──────────────────────────────────────────┼──────────────────────┘
                                           │
                         POST /api/discovery/register (Fire&Forget)
                                           │
                                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  nexus dashboard (Aggregator, port: 9470)                       │
│                                                                 │
│  cli.ts ── main()                                               │
│    ├── AggregatorServer.start(9470)    ← EADDRINUSE → skip      │
│    │     ├── POST /api/discovery/register  (Upsert to Map)      │
│    │     ├── GET  /metrics                 (JSON merge → text)  │
│    │     ├── GET  /health                                       │
│    │     ├── GET  /api/discovery/nodes     (デバッグ用)           │
│    │     └── HealthChecker (15s interval)                       │
│    │           └── GET :port/health → timeout → evict           │
│    │                                                            │
│    └── TUI (React/Ink) ── useMetrics ── fetch /metrics/json     │
│         ├── 📊 Queue Panel                                      │
│         ├── 🚀 Throughput Panel          (単一プロセス監視)      │
│         └── 🪦 DLQ Panel                                        │
└─────────────────────────────────────────────────────────────────┘
                    │
          GET /metrics (Prometheus text)
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Grafana (外部)                                                  │
│  scrape_configs:                                                │
│    - targets: ["localhost:9470"]                                 │
│  Dashboard: docs/observability/grafana-dashboard.json           │
└─────────────────────────────────────────────────────────────────┘
```

### データフロー

1. **メトリクス生成**: 各 Nexus プロセスが `MetricsCollector` でインメモリ集計。`defaultLabels` により `project`/`pid` が全メトリクスに自動付与。
2. **登録 & Heartbeat**: Nexus プロセスは起動時 + 30秒間隔で Aggregator に `POST /api/discovery/register` を送信（Fire & Forget）。Aggregator 側は Upsert。
3. **ヘルスチェック**: Aggregator が15秒間隔で全登録ノードの `/health` を確認。応答なし → 即座に Map から evict。
4. **集約**: Grafana が `GET /metrics` をスクレイプ → Aggregator が全ノードの `/metrics/json` を並列取得 → メトリクス名でグループ化マージ → Prometheus テキスト形式で返却。

### 設計原則

- **既存コードへの侵襲最小化**: ツール関数・エンベディングプロバイダーの既存コードは変更しない（Decorator/ラッパーで外側から計装）
- **障害隔離**: Aggregator 未起動・クラッシュでも各 Nexus プロセスは完全に独立稼働
- **テスト容易性**: 全コンポーネントが依存注入で構成され、モック可能

---

## 3. アプリケーション層メトリクスの定義

### 3.1. MetricsHooks インターフェースの拡張

`src/observability/types.ts` に以下のコールバックを追加する。

```typescript
export interface MetricsHooks {
  // ── 既存 (変更なし) ──
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source?: string): void;
  onChunksIndexed(count: number): void;
  onReindexComplete(durationMs: number, fullRebuild: boolean): void;
  onDlqSnapshot(size: number, source?: string): void;
  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source?: string): void;
  onIndexingProgress(processed: number, total: number, active: boolean): void;

  // ── 新規追加 ──
  onToolCall(toolName: string, status: 'success' | 'error', durationSeconds: number): void;
  onSearchResults(searchType: 'semantic' | 'grep' | 'hybrid', resultCount: number): void;
  onContextLinesFetched(toolName: string, lineCount: number): void;
  onEmbeddingRequest(provider: string, status: 'success' | 'error', durationSeconds: number, batchSize: number): void;
}
```

全フックは既存パターンと同様に required とする。テスト時は各メソッドを `vi.fn()` でモック化する。

### 3.2. 新規 Prometheus メトリクス定義

`src/observability/metrics-collector.ts` に追加する。

| メトリクス名 | 型 | ラベル | 用途 |
|---|---|---|---|
| `nexus_tool_calls_total` | Counter | `tool_name`, `status` | ツール呼び出し回数・エラー率 |
| `nexus_tool_duration_seconds` | Histogram | `tool_name` | ツール実行レイテンシ |
| `nexus_search_results_count` | Histogram | `search_type` | 検索ヒット件数分布（空振り検知） |
| `nexus_context_lines_fetched_total` | Counter | `tool_name` | エージェント取得コード行数 |
| `nexus_embedding_requests_total` | Counter | `provider`, `status` | エンベディング API 呼び出し回数 |
| `nexus_embedding_duration_seconds` | Histogram | `provider` | エンベディング API レイテンシ |

### 3.3. Histogram バケット設計

```typescript
// ツール実行レイテンシ: 数ms〜数十秒
const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// 検索ヒット件数: 0件(空振り)〜数百件
const SEARCH_RESULTS_BUCKETS = [0, 1, 5, 10, 25, 50, 100, 250];

// エンベディングレイテンシ: ローカル Ollama は速いが API は遅い可能性
const EMBEDDING_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
```

### 3.4. defaultLabels の設定

```typescript
export class MetricsCollector implements MetricsHooks {
  readonly registry: Registry;

  constructor(projectName?: string) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({
      project: projectName || process.env.NEXUS_PROJECT_NAME || path.basename(process.cwd()),
      pid: process.pid.toString(),
    });
    // ... 既存メトリクス定義 + 新規メトリクス定義
  }
}
```

`projectName` の解決順序: コンストラクタ引数 > `NEXUS_PROJECT_NAME` 環境変数 > `process.cwd()` のベースネーム。

### 3.5. フック実装

```typescript
onToolCall(toolName: string, status: 'success' | 'error', durationSeconds: number): void {
  this.toolCallsTotal.inc({ tool_name: toolName, status });
  this.toolDurationSeconds.observe({ tool_name: toolName }, durationSeconds);
}

onSearchResults(searchType: 'semantic' | 'grep' | 'hybrid', resultCount: number): void {
  this.searchResultsCount.observe({ search_type: searchType }, resultCount);
}

onContextLinesFetched(toolName: string, lineCount: number): void {
  this.contextLinesFetchedTotal.inc({ tool_name: toolName }, lineCount);
}

onEmbeddingRequest(provider: string, status: 'success' | 'error', durationSeconds: number, _batchSize: number): void {
  this.embeddingRequestsTotal.inc({ provider, status });
  this.embeddingDurationSeconds.observe({ provider }, durationSeconds);
}
```

---

## 4. 計装（Instrumentation）

### 4.1. エンベディングプロバイダー — Decorator パターン

**新規ファイル**: `src/plugins/embeddings/instrumented.ts`

```typescript
import type { EmbeddingProvider } from '../../types/index.js';
import type { MetricsHooks } from '../../observability/types.js';

export class InstrumentedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly hooks: MetricsHooks,
    private readonly providerName: string,
  ) {}

  get dimensions(): number {
    return this.inner.dimensions;
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async embed(texts: string[]): Promise<number[][]> {
    const start = performance.now();
    try {
      const result = await this.inner.embed(texts);
      this.hooks.onEmbeddingRequest(
        this.providerName, 'success',
        (performance.now() - start) / 1000,
        texts.length,
      );
      return result;
    } catch (error) {
      this.hooks.onEmbeddingRequest(
        this.providerName, 'error',
        (performance.now() - start) / 1000,
        texts.length,
      );
      throw error;
    }
  }
}
```

**注入ポイント**: `src/server/factory.ts` でプロバイダー生成直後にラップする。

```typescript
const rawProvider = createEmbeddingProvider(config.embedding);
const provider = new InstrumentedEmbeddingProvider(
  rawProvider,
  metricsCollector,
  config.embedding.provider, // "ollama" | "openai-compat"
);
```

`OllamaEmbeddingProvider`, `OpenAICompatEmbeddingProvider` のコードは一切変更しない。

### 4.2. MCP ツール — ハイブリッド方式

#### 4.2.1. 汎用ラッパー関数

**新規ファイル**: `src/server/tool-instrumentation.ts`

```typescript
import type { MetricsHooks } from '../observability/types.js';

export function withToolMetrics<TArgs extends unknown[], TResult>(
  toolName: string,
  hooks: MetricsHooks | undefined,
  handler: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  if (!hooks) return handler;

  return async (...args: TArgs): Promise<TResult> => {
    const start = performance.now();
    try {
      const result = await handler(...args);
      hooks.onToolCall(toolName, 'success', (performance.now() - start) / 1000);
      return result;
    } catch (error) {
      hooks.onToolCall(toolName, 'error', (performance.now() - start) / 1000);
      throw error;
    }
  };
}
```

#### 4.2.2. 各ツールの固有メトリクス

| ツール | 固有メトリクス | フック呼び出し |
|---|---|---|
| `hybrid_search` | 検索ヒット件数 | `hooks.onSearchResults('hybrid', results.length)` |
| `semantic_search` | 検索ヒット件数 | `hooks.onSearchResults('semantic', results.length)` |
| `grep_search` | 検索ヒット件数 | `hooks.onSearchResults('grep', results.length)` |
| `get_context` | 取得行数 | `hooks.onContextLinesFetched('get_context', endLine - startLine + 1)` |
| `index_status` | なし | 共通メトリクスのみ |
| `reindex` | なし | 共通メトリクスのみ |

`withToolMetrics` はハンドラーの外側で成否・レイテンシを計測し、固有メトリクスはハンドラーの内側で結果オブジェクト確定後に計測する。

---

## 5. 中央集約サーバー（Aggregator）

### 5.1. ファイル構成

**新規ファイル**: `packages/dashboard/src/server/aggregator.ts`

3つの責務を凝集:

1. HTTP サーバー（ルーティング）
2. ノード管理（InMemory Map + Upsert/Evict）
3. ヘルスチェック（定期巡回）

### 5.2. ノード管理 — InMemory Map

```typescript
interface RegisteredNode {
  projectId: string;
  metricsPort: number;
  pid: number;
  registeredAt: number;  // Date.now()
}

// Key: metricsPort (マシン内でユニーク)
type NodeMap = Map<number, RegisteredNode>;
```

### 5.3. HTTP エンドポイント

| メソッド | パス | 用途 | レスポンス |
|---|---|---|---|
| `POST` | `/api/discovery/register` | ノード登録/Heartbeat | `201` (新規) / `200` (Upsert) |
| `GET` | `/metrics` | Prometheus 集約エンドポイント | `text/plain` |
| `GET` | `/health` | Aggregator 自身のヘルス | `{"status":"ok","nodes":N}` |
| `GET` | `/api/discovery/nodes` | 登録ノード一覧（デバッグ用） | JSON 配列 |

#### POST /api/discovery/register 処理フロー

1. リクエスト Body を JSON パース
2. バリデーション: `projectId`(string), `metricsPort`(number), `pid`(number) の存在確認
3. `NodeMap.set(metricsPort, { ...payload, registeredAt: Date.now() })`
4. 新規 → 201, 更新 → 200, バリデーション失敗 → 400

#### GET /metrics 集約アルゴリズム（JSON マージ方式）

1. NodeMap から生存ノード一覧を取得
2. 全ノードの `/metrics/json` に `Promise.allSettled` で並列リクエスト（各リクエストは個別に `try/catch` でラップし、タイムアウト: 3000ms）
3. `fulfilled` な結果のみをフィルタし（`rejected` はスキップ）、JSON 配列をフラット化
4. メトリクス名 (`name`) でグループ化 → `values` を結合
   - **ラベル一意性の保証**: 各ノードは `defaultLabels` により `project`/`pid` ラベルが事前付与済みのため、異なるノードの values は必ず異なるラベルセットを持つ。したがって単純な values 結合で Prometheus のラベル重複エラーは発生しない（算術加算は不要）。
   - Histogram の `_bucket`/`_sum`/`_count` も同様にラベルセットで一意であり、そのまま結合できる。
5. グループ化されたデータを Prometheus テキスト形式に再構築:
   - `# HELP {name} {help}`
   - `# TYPE {name} {type}`
   - `{name}{labels} {value}`
   - Histogram: 各 value の `metricName` フィールド (`xxx_bucket`, `xxx_sum`, `xxx_count`) を使用して正しいメトリクス名で出力
6. 特定ノードへのリクエスト失敗 → そのノードをスキップ（部分的成功を許容）
7. 全ノード失敗 → 空テキストを返却（HTTP 200, Prometheus 互換）

> **テスト要件**: `prometheus-serializer` のテストに、複数ノードからの Histogram メトリクス集約ケース（異なる `project`/`pid` ラベルを持つ `_bucket`/`_sum`/`_count` の結合と出力順序の検証）を必須テストケースとして含めること。

### 5.4. ヘルスチェック & エビクション

```typescript
class HealthChecker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly nodes: NodeMap,
    private readonly intervalMs: number = 15_000,
    private readonly timeoutMs: number = 2_000,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    this.timer.unref(); // プロセス終了をブロックしない
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async checkAll(): Promise<void> {
    const checks = [...this.nodes.entries()].map(
      async ([port]) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          await this.fetchFn(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          });
        } catch {
          this.nodes.delete(port);
        } finally {
          clearTimeout(timeout);
        }
      }
    );
    await Promise.allSettled(checks);
  }
}
```

- `setInterval` + `unref()`: シャットダウン時にタイマーがプロセス終了をブロックしない
- `Promise.allSettled`: 1ノードのチェック失敗が他ノードに影響しない
- Evict は即座（再試行なし）: Heartbeat（30秒間隔）が補完するため一時的な誤判定は30秒以内に自己回復

### 5.5. 透過的起動とフォールバック

`packages/dashboard/src/cli.ts` の `main()` 関数冒頭:

```typescript
async function main() {
  const aggregatorPort = getAggregatorPort(args); // CLI > env > 9470

  const aggregator = new AggregatorServer();
  try {
    await aggregator.start(aggregatorPort);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // 別ターミナルで既に起動済み → TUI クライアント専用モードで継続
      console.error(`Aggregator already running on port ${aggregatorPort}, skipping.`);
    } else {
      console.error('Failed to start aggregator:', err);
    }
  }

  // TUI 描画（既存処理、変更なし）
  const { waitUntilExit } = render(<App ... />);
  await waitUntilExit();

  // クリーンアップ（stop() は冪等のため、start() の成否を問わず安全に呼べる）
  await aggregator.stop();
}
```

Aggregator のシャットダウン順序:

1. `HealthChecker.stop()` — タイマー停止
2. `HTTPサーバー.close()` — 新規接続の受付停止
3. `NodeMap.clear()` — インメモリ状態のクリア

> **冪等性要件**: `stop()` は何度呼ばれても安全でなければならない。`start()` が失敗した場合（部分初期化状態）でも二次的な例外を発生させないこと。実装では各リソースの存在を optional chaining でガードする（`this.healthChecker?.stop()`, `this.server?.close()` 等）。

---

## 6. ノード登録 & Heartbeat

### 6.1. RegistrationClient

`src/observability/metrics-server.ts` に追加（または小モジュールとして分離）。

```typescript
interface RegistrationConfig {
  aggregatorPort: number;       // デフォルト: 9470
  heartbeatIntervalMs: number;  // デフォルト: 30_000
  requestTimeoutMs: number;     // デフォルト: 1_000
}

class RegistrationClient {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly payload: {
      projectId: string;
      metricsPort: number;
      pid: number;
    },
    private readonly config: RegistrationConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly logger?: { debug: (...args: unknown[]) => void },
  ) {}

  start(): void {
    void this.register();  // 初回即時送信
    this.timer = setInterval(() => void this.register(), this.config.heartbeatIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async register(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      await this.fetchFn(
        `http://127.0.0.1:${this.config.aggregatorPort}/api/discovery/register`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.payload),
          signal: controller.signal,
        },
      );
    } catch (error) {
      this.logger?.debug('Aggregator registration failed (non-fatal):', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

### 6.2. 起動フローへの統合

`src/server/index.ts` の `initialize()` 内、メトリクスサーバー起動成功後:

```typescript
if (metricsServer.isListening()) {
  this.registrationClient = new RegistrationClient(
    {
      projectId: config.projectName || path.basename(projectRoot),
      metricsPort: metricsServer.getPort(),
      pid: process.pid,
    },
    {
      aggregatorPort: config.aggregatorPort ?? 9470,
      heartbeatIntervalMs: 30_000,
      requestTimeoutMs: 1_000,
    },
  );
  this.registrationClient.start();
}
```

### 6.3. シャットダウンフロー

```typescript
shutdown() {
  this.registrationClient?.stop();  // Heartbeat 停止
  // 既存: metricsServer.stop()
  // 既存: removeMetricsPort(storageDir)
}
```

### 6.4. 設定解決

`aggregatorPort` の解決順序:

| 優先度 | ソース | 備考 |
|---|---|---|
| 1（最優先） | CLI 引数 `--aggregator-port` | `nexus dashboard` 起動時のみ |
| 2 | `.nexus.json` の `aggregatorPort` | プロジェクト固有設定 |
| 3 | 環境変数 `NEXUS_AGGREGATOR_PORT` | 環境レベル設定 |
| 4（デフォルト） | `9470` | ハードコード |

`src/config/index.ts` に `aggregatorPort?: number` を追加。ノード側（`RegistrationClient`）は CLI 引数を持たないため、優先度2〜4で解決する。

### 6.5. 障害パターンと動作保証

| シナリオ | 動作 |
|---|---|
| Aggregator 未起動 | `ECONNREFUSED` → debug ログ → 30秒後リトライ |
| Aggregator 停止 | Heartbeat が `ECONNREFUSED` → debug ログ → Nexus 正常稼働 |
| Aggregator 再起動 | 最大30秒後に次の Heartbeat で自動再登録 |
| ネットワーク一時遅延 | タイムアウト (1000ms) → debug ログ → 次回30秒後にリトライ |
| Nexus プロセス終了 | `stop()` でタイマークリア → Aggregator 側は15秒後にヘルスチェックで evict |

核心的な保証: いかなる障害パターンでも `RegistrationClient` は Nexus 本体のプロセスを停止させない。

---

## 7. Grafana ダッシュボード設計

### 7.1. 配置

- **ダッシュボード JSON**: `docs/observability/grafana-dashboard.json`
- **セットアップガイド**: `docs/observability/README.md`

### 7.2. ダッシュボード変数

```json
{
  "name": "project",
  "type": "query",
  "query": "label_values(nexus_tool_calls_total, project)",
  "includeAll": true,
  "allValue": ".*",
  "multi": true
}
```

全パネルのクエリに `{project=~"$project"}` を適用。

### 7.3. パネル構成 — 4 Row レイアウト

#### Row 1: Agent Activity Overview

| パネル | 型 | PromQL |
|---|---|---|
| Total Tool Calls (1h) | Stat | `sum(increase(nexus_tool_calls_total{project=~"$project"}[1h]))` |
| Total Context Lines (1h) | Stat | `sum(increase(nexus_context_lines_fetched_total{project=~"$project"}[1h]))` |
| Avg Search Latency | Stat | `sum(rate(nexus_tool_duration_seconds_sum{project=~"$project",tool_name=~"hybrid_search\|semantic_search\|grep_search"}[5m])) / sum(rate(nexus_tool_duration_seconds_count{project=~"$project",tool_name=~"hybrid_search\|semantic_search\|grep_search"}[5m]))` |
| Tool Usage Breakdown | Pie Chart | `sum by (tool_name) (increase(nexus_tool_calls_total{project=~"$project"}[1h]))` |

#### Row 2: Search Quality & Performance

| パネル | 型 | PromQL |
|---|---|---|
| Tool Latency P95 | Time Series | `histogram_quantile(0.95, sum by (le, tool_name) (rate(nexus_tool_duration_seconds_bucket{project=~"$project"}[5m])))` |
| Tool Latency P99 | Time Series | `histogram_quantile(0.99, sum by (le, tool_name) (rate(nexus_tool_duration_seconds_bucket{project=~"$project"}[5m])))` |
| Avg Results per Search | Bar Gauge | `sum by (search_type) (rate(nexus_search_results_count_sum{project=~"$project"}[5m])) / sum by (search_type) (rate(nexus_search_results_count_count{project=~"$project"}[5m]))` |
| Error Rate by Tool | Time Series (Bar) | `sum by (tool_name) (rate(nexus_tool_calls_total{project=~"$project",status="error"}[5m]))` |

#### Row 3: Indexing Pipeline Health

| パネル | 型 | PromQL |
|---|---|---|
| Event Queue Size | Time Series | `nexus_event_queue_size{project=~"$project"}` |
| Dropped Events Rate | Time Series (2nd axis) | `rate(nexus_event_queue_dropped_total{project=~"$project"}[5m])` |
| DLQ Size | Stat | `nexus_dlq_size{project=~"$project"}` (閾値: 0=Green, <100=Yellow, ≥100=Red) |
| Indexing Active | Stat | `nexus_indexing_active{project=~"$project"}` (1=Active, 0=Idle) |

#### Row 4: Resource & Dependencies

| パネル | 型 | PromQL |
|---|---|---|
| Embedding API Latency P95 | Time Series | `histogram_quantile(0.95, sum by (le, provider) (rate(nexus_embedding_duration_seconds_bucket{project=~"$project"}[5m])))` |
| Embedding Request Rate | Time Series | `sum by (provider, status) (rate(nexus_embedding_requests_total{project=~"$project"}[5m]))` |

### 7.4. ダッシュボード全体設定

```json
{
  "title": "Nexus - AI Agent Observability",
  "uid": "nexus-agent-observability",
  "refresh": "10s",
  "time": { "from": "now-1h", "to": "now" },
  "timezone": "browser"
}
```

### 7.5. docs/observability/README.md

セットアップ手順:

1. `nexus dashboard` を起動（Aggregator が port 9470 で自動起動）
2. Grafana の Data Source に Prometheus を追加（scrape target: `localhost:9470`）
3. Dashboard → Import → `grafana-dashboard.json` を読み込み

Prometheus `scrape_configs` 例:

```yaml
- job_name: 'nexus'
  scrape_interval: 10s
  static_configs:
    - targets: ['localhost:9470']
```

全16メトリクスのリファレンス表を記載。

---

## 8. テスト戦略

### 8.1. テスト対象マトリクス

| コンポーネント | テストファイル | テスト種別 |
|---|---|---|
| `MetricsCollector` (新規フック) | `tests/unit/observability/metrics-collector.test.ts` | Unit |
| `InstrumentedEmbeddingProvider` | `tests/unit/plugins/instrumented-embedding.test.ts` | Unit |
| `withToolMetrics` | `tests/unit/server/tool-instrumentation.test.ts` | Unit |
| `RegistrationClient` | `tests/unit/observability/registration-client.test.ts` | Unit |
| `AggregatorServer` | `packages/dashboard/tests/unit/aggregator.test.ts` | Unit |
| `HealthChecker` | `packages/dashboard/tests/unit/health-checker.test.ts` | Unit |
| `defaultLabels` | `tests/unit/observability/metrics-collector.test.ts` | Unit |
| Prometheus テキスト再構築 | `packages/dashboard/tests/unit/prometheus-serializer.test.ts` | Unit |

### 8.2. テスト設計指針

- **依存注入**: `fetchFn`, `logger` 等を注入し、`vi.fn()` でモック化
- **タイマー制御**: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` で Heartbeat/HealthCheck をテスト
- **テスト対象外**: Grafana ダッシュボード JSON のスキーマ検証、Prometheus/Grafana との結合テスト

---

## 9. エラーハンドリング総括

| 障害ポイント | 影響 | 対処 |
|---|---|---|
| Aggregator 未起動時のノード登録 | なし | `ECONNREFUSED` → debug ログ → 30秒後リトライ |
| Aggregator ポート競合 | TUI のみ | `EADDRINUSE` → HTTP サーバースキップ → TUI 正常起動 |
| `/metrics` 集約時の特定ノード障害 | 部分的 | 該当ノードスキップ → 他ノード結果は正常返却 |
| ヘルスチェック誤判定 | 一時的 evict | 次回 Heartbeat(30秒以内) で自動再登録 |
| `MetricsCollector` 未初期化 | なし | `hooks` が `undefined` → `withToolMetrics` パススルー |
| 不正な登録ペイロード | 登録拒否 | 400 レスポンス → ノードはスタンドアロンで稼働継続 |

---

## 10. 影響範囲

| ファイル | 変更種別 | 内容 |
|---|---|---|
| `src/observability/types.ts` | 変更 | `MetricsHooks` に4メソッド追加 |
| `src/observability/metrics-collector.ts` | 変更 | 6新規メトリクス定義 + 4フック実装 + `defaultLabels` |
| `src/observability/metrics-server.ts` | 変更 | `RegistrationClient` の統合 |
| `src/server/index.ts` | 変更 | ツール登録部に `withToolMetrics` 適用 + 固有フック |
| `src/server/factory.ts` | 変更 | `InstrumentedEmbeddingProvider` のラップ注入 |
| `src/config/index.ts` | 変更 | `aggregatorPort` 設定項目追加 |
| `src/server/tool-instrumentation.ts` | 新規 | `withToolMetrics` 高階関数 |
| `src/plugins/embeddings/instrumented.ts` | 新規 | `InstrumentedEmbeddingProvider` Decorator |
| `packages/dashboard/src/server/aggregator.ts` | 新規 | AggregatorServer + HealthChecker |
| `packages/dashboard/src/cli.ts` | 変更 | Aggregator の透過的起動 + フォールバック |
| `docs/observability/grafana-dashboard.json` | 新規 | Grafana プロビジョニング JSON |
| `docs/observability/README.md` | 新規 | セットアップガイド + メトリクスリファレンス |
| テストファイル (6ファイル) | 新規 | テストマトリクスのとおり |

### 実装順序

1. **アプリメトリクス追加**: `MetricsHooks` 拡張 → `MetricsCollector` 新規メトリクス + `defaultLabels` → `InstrumentedEmbeddingProvider` → `withToolMetrics` → ツール登録部改修
2. **Aggregator**: `AggregatorServer` + `HealthChecker` → `RegistrationClient` → `cli.ts` 統合
3. **Grafana ダッシュボード**: `grafana-dashboard.json` → `docs/observability/README.md`
