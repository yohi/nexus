# Telemetry Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement application-level metrics, a multi-process Telemetry Aggregator, and Grafana dashboard integration to monitor AI agents' tool usages, search quality, and embedding API performance.

**Architecture:** Nexus processes collect in-memory Prometheus metrics. An Aggregator server running inside the dashboard CLI polls the processes' `/metrics/json` endpoints, merges them using `project` and `pid` labels to ensure uniqueness, and serializes the merged dataset back into Prometheus text format. Dead processes are evicted using an active `HealthChecker` loop.

**Tech Stack:** Node.js 24, TypeScript, prom-client, Vitest, Node.js http module.

## Global Constraints

- **No Absolute Paths**: Do not hardcode or commit paths specific to a machine/user. Use relative paths or environment variables.
- **Credential Protection**: Do not log or commit credentials/secrets.
- **Node.js**: Require `>=24.0.0` engine constraints.

---

### Task 1: Application Metrics Expansion (MetricsHooks & MetricsCollector)

**Files:**
- Modify: `package.json` (Verify Node engine constraint)
- Modify: `src/observability/types.ts`
- Modify: `src/observability/metrics-collector.ts`
- Modify: `tests/unit/observability/metrics-collector.test.ts`
- Modify: `src/server/factory.ts`

**Interfaces:**
- Consumes: None (Existing codebase)
- Produces:
  - `MetricsCollector` updated constructor: `constructor(projectNameOrRegistry?: string | Registry, registry?: Registry)`
  - `MetricsHooks` updated interface with new method definitions.

- [ ] **Step 1: Verify Node.js engine constraint in package.json**

Open `package.json` and verify that the `engines.node` constraint is present and correctly set to `>=24.0.0`. If it is missing or not set to `>=24.0.0`, update `engines.node` in `package.json` to `>=24.0.0` and review any lockfile impact (run `npm install` inside devcontainer if necessary to reconcile differences).
Expected: `engines` block is configured properly.

- [ ] **Step 1.5: Pass configuration project name to MetricsCollector in factory.ts**

Modify `src/server/factory.ts` to instantiate `MetricsCollector` passing the project name:
```typescript
// Around line 429 in src/server/factory.ts
const metricsCollector = new MetricsCollector(config.projectName || path.basename(projectRoot));
```
Expected: `MetricsCollector` initialization uses the configured project name for default labels.



- [ ] **Step 2: Write the failing test for new hooks and default labels**

Modify `tests/unit/observability/metrics-collector.test.ts` to add test cases for default labels and the new hooks. Modify existing instantiation tests to pass `undefined` as the first argument to match the new constructor.

```typescript
// tests/unit/observability/metrics-collector.test.ts
// In describe('MetricsCollector') block:

  it('defaultLabels are set on registry', async () => {
    const customRegistry = new Registry();
    const collector = new MetricsCollector('test-project-labels', customRegistry);
    
    // Trigger any metric to populate values with default labels
    collector.onChunksIndexed(5);
    const metrics = await customRegistry.metrics();
    expect(metrics).toContain('project="test-project-labels"');
    expect(metrics).toContain('pid="');
  });

  it('onToolCall increments counters and observes durations', async () => {
    const collector = new MetricsCollector('test-project', registry);
    collector.onToolCall('semantic_search', 'success', 0.45);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_tool_calls_total{project="test-project",status="success",tool_name="semantic_search"} 1');
    expect(metrics).toContain('nexus_tool_duration_seconds_bucket{le="0.5",project="test-project",tool_name="semantic_search"} 1');
  });

  it('onSearchResults records results counts', async () => {
    const collector = new MetricsCollector('test-project', registry);
    collector.onSearchResults('hybrid', 15);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_search_results_count_bucket{le="25",project="test-project",search_type="hybrid"} 1');
  });

  it('onContextLinesFetched increments line count metrics', async () => {
    const collector = new MetricsCollector('test-project', registry);
    collector.onContextLinesFetched('get_context', 120);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_context_lines_fetched_total{project="test-project",tool_name="get_context"} 120');
  });

  it('onEmbeddingRequest records embedding stats', async () => {
    const collector = new MetricsCollector('test-project', registry);
    collector.onEmbeddingRequest('ollama', 'success', 1.25, 4);

    const metrics = await registry.metrics();
    expect(metrics).toContain('nexus_embedding_requests_total{project="test-project",provider="ollama",status="success"} 1');
    expect(metrics).toContain('nexus_embedding_duration_seconds_bucket{le="2.5",project="test-project",provider="ollama"} 1');
    expect(metrics).toContain('nexus_embedding_batch_size_bucket{le="5",project="test-project",provider="ollama"} 1');
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/observability/metrics-collector.test.ts`
Expected: FAIL due to compilation errors and missing methods in `MetricsHooks`.

- [ ] **Step 4: Modify interfaces and implement collector**

Add the following to `src/observability/types.ts`:
```typescript
// src/observability/types.ts
export interface MetricsHooks {
  // Existing ...
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source?: string): void;
  onChunksIndexed(count: number): void;
  onReindexComplete(durationMs: number, fullRebuild: boolean): void;
  onDlqSnapshot(size: number, source?: string): void;
  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source?: string): void;
  onIndexingProgress(processed: number, total: number, active: boolean): void;

  // New hooks
  onToolCall(toolName: string, status: 'success' | 'error', durationSeconds: number): void;
  onSearchResults(searchType: 'semantic' | 'grep' | 'hybrid', resultCount: number): void;
  onContextLinesFetched(toolName: string, lineCount: number): void;
  onEmbeddingRequest(provider: string, status: 'success' | 'error', durationSeconds: number, batchSize: number): void;
}
```

Update `src/observability/metrics-collector.ts` to implement the new hooks and constructor:
```typescript
// src/observability/metrics-collector.ts
import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import path from 'node:path';
import type { MetricsHooks } from './types.js';
import type { BackpressureState } from '../indexer/event-queue.js';

const BACKPRESSURE_STATES = ['normal', 'overflow', 'full_scan'] as const satisfies readonly BackpressureState[];
const REINDEX_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];

const TOOL_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const SEARCH_RESULTS_BUCKETS = [0, 1, 5, 10, 25, 50, 100, 250];
const EMBEDDING_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const EMBEDDING_BATCH_SIZE_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250];

export class MetricsCollector implements MetricsHooks {
  readonly registry: Registry;

  // Existing gauges...
  private readonly queueSizeGauge: Gauge;
  private readonly queueStateGauge: Gauge;
  private readonly droppedCounter: Counter;
  private readonly chunksCounter: Counter;
  private readonly reindexHistogram: Histogram;
  private readonly dlqSizeGauge: Gauge;
  private readonly recoveryCounter: Counter;
  private readonly indexingActiveGauge: Gauge;
  private readonly indexingProcessedFilesGauge: Gauge;
  private readonly indexingTotalFilesGauge: Gauge;

  // New metrics
  private readonly toolCallsTotal: Counter;
  private readonly toolDurationSeconds: Histogram;
  private readonly searchResultsCount: Histogram;
  private readonly contextLinesFetchedTotal: Counter;
  private readonly embeddingRequestsTotal: Counter;
  private readonly embeddingDurationSeconds: Histogram;
  private readonly embeddingBatchSize: Histogram;

  private readonly prevDroppedBySource = new Map<string, number>();

  constructor(projectNameOrRegistry?: string | Registry, registry?: Registry) {
    let projectName: string | undefined;
    if (projectNameOrRegistry instanceof Registry) {
      this.registry = projectNameOrRegistry;
    } else {
      projectName = projectNameOrRegistry;
      this.registry = registry ?? new Registry();
    }
    
    this.registry.setDefaultLabels({
      project: projectName || process.env.NEXUS_PROJECT_NAME || path.basename(process.cwd()),
      pid: process.pid.toString(),
    });

    // Initialize existing gauges...
    this.queueSizeGauge = new Gauge({
      name: 'nexus_event_queue_size',
      help: 'Current event queue size',
      labelNames: ['queue_id'] as const,
      registers: [this.registry],
    });

    this.queueStateGauge = new Gauge({
      name: 'nexus_event_queue_state',
      help: 'Current backpressure state (1 = active)',
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
      help: 'Current DLQ entry count',
      labelNames: ['dlq_id'] as const,
      registers: [this.registry],
    });

    this.recoveryCounter = new Counter({
      name: 'nexus_dlq_recovery_total',
      help: 'DLQ recovery sweep results',
      labelNames: ['dlq_id', 'result'] as const,
      registers: [this.registry],
    });

    this.indexingActiveGauge = new Gauge({
      name: 'nexus_indexing_active',
      help: 'Whether indexing is currently active (1 = active, 0 = idle)',
      registers: [this.registry],
    });

    this.indexingProcessedFilesGauge = new Gauge({
      name: 'nexus_indexing_processed_files',
      help: 'Number of processed files in the current indexing run',
      registers: [this.registry],
    });

    this.indexingTotalFilesGauge = new Gauge({
      name: 'nexus_indexing_total_files',
      help: 'Total number of files to process in the current indexing run',
      registers: [this.registry],
    });

    // Initialize new metrics
    this.toolCallsTotal = new Counter({
      name: 'nexus_tool_calls_total',
      help: 'Total tool calls count',
      labelNames: ['tool_name', 'status'] as const,
      registers: [this.registry],
    });

    this.toolDurationSeconds = new Histogram({
      name: 'nexus_tool_duration_seconds',
      help: 'Tool execution duration in seconds',
      labelNames: ['tool_name'] as const,
      buckets: TOOL_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.searchResultsCount = new Histogram({
      name: 'nexus_search_results_count',
      help: 'Search hit results count distribution',
      labelNames: ['search_type'] as const,
      buckets: SEARCH_RESULTS_BUCKETS,
      registers: [this.registry],
    });

    this.contextLinesFetchedTotal = new Counter({
      name: 'nexus_context_lines_fetched_total',
      help: 'Total number of lines fetched by context tools',
      labelNames: ['tool_name'] as const,
      registers: [this.registry],
    });

    this.embeddingRequestsTotal = new Counter({
      name: 'nexus_embedding_requests_total',
      help: 'Total embedding provider request count',
      labelNames: ['provider', 'status'] as const,
      registers: [this.registry],
    });

    this.embeddingDurationSeconds = new Histogram({
      name: 'nexus_embedding_duration_seconds',
      help: 'Embedding request duration in seconds',
      labelNames: ['provider'] as const,
      buckets: EMBEDDING_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.embeddingBatchSize = new Histogram({
      name: 'nexus_embedding_batch_size',
      help: 'Embedding request batch size distribution',
      labelNames: ['provider'] as const,
      buckets: EMBEDDING_BATCH_SIZE_BUCKETS,
      registers: [this.registry],
    });
  }

  // Existing methods implementation...
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source = 'default'): void {
    const labels = { queue_id: source };
    this.queueSizeGauge.labels(labels).set(size);
    for (const s of BACKPRESSURE_STATES) {
      this.queueStateGauge.labels({ ...labels, state: s }).set(s === state ? 1 : 0);
    }

    const prevDropped = this.prevDroppedBySource.get(source) ?? 0;
    
    if (droppedTotal < prevDropped) {
      if (droppedTotal > 0) {
        this.droppedCounter.labels(labels).inc(droppedTotal);
      }
    } else {
      const delta = droppedTotal - prevDropped;
      if (delta > 0) {
        this.droppedCounter.labels(labels).inc(delta);
      }
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

  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source = 'default'): void {
    const labels = { dlq_id: source };
    if (retried > 0) this.recoveryCounter.labels({ ...labels, result: 'retried' }).inc(retried);
    if (purged > 0) this.recoveryCounter.labels({ ...labels, result: 'purged' }).inc(purged);
    if (skipped > 0) this.recoveryCounter.labels({ ...labels, result: 'skipped' }).inc(skipped);
    if (abandoned > 0) this.recoveryCounter.labels({ ...labels, result: 'abandoned' }).inc(abandoned);
  }

  onIndexingProgress(processed: number, total: number, active: boolean): void {
    this.indexingActiveGauge.set(active ? 1 : 0);
    this.indexingProcessedFilesGauge.set(processed);
    this.indexingTotalFilesGauge.set(total);
  }

  // Implement new hooks
  onToolCall(toolName: string, status: 'success' | 'error', durationSeconds: number): void {
    this.toolCallsTotal.labels(toolName, status).inc();
    this.toolDurationSeconds.labels(toolName).observe(durationSeconds);
  }

  onSearchResults(searchType: 'semantic' | 'grep' | 'hybrid', resultCount: number): void {
    this.searchResultsCount.labels(searchType).observe(resultCount);
  }

  onContextLinesFetched(toolName: string, lineCount: number): void {
    if (lineCount > 0) {
      this.contextLinesFetchedTotal.labels(toolName).inc(lineCount);
    }
  }

  onEmbeddingRequest(provider: string, status: 'success' | 'error', durationSeconds: number, batchSize: number): void {
    this.embeddingRequestsTotal.labels(provider, status).inc();
    this.embeddingDurationSeconds.labels(provider).observe(durationSeconds);
    this.embeddingBatchSize.labels(provider).observe(batchSize);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/observability/metrics-collector.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add src/observability/types.ts src/observability/metrics-collector.ts tests/unit/observability/metrics-collector.test.ts
git commit -m "feat(observability): expand MetricsHooks and MetricsCollector with app-level metrics"
```

---

### Task 2: Embedding Provider Instrumentation (InstrumentedEmbeddingProvider)

**Files:**
- Create: `src/plugins/embeddings/instrumented.ts`
- Modify: `src/server/factory.ts`
- Test: `tests/unit/plugins/instrumented-embedding.test.ts`

**Interfaces:**
- Consumes:
  - `EmbeddingProvider` from `src/types/index.ts`
  - `MetricsHooks` from `src/observability/types.ts`
- Produces:
  - `InstrumentedEmbeddingProvider` decorator class.

- [ ] **Step 1: Write the failing test**

Create the test file `tests/unit/plugins/instrumented-embedding.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { InstrumentedEmbeddingProvider } from '../../../src/plugins/embeddings/instrumented.js';
import type { EmbeddingProvider } from '../../../src/types/index.js';
import type { MetricsHooks } from '../../../src/observability/types.js';

describe('InstrumentedEmbeddingProvider', () => {
  it('instruments embed calls reporting performance to metricsHooks', async () => {
    const mockInner: EmbeddingProvider = {
      dimensions: 128,
      healthCheck: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    };
    const mockHooks: MetricsHooks = {
      onEmbeddingRequest: vi.fn(),
    } as any;

    const provider = new InstrumentedEmbeddingProvider(mockInner, mockHooks, 'test-provider');
    const result = await provider.embed(['hello']);

    expect(result).toEqual([[0.1, 0.2]]);
    expect(mockInner.embed).toHaveBeenCalledWith(['hello']);
    expect(mockHooks.onEmbeddingRequest).toHaveBeenCalledWith(
      'test-provider',
      'success',
      expect.any(Number),
      1,
    );
  });

  it('instruments failed embed calls reporting error status', async () => {
    const mockInner: EmbeddingProvider = {
      dimensions: 128,
      healthCheck: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockRejectedValue(new Error('Embedding failed')),
    };
    const mockHooks: MetricsHooks = {
      onEmbeddingRequest: vi.fn(),
    } as any;

    const provider = new InstrumentedEmbeddingProvider(mockInner, mockHooks, 'test-provider');
    await expect(provider.embed(['hello'])).rejects.toThrow('Embedding failed');
    expect(mockHooks.onEmbeddingRequest).toHaveBeenCalledWith(
      'test-provider',
      'error',
      expect.any(Number),
      1,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/plugins/instrumented-embedding.test.ts`
Expected: FAIL (cannot resolve imported path / no implementation)

- [ ] **Step 3: Implement InstrumentedEmbeddingProvider and modify factory**

Create `src/plugins/embeddings/instrumented.ts`:
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
        this.providerName,
        'success',
        (performance.now() - start) / 1000,
        texts.length,
      );
      return result;
    } catch (error) {
      this.hooks.onEmbeddingRequest(
        this.providerName,
        'error',
        (performance.now() - start) / 1000,
        texts.length,
      );
      throw error;
    }
  }
}
```

Modify `src/server/factory.ts`:
Import `InstrumentedEmbeddingProvider` at the top:
```typescript
import { InstrumentedEmbeddingProvider } from "../plugins/embeddings/instrumented.js";
```
Wrap `embeddingProvider` initialization in `src/server/factory.ts` (around line 296):
```typescript
    let embeddingProvider = pluginRegistry.getEmbeddingProvider();

    if (!embeddingProvider) {
      throw new Error("No embedding provider configured.");
    }

    embeddingProvider = new InstrumentedEmbeddingProvider(
      embeddingProvider,
      metricsCollector,
      config.embedding.provider,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/plugins/instrumented-embedding.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add src/plugins/embeddings/instrumented.ts src/server/factory.ts tests/unit/plugins/instrumented-embedding.test.ts
git commit -m "feat(observability): instrument EmbeddingProvider using Decorator pattern"
```

---

### Task 3: MCP Tool Metrics Instrumentation (withToolMetrics)

**Files:**
- Create: `src/server/tool-instrumentation.ts`
- Modify: `src/server/index.ts`
- Test: `tests/unit/server/tool-instrumentation.test.ts`

**Interfaces:**
- Consumes:
  - `MetricsHooks` from `src/observability/types.ts`
- Produces:
  - `withToolMetrics` higher-order function.
  - `NexusServerOptions` accepts optional `metricsHooks: MetricsHooks`.

- [ ] **Step 1: Write the failing test**

Modify `tests/unit/server/tool-instrumentation.test.ts` to verify both uncaught exceptions and `isError: true` return values:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { withToolMetrics } from '../../../src/server/tool-instrumentation.js';
import type { MetricsHooks } from '../../../src/observability/types.js';

describe('withToolMetrics', () => {
  it('logs success status and records latency for successful tool calls', async () => {
    const mockHooks: MetricsHooks = {
      onToolCall: vi.fn(),
    } as any;
    const handler = vi.fn().mockResolvedValue({ isError: false, content: [] });
    
    const instrumented = withToolMetrics('test_tool', mockHooks, handler);
    const result = await instrumented('arg1', 2);

    expect(result).toEqual({ isError: false, content: [] });
    expect(handler).toHaveBeenCalledWith('arg1', 2);
    expect(mockHooks.onToolCall).toHaveBeenCalledWith('test_tool', 'success', expect.any(Number));
  });

  it('logs error status when tool handler returns an object with isError: true', async () => {
    const mockHooks: MetricsHooks = {
      onToolCall: vi.fn(),
    } as any;
    const handler = vi.fn().mockResolvedValue({ isError: true, content: [] });

    const instrumented = withToolMetrics('test_tool', mockHooks, handler);
    const result = await instrumented('arg1');

    expect(result).toEqual({ isError: true, content: [] });
    expect(mockHooks.onToolCall).toHaveBeenCalledWith('test_tool', 'error', expect.any(Number));
  });

  it('logs error status and records latency for failed tool calls that throw', async () => {
    const mockHooks: MetricsHooks = {
      onToolCall: vi.fn(),
    } as any;
    const handler = vi.fn().mockRejectedValue(new Error('failure'));

    const instrumented = withToolMetrics('test_tool', mockHooks, handler);
    await expect(instrumented('arg1')).rejects.toThrow('failure');
    expect(mockHooks.onToolCall).toHaveBeenCalledWith('test_tool', 'error', expect.any(Number));
  });

  it('passes through directly if hooks are undefined', async () => {
    const handler = vi.fn().mockResolvedValue({ isError: false, content: [] });
    const instrumented = withToolMetrics('test_tool', undefined, handler);
    const result = await instrumented('arg1');
    expect(result).toEqual({ isError: false, content: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/server/tool-instrumentation.test.ts`
Expected: FAIL (cannot resolve imported path / no implementation)

- [ ] **Step 3: Implement withToolMetrics and modify tool registrations**

Create `src/server/tool-instrumentation.ts` ensuring it validates `result.isError`:
```typescript
import type { MetricsHooks } from '../observability/types.js';

export function withToolMetrics<TArgs extends unknown[], TResult extends { isError?: boolean }>(
  toolName: string,
  hooks: MetricsHooks | undefined,
  handler: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  if (!hooks) return handler;

  return async (...args: TArgs): Promise<TResult> => {
    const start = performance.now();
    try {
      const result = await handler(...args);
      const status = result.isError ? 'error' : 'success';
      hooks.onToolCall(toolName, status, (performance.now() - start) / 1000);
      return result;
    } catch (error) {
      hooks.onToolCall(toolName, 'error', (performance.now() - start) / 1000);
      throw error;
    }
  };
}
```

Modify `src/server/index.ts`:
Import `withToolMetrics` at the top:
```typescript
import { withToolMetrics } from "./tool-instrumentation.js";
import type { MetricsHooks } from "../observability/types.js";
```

Update `NexusServerOptions` in `src/server/index.ts`:
```typescript
export interface NexusServerOptions {
  projectRoot: string;
  sanitizer: PathSanitizer;
  semanticSearch: ISemanticSearch;
  grepEngine: IGrepEngine;
  orchestrator: SearchOrchestrator;
  vectorStore: IVectorStore;
  metadataStore: IMetadataStore;
  pipeline: IIndexPipeline;
  pluginRegistry: PluginRegistry;
  runReindex: (options?: ReindexOptions) => Promise<IndexEvent[]>;
  loadFileContent: (filePath: string) => Promise<string>;
  metricsHooks?: MetricsHooks;
}
```

Update `buildNexusRuntime` in `src/server/index.ts` to forward `metricsHooks` from `options` directly to `createNexusServer`:
```typescript
export const buildNexusRuntime = (
  options: NexusRuntimeOptions,
): NexusRuntime => {
  const server = createNexusServer(options, () => initialize());
  // ...
```
And add properties to `NexusRuntimeOptions` in `src/server/index.ts`:
```typescript
export interface NexusRuntimeOptions extends NexusServerOptions {
  watcher: IFileWatcher;
  onClose?: () => Promise<void>;
  metricsCollectorRegistry?: Registry;
  metricsPort?: number;
  storageDir?: string;
  projectName?: string;
  aggregatorPort?: number; // Add this
}
```

Wrap tool handlers with `withToolMetrics` in `createNexusServer` in `src/server/index.ts`:
```typescript
  server.registerTool(
    "semantic_search",
    {
      description: "Search the codebase using natural language (embeddings)",
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        language: z.string().optional(),
      },
    },
    withToolMetrics(
      "semantic_search",
      options.metricsHooks,
      async (args, extra) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeSemanticSearch(
            options.semanticSearch,
            options.sanitizer,
            args as SemanticSearchToolArgs & { filePattern?: string },
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('semantic', result.results.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "grep_search",
    {
      description: "ripgrep-based text search",
      inputSchema: {
        pattern: z.string(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    withToolMetrics(
      "grep_search",
      options.metricsHooks,
      async (args, extra) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeGrepSearch(
            options.grepEngine,
            options.projectRoot,
            options.sanitizer,
            args as GrepSearchToolArgs,
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('grep', result.matches.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "hybrid_search",
    {
      description: "Combined semantic and grep search",
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        language: z.string().optional(),
        grepPattern: z.string().optional(),
      },
    },
    withToolMetrics(
      "hybrid_search",
      options.metricsHooks,
      async (args, extra) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeHybridSearch(
            options.orchestrator,
            options.sanitizer,
            args as HybridSearchToolArgs & { filePattern?: string },
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('hybrid', result.results.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "get_context",
    {
      description: "Retrieve file context",
      inputSchema: {
        filePath: z.string(),
        symbolName: z.string().optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
    },
    withToolMetrics(
      "get_context",
      options.metricsHooks,
      async (args) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeGetContext(
            options.loadFileContent,
            options.sanitizer,
            args,
          );
          const lineCount = result.endLine - result.startLine + 1;
          if (lineCount > 0) {
            options.metricsHooks?.onContextLinesFetched('get_context', lineCount);
          }
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "index_status",
    {
      description: "Return index state and statistics",
      inputSchema: {},
    },
    withToolMetrics(
      "index_status",
      options.metricsHooks,
      async () => {
        if (awaitInitialize) await awaitInitialize();
        try {
          return toolResult(
            await executeIndexStatus(
              options.metadataStore,
              options.vectorStore,
              options.pluginRegistry,
              options.pipeline,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "reindex",
    {
      description: "Manually trigger reindexing",
      inputSchema: {
        fullRebuild: z.boolean().optional(),
      },
    },
    withToolMetrics(
      "reindex",
      options.metricsHooks,
      async (args) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          return toolResult(
            await executeReindex(
              options.pipeline,
              options.runReindex,
              options.loadFileContent,
              args,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/server/tool-instrumentation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add src/server/tool-instrumentation.ts src/server/index.ts tests/unit/server/tool-instrumentation.test.ts
git commit -m "feat(observability): instrument MCP tools using withToolMetrics wrapper with error check"
```

---

### Task 4: Aggregator Server & Prometheus Serializer

**Files:**
- Create: `packages/dashboard/src/server/aggregator.ts`
- Create: `packages/dashboard/tests/unit/aggregator.test.ts`
- Create: `packages/dashboard/tests/unit/health-checker.test.ts`
- Create: `packages/dashboard/tests/unit/prometheus-serializer.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `AggregatorServer` class (start, stop, nodes mapping).
  - `HealthChecker` class (start, stop).
  - `serializeToPrometheus` utility function.

- [ ] **Step 1: Write the failing tests**

Create the test file `packages/dashboard/tests/unit/prometheus-serializer.test.ts` with multi-node Histogram test verifying count and line ordering:
```typescript
import { describe, it, expect } from 'vitest';
import { serializeToPrometheus } from '../../src/server/aggregator.js';

describe('serializeToPrometheus', () => {
  it('merges metrics from multiple sources grouping by metric name', () => {
    const source1 = [
      {
        name: 'nexus_tool_calls_total',
        help: 'Total tool calls count',
        type: 'counter',
        values: [
          { value: 10, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search', status: 'success' } }
        ]
      }
    ];

    const source2 = [
      {
        name: 'nexus_tool_calls_total',
        help: 'Total tool calls count',
        type: 'counter',
        values: [
          { value: 5, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search', status: 'success' } }
        ]
      }
    ];

    const output = serializeToPrometheus([source1, source2]);
    expect(output).toContain('# HELP nexus_tool_calls_total Total tool calls count');
    expect(output).toContain('# TYPE nexus_tool_calls_total counter');
    expect(output).toContain('nexus_tool_calls_total{project="foo",pid="123",tool_name="hybrid_search",status="success"} 10');
    expect(output).toContain('nexus_tool_calls_total{project="bar",pid="456",tool_name="hybrid_search",status="success"} 5');
  });

  it('escapes Prometheus label values', () => {
    const source = [
      {
        name: 'nexus_tool_calls_total',
        help: 'Total tool calls count',
        type: 'counter',
        values: [
          { value: 1, labels: { project: 'foo"bar', pid: '123\\456', tool_name: 'line\nbreak', status: 'success' } }
        ]
      }
    ];

    const output = serializeToPrometheus([source]);
    expect(output).toContain('project="foo\\"bar"');
    expect(output).toContain('pid="123\\\\456"');
    expect(output).toContain('tool_name="line\\nbreak"');
  });

  it('sorts metric groups by metric name for stable output', () => {
    const source = [
      {
        name: 'z_metric_total',
        help: 'Z metric',
        type: 'counter',
        values: [{ value: 1, labels: {} }]
      },
      {
        name: 'a_metric_total',
        help: 'A metric',
        type: 'counter',
        values: [{ value: 1, labels: {} }]
      }
    ];

    const output = serializeToPrometheus([source]);
    expect(output.indexOf('# HELP a_metric_total')).toBeLessThan(output.indexOf('# HELP z_metric_total'));
  });

  it('handles histogram metrics correctly combining buckets, sum, and count from multiple sources with order validation', () => {
    const source1 = [
      {
        name: 'nexus_tool_duration_seconds',
        help: 'Tool execution duration',
        type: 'histogram',
        values: [
          { value: 2, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search', le: '0.1' }, metricName: 'nexus_tool_duration_seconds_bucket' },
          { value: 1.25, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_sum' },
          { value: 2, labels: { project: 'foo', pid: '123', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_count' }
        ]
      }
    ];

    const source2 = [
      {
        name: 'nexus_tool_duration_seconds',
        help: 'Tool execution duration',
        type: 'histogram',
        values: [
          { value: 1, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search', le: '0.1' }, metricName: 'nexus_tool_duration_seconds_bucket' },
          { value: 0.05, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_sum' },
          { value: 1, labels: { project: 'bar', pid: '456', tool_name: 'hybrid_search' }, metricName: 'nexus_tool_duration_seconds_count' }
        ]
      }
    ];

    const output = serializeToPrometheus([source1, source2]);
    expect(output).toContain('# HELP nexus_tool_duration_seconds Tool execution duration');
    expect(output).toContain('# TYPE nexus_tool_duration_seconds histogram');
    
    // Validate value presence
    expect(output).toContain('nexus_tool_duration_seconds_bucket{project="foo",pid="123",tool_name="hybrid_search",le="0.1"} 2');
    expect(output).toContain('nexus_tool_duration_seconds_sum{project="foo",pid="123",tool_name="hybrid_search"} 1.25');
    expect(output).toContain('nexus_tool_duration_seconds_count{project="foo",pid="123",tool_name="hybrid_search"} 2');
    
    expect(output).toContain('nexus_tool_duration_seconds_bucket{project="bar",pid="456",tool_name="hybrid_search",le="0.1"} 1');
    expect(output).toContain('nexus_tool_duration_seconds_sum{project="bar",pid="456",tool_name="hybrid_search"} 0.05');
    expect(output).toContain('nexus_tool_duration_seconds_count{project="bar",pid="456",tool_name="hybrid_search"} 1');

    // Validate correct ordering (HELP -> TYPE -> values, and values: bucket -> sum -> count)
    const posHelp = output.indexOf('# HELP nexus_tool_duration_seconds');
    const posType = output.indexOf('# TYPE nexus_tool_duration_seconds');
    const posBucketFoo = output.indexOf('nexus_tool_duration_seconds_bucket{project="foo"');
    const posSumFoo = output.indexOf('nexus_tool_duration_seconds_sum{project="foo"');
    const posCountFoo = output.indexOf('nexus_tool_duration_seconds_count{project="foo"');

    expect(posHelp).toBeLessThan(posType);
    expect(posType).toBeLessThan(posBucketFoo);
    expect(posBucketFoo).toBeLessThan(posSumFoo);
    expect(posSumFoo).toBeLessThan(posCountFoo);
  });
});
```

Create `packages/dashboard/tests/unit/health-checker.test.ts` ensuring fake timers are restored:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthChecker } from '../../src/server/aggregator.js';

describe('HealthChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // Restore real timers
  });

  it('evicts unhealthy nodes from the mapping', async () => {
    const nodes = new Map<number, any>([
      [9001, { projectId: 'foo', metricsPort: 9001, pid: 123 }],
      [9002, { projectId: 'bar', metricsPort: 9002, pid: 456 }],
    ]);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('9001')) {
        return { ok: true };
      }
      throw new Error('Network timeout');
    });

    const checker = new HealthChecker(nodes, 1000, 200, mockFetch);
    checker.start();

    // Advance time to trigger checkAll
    await vi.advanceTimersByTimeAsync(1000);

    expect(nodes.has(9001)).toBe(true);
    expect(nodes.has(9002)).toBe(false); // Evicted

    checker.stop();
  });

  it('evicts nodes that respond with non-ok status', async () => {
    const nodes = new Map<number, any>([
      [9001, { projectId: 'foo', metricsPort: 9001, pid: 123 }],
    ]);

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const checker = new HealthChecker(nodes, 1000, 200, mockFetch);
    checker.start();

    await vi.advanceTimersByTimeAsync(1000);

    expect(nodes.has(9001)).toBe(false); // Evicted due to status error
    checker.stop();
  });
});
```

Create `packages/dashboard/tests/unit/aggregator.test.ts` testing both basic registering and stop() idempotency under partial failures:
```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { AggregatorServer } from '../../src/server/aggregator.js';

describe('AggregatorServer', () => {
  let server: AggregatorServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('accepts node registrations and exposes node information', async () => {
    server = new AggregatorServer();
    await server.start(0);
    const serverPort = (server as any).server.address().port;

    const registerRes = await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test-project',
        metricsPort: 9500,
        pid: 999
      })
    });
    expect(registerRes.status).toBe(201);

    const nodesRes = await fetch(`http://127.0.0.1:${serverPort}/api/discovery/nodes`);
    const nodes = await nodesRes.json();
    expect(nodes).toEqual([
      {
        projectId: 'test-project',
        metricsPort: 9500,
        pid: 999,
        registeredAt: expect.any(Number)
      }
    ]);
  });

  it('tolerates stop() calls when start() failed and server is partially initialized', async () => {
    // We start on an in-use port to cause failure
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as any).port;

    server = new AggregatorServer();
    // Start should reject due to EADDRINUSE (port already bound)
    await expect(server.start(port)).rejects.toThrow();

    // Now stop() should resolve safely without throwing EADDRINUSE or server not listening errors
    await expect(server.stop()).resolves.toBeUndefined();

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('skips nodes that return non-array metrics JSON', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(null),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            name: 'nexus_valid_metric_total',
            help: 'Valid metric',
            type: 'counter',
            values: [{ labels: { project: 'test-project', pid: '999' }, value: 1 }],
          },
        ]),
      });
    server = new AggregatorServer(mockFetch as unknown as typeof fetch);
    await server.start(0);
    const serverPort = (server as any).server.address().port;

    await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test-project',
        metricsPort: 9500,
        pid: 999,
      }),
    });

    await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test-project',
        metricsPort: 9501,
        pid: 1000,
      }),
    });

    const metricsRes = await fetch(`http://127.0.0.1:${serverPort}/metrics`);
    expect(metricsRes.status).toBe(200);
    expect(await metricsRes.text()).toContain('nexus_valid_metric_total');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/dashboard/tests/unit`
Expected: FAIL (cannot resolve imported path / no implementation)

- [ ] **Step 3: Implement AggregatorServer and HealthChecker**

Create `packages/dashboard/src/server/aggregator.ts`:
```typescript
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface RegisteredNode {
  projectId: string;
  metricsPort: number;
  pid: number;
  registeredAt: number;
}

export interface MetricValue {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

export interface MetricObject {
  name: string;
  help: string;
  type: string;
  values: MetricValue[];
}

export class HealthChecker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly nodes: Map<number, RegisteredNode>,
    private readonly intervalMs: number = 15_000,
    private readonly timeoutMs: number = 2_000,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async checkAll(): Promise<void> {
    const checks = [...this.nodes.entries()].map(async ([port]) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`http://127.0.0.1:${port}/health`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error('Unhealthy');
        }
      } catch {
        this.nodes.delete(port);
      } finally {
        clearTimeout(timeout);
      }
    });
    await Promise.allSettled(checks);
  }
}

export function serializeToPrometheus(metricsLists: MetricObject[][]): string {
  const mergedMap = new Map<string, { help: string; type: string; values: MetricValue[] }>();

  for (const list of metricsLists) {
    for (const metric of list) {
      if (!mergedMap.has(metric.name)) {
        mergedMap.set(metric.name, {
          help: metric.help,
          type: metric.type,
          values: [],
        });
      }
      const entry = mergedMap.get(metric.name)!;
      entry.values.push(...metric.values);
    }
  }

  const escapeLabelValue = (val: string): string => {
    return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  };

  const lines: string[] = [];
  const sortedEntries = [...mergedMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, metric] of sortedEntries) {
    lines.push(`# HELP ${name} ${metric.help}`);
    lines.push(`# TYPE ${name} ${metric.type}`);
    for (const val of metric.values) {
      const labelsStr = Object.keys(val.labels).length > 0
        ? `{${Object.entries(val.labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
        : '';
      const metricName = val.metricName || name;
      lines.push(`${metricName}${labelsStr} ${val.value}`);
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

export class AggregatorServer {
  private server: Server | null = null;
  private healthChecker: HealthChecker | null = null;
  readonly nodes = new Map<number, RegisteredNode>();

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async start(port: number): Promise<void> {
    this.healthChecker = new HealthChecker(this.nodes, 15_000, 2_000, this.fetchFn);
    this.healthChecker.start();

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', (err) => {
        reject(err);
      });
      this.server!.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.healthChecker?.stop();
    this.nodes.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        // ERR_SERVER_NOT_RUNNING (server not listening yet) is expected
        // if stop() is called after a failed start(), so we ignore it safely.
        // (未listen状態の ERR_SERVER_NOT_RUNNING は正常な cleanup として無視する)
        this.server!.close((err) => {
          resolve();
        });
      });
      this.server = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    
    if (req.method === 'POST' && url.pathname === '/api/discovery/register') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (typeof payload.projectId !== 'string' || typeof payload.metricsPort !== 'number' || typeof payload.pid !== 'number') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid payload' }));
            return;
          }
          const isNew = !this.nodes.has(payload.metricsPort);
          this.nodes.set(payload.metricsPort, {
            projectId: payload.projectId,
            metricsPort: payload.metricsPort,
            pid: payload.pid,
            registeredAt: Date.now(),
          });
          res.writeHead(isNew ? 201 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad request' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      void this.handleMetrics(res).catch(() => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (!res.destroyed) {
          res.end('Internal Server Error');
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', nodes: this.nodes.size }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/discovery/nodes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...this.nodes.values()]));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private async handleMetrics(res: ServerResponse): Promise<void> {
    const fetchPromises = [...this.nodes.values()].map(async (node) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await this.fetchFn(`http://127.0.0.1:${node.metricsPort}/metrics/json`, {
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Not OK');
        return await response.json();
      } finally {
        clearTimeout(id);
      }
    });

    const results = await Promise.allSettled(fetchPromises);
    const metricsLists = results
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((value): value is MetricObject[] => Array.isArray(value));

    const mergedText = serializeToPrometheus(metricsLists);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(mergedText);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/dashboard/tests/unit`
Expected: PASS

- [ ] **Step 5: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add packages/dashboard/src/server/aggregator.ts packages/dashboard/tests/unit/
git commit -m "feat(observability): implement telemetry AggregatorServer and HealthChecker"
```

---

### Task 5: Heartbeat Client & App Config Changes

**Files:**
- Create: `src/observability/registration-client.ts`
- Modify: `src/types/index.ts`
- Modify: `src/config/index.ts`
- Modify: `src/server/factory.ts`
- Modify: `src/server/index.ts`
- Create: `tests/unit/observability/registration-client.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `RegistrationClient` (start, stop).
  - Config object updated with `aggregatorPort` and `projectName`.

- [ ] **Step 1: Write the failing tests**

Create the test file `tests/unit/observability/registration-client.test.ts` ensuring fake timers are restored:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RegistrationClient } from '../../../src/observability/registration-client.js';

describe('RegistrationClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // Restore real timers
  });

  it('triggers immediate registration on start and sends periodic heartbeats', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const payload = { projectId: 'test', metricsPort: 8080, pid: 123 };
    const config = { aggregatorPort: 9470, heartbeatIntervalMs: 1000, requestTimeoutMs: 200 };

    const client = new RegistrationClient(payload, config, mockFetch);
    client.start();

    // Verify immediate registration trigger
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9470/api/discovery/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload)
      })
    );

    // Verify heartbeat tick
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    client.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/observability/registration-client.test.ts`
Expected: FAIL (cannot resolve imported path / no implementation)

- [ ] **Step 3: Implement client, update config loader, factory, and server**

Create `src/observability/registration-client.ts`:
```typescript
export interface RegistrationConfig {
  aggregatorPort: number;
  heartbeatIntervalMs: number;
  requestTimeoutMs: number;
}

export class RegistrationClient {
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
    void this.register();
    this.timer = setInterval(() => void this.register(), this.config.heartbeatIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
      this.logger?.debug?.('Aggregator registration failed (non-fatal):', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

Modify `src/types/index.ts` to add new config properties:
```typescript
// src/types/index.ts
export interface Config {
  projectRoot: string;
  storage: StorageConfig;
  watcher: WatcherConfig;
  embedding: EmbeddingConfig;
  indexing: IndexingConfig;
  metricsPort?: number;
  aggregatorPort?: number; // Add this
  projectName?: string;    // Add this
}
```

Modify `src/config/index.ts` to load new configuration variables from `.nexus.json` (as priority 2) and environment variables (as priority 3):
```typescript
// src/config/index.ts:152-156
    metricsPort:
      asPortNumber(env.NEXUS_METRICS_PORT) ??
      validatePortNumber(fileConfig.metricsPort) ??
      undefined,
    aggregatorPort:
      validatePortNumber(fileConfig.aggregatorPort) ??
      asPortNumber(env.NEXUS_AGGREGATOR_PORT) ??
      undefined,
    projectName:
      validateString(fileConfig.projectName) ??
      asString(env.NEXUS_PROJECT_NAME) ??
      undefined,
```

Modify `src/server/factory.ts` to pass `aggregatorPort` and `projectName` down to `buildNexusRuntime` options:
```typescript
// src/server/factory.ts
      return buildNexusRuntime({
        projectRoot,
        sanitizer: await PathSanitizer.create(projectRoot),
        semanticSearch,
        grepEngine,
        orchestrator,
        vectorStore,
        metadataStore,
        pipeline,
        pluginRegistry,
        watcher,
        loadFileContent,
        metricsCollectorRegistry: metricsCollector.registry,
        metricsHooks: metricsCollector,
        projectName: config.projectName,
        aggregatorPort: config.aggregatorPort, // Add this
        metricsPort: config.metricsPort,
        storageDir: config.storage.rootDir,
        // ...
```

Modify `src/server/index.ts` to declare `registrationClient` at the **top-level closure scope** of `buildNexusRuntime` (so it is visible to both `initialize()` and `close()`), and start it independently of the `storageDir` port file writing check:
```typescript
// src/server/index.ts
import { RegistrationClient } from "../observability/registration-client.js";

export interface NexusRuntime {
  server: McpServer;
  orchestrator: SearchOrchestrator;
  sanitizer: PathSanitizer;
  initialize(): Promise<void>;
  close(): Promise<void>;
  reindex(fullRebuild?: boolean): Promise<void>;
  registrationClient?: RegistrationClient | null;
}

export const buildNexusRuntime = (
  options: NexusRuntimeOptions,
): NexusRuntime => {
  const server = createNexusServer(options, () => initialize());
  let metricsServer: MetricsHttpServer | null = null;
  let initPromise: Promise<void> | null = null;
  let registrationClient: RegistrationClient | null = null; // ★ IMPORTANT: Declared in the closure scope of buildNexusRuntime

  const initialize = (): Promise<void> => {
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      await options.metadataStore.initialize();
      await options.vectorStore.initialize();
      await options.pipeline.reconcileOnStartup();

      try {
        options.pipeline.start();
        await options.watcher.start().catch((error) => {
          // fatal vs non-fatal error checks...
        });

        const preferredPort = options.metricsPort ?? 0;
        metricsServer = options.metricsCollectorRegistry
          ? new MetricsHttpServer(options.metricsCollectorRegistry)
          : null;

        if (metricsServer) {
          await metricsServer.start(preferredPort).catch((err) => {
            console.warn("[Nexus] Failed to start metrics HTTP server:", err);
          });
          const resolvedPort = metricsServer.getPort();
          
          if (resolvedPort !== undefined) {
            // ★ RegistrationClient only depends on resolvedPort, NOT storageDir
            registrationClient = new RegistrationClient(
              {
                projectId: options.projectName || path.basename(options.projectRoot),
                metricsPort: resolvedPort,
                pid: process.pid,
              },
              {
                aggregatorPort: options.aggregatorPort ?? 9470,
                heartbeatIntervalMs: 30_000,
                requestTimeoutMs: 1_000,
              }
            );
            registrationClient.start();

            // Only execute file port write/remove operations if storageDir exists
            if (options.storageDir) {
              await writeMetricsPort(options.storageDir, resolvedPort).catch((err) => {
                console.warn("[Nexus] Failed to write metrics port file:", err);
              });
            }
          } else if (options.storageDir) {
            await removeMetricsPort(options.storageDir).catch((err) => {
              console.warn("[Nexus] Failed to remove stale metrics port file:", err);
            });
          }
        }
      } catch (error) {
        // pipeline stop / watcher stop rollback logic...
        throw error;
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
    return initPromise;
  };

  const close = async () => {
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Rolled back
      }
    }

    if (registrationClient) {
      registrationClient.stop(); // Safe teardown due to closure visibility
      registrationClient = null;
    }

    if (metricsServer) {
      try {
        await metricsServer.stop();
      } catch (error) {
        // Shutdown errors
      }
      if (options.storageDir) {
        await removeMetricsPort(options.storageDir).catch(() => {});
      }
    }
    // Existing close logic...
  };

  return {
    server,
    orchestrator,
    sanitizer,
    initialize,
    close,
    reindex: (fullRebuild) => initialize().then(() => options.runReindex({ fullScan: fullRebuild }).then(() => {})),
    get registrationClient() { return registrationClient; } // Expose via getter
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/observability/registration-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add src/observability/registration-client.ts src/types/index.ts src/config/index.ts src/server/factory.ts src/server/index.ts tests/unit/observability/registration-client.test.ts
git commit -m "feat(observability): integrate RegistrationClient (Heartbeat client) into server initialization"
```

---

### Task 6: TUI CLI Integration & Seamless Auto-start

**Files:**
- Modify: `packages/dashboard/src/cli.ts`
- Create: `packages/dashboard/tests/integration/cli.test.ts`

**Interfaces:**
- Consumes:
  - `AggregatorServer` from `packages/dashboard/src/server/aggregator.ts`
- Produces: None

- [ ] **Step 1: Write the integration test verifying start/stop and EADDRINUSE**

Create the test file `packages/dashboard/tests/integration/cli.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../../src/cli.js';
import { AggregatorServer } from '../../src/server/aggregator.js';

// We mock ink rendering to check if cli setup succeeds without blocking
vi.mock('ink', () => ({
  render: () => ({
    waitUntilExit: () => Promise.resolve()
  })
}));

describe('cli integration', () => {
  let startSpy: any;
  let stopSpy: any;

  beforeEach(() => {
    startSpy = vi.spyOn(AggregatorServer.prototype, 'start').mockResolvedValue(undefined);
    stopSpy = vi.spyOn(AggregatorServer.prototype, 'stop').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts and stops AggregatorServer when running dashboard CLI', async () => {
    process.argv = ['node', 'cli.js', '--project-root', './', '--port', '9500', '--aggregator-port', '9470'];
    await main();

    expect(startSpy).toHaveBeenCalledWith(9470);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('tolerates EADDRINUSE during AggregatorServer startup and continues running', async () => {
    const error = new Error('Address already in use');
    (error as any).code = 'EADDRINUSE';
    startSpy.mockRejectedValue(error);

    process.argv = ['node', 'cli.js', '--project-root', './', '--port', '9500', '--aggregator-port', '9470'];
    
    // Should not throw, should resolve successfully
    await expect(main()).resolves.toBeUndefined();
    expect(startSpy).toHaveBeenCalledWith(9470);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('exits when aggregator port is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.argv = ['node', 'cli.js', '--project-root', './', '--port', '9500', '--aggregator-port', 'abc'];

    await expect(main()).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --aggregator-port value "abc"'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/dashboard/tests/integration/cli.test.ts`
Expected: FAIL (AggregatorServer not imported/used in cli.ts)

- [ ] **Step 3: Modify CLI handler to load and run AggregatorServer**

Modify `packages/dashboard/src/cli.ts` ensuring we wrap Aggregator stop in try-finally block:
```typescript
export async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      interval: { type: "string", default: "2000" },
      "project-root": { type: "string" },
      "aggregator-port": { type: "string" },
    },
    strict: true,
  });

  const parsePortOption = (raw: string, optionName: string): number => {
    if (!/^\d+$/.test(raw)) {
      console.error(`[Nexus Dashboard] Invalid ${optionName} value "${raw}". Please specify a valid port number (1-65535).`);
      process.exit(1);
    }
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`[Nexus Dashboard] Invalid ${optionName} value "${raw}". Please specify a valid port number (1-65535).`);
      process.exit(1);
    }
    return parsed;
  };

  const projectRoot = (() => {
    const raw = values["project-root"];
    return raw ? path.resolve(raw) : process.cwd();
  })();

  const storageDir = await resolveStorageDir(projectRoot);
  const autoPort = await readMetricsPortFile(storageDir);

  const port = (() => {
    if (values.port !== undefined) {
      return parsePortOption(values.port, '--port');
    }
    if (autoPort !== undefined) {
      return autoPort;
    }
    console.error(
      `[Nexus Dashboard] Could not determine metrics port for project: ${projectRoot}\n` +
      `  Storage dir: ${storageDir}\n` +
      `  No metrics.port file found. Is the Nexus server running for this project?\n` +
      `  Hint: Start the server first, or specify the port with --port <number>.`
    );
    process.exit(1);
  })();

  const interval = (() => {
    const rawInterval = values.interval as string;
    if (!/^\d+$/.test(rawInterval)) {
      console.warn(`Invalid --interval value "${rawInterval}", falling back to 2000 (min 1000ms)`);
      return 2000;
    }
    const parsed = parseInt(rawInterval, 10);
    if (isNaN(parsed) || parsed < 1000) {
      console.warn(`Invalid --interval value "${rawInterval}", falling back to 2000 (min 1000ms)`);
      return 2000;
    }
    return parsed;
  })();

  // Resolve aggregatorPort
  const aggregatorPort = (() => {
    if (values["aggregator-port"] !== undefined) {
      return parsePortOption(values["aggregator-port"], '--aggregator-port');
    }
    if (process.env.NEXUS_AGGREGATOR_PORT) {
      return parsePortOption(process.env.NEXUS_AGGREGATOR_PORT, 'NEXUS_AGGREGATOR_PORT');
    }
    return 9470;
  })();

  const aggregator = new AggregatorServer();
  try {
    await aggregator.start(aggregatorPort);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.warn(`[Nexus Dashboard] Aggregator already running on port ${aggregatorPort}, skipping setup.`);
    } else {
      console.error('[Nexus Dashboard] Failed to start aggregator:', err);
    }
  }

  // ★ Encapsulate the rest of rendering in a try-finally block to guarantee server teardown
  try {
    const { waitUntilExit } = render(React.createElement(App, { port, interval }));
    await waitUntilExit();
  } finally {
    await aggregator.stop();
  }
}
```

- [ ] **Step 4: Run integration test to verify it passes**

Run: `npx vitest run packages/dashboard/tests/integration/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add packages/dashboard/src/cli.ts packages/dashboard/tests/integration/cli.test.ts
git commit -m "feat(observability): integrate AggregatorServer with CLI dashboard"
```

---

### Task 7: Grafana Provisioning JSON & Setup Guide

**Files:**
- Create: `docs/observability/grafana-dashboard.json`
- Create: `docs/observability/README.md`

**Interfaces:** None

- [ ] **Step 1: Write setup guide document**

Create `docs/observability/README.md` containing the setup instructions and full metrics catalog:
```markdown
# Nexus Observability Setup Guide

This guide describes how to configure Prometheus and Grafana to scrape merged metrics from the Nexus Aggregator.

## How it works

1. Multiple Nexus server processes register themselves with the Dashboard CLI's central Aggregator.
2. The Aggregator runs on port `9470` by default.
3. Scraping `localhost:9470/metrics` collects merged, label-isolated metrics from all registered processes.

## Prometheus Configuration

Add the following scrape configuration to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'nexus'
    scrape_interval: 10s
    static_configs:
      - targets: ['localhost:9470']
```

## Grafana Dashboard Import

Import the JSON file at `docs/observability/grafana-dashboard.json` into Grafana:
1. Open Grafana Dashboard.
2. Click **Dashboards** -> **New** -> **Import**.
3. Upload `grafana-dashboard.json`.
4. Choose the appropriate Prometheus datasource. (Note: If the datasource variable does not resolve automatically, manually select your Prometheus datasource during import.)

## Metrics Index (Full Catalog)

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `nexus_event_queue_size` | Gauge | `project`, `pid`, `queue_id` | Current event queue size |
| `nexus_event_queue_state` | Gauge | `project`, `pid`, `queue_id`, `state` | Current backpressure state (1 = active) |
| `nexus_event_queue_dropped_total` | Counter | `project`, `pid`, `queue_id` | Total dropped events due to overflow |
| `nexus_indexing_chunks_total` | Counter | `project`, `pid` | Total chunks indexed |
| `nexus_reindex_duration_seconds` | Histogram | `project`, `pid`, `full_rebuild` | Duration of reindex runs |
| `nexus_dlq_size` | Gauge | `project`, `pid`, `dlq_id` | Current DLQ entry count |
| `nexus_dlq_recovery_total` | Counter | `project`, `pid`, `dlq_id`, `result` | DLQ recovery sweep results |
| `nexus_indexing_active` | Gauge | `project`, `pid` | Whether indexing run is active (1 = active) |
| `nexus_indexing_processed_files` | Gauge | `project`, `pid` | Processed files count in current run |
| `nexus_indexing_total_files` | Gauge | `project`, `pid` | Total files to process in current run |
| `nexus_tool_calls_total` | Counter | `project`, `pid`, `tool_name`, `status` | Cumulative tool calls count |
| `nexus_tool_duration_seconds` | Histogram | `project`, `pid`, `tool_name` | Latency distribution of tool calls |
| `nexus_search_results_count` | Histogram | `project`, `pid`, `search_type` | Hits count per search query |
| `nexus_context_lines_fetched_total` | Counter | `project`, `pid`, `tool_name` | Cumulative lines fetched by code viewer |
| `nexus_embedding_requests_total` | Counter | `project`, `pid`, `provider`, `status` | Embedding provider requests count |
| `nexus_embedding_duration_seconds` | Histogram | `project`, `pid`, `provider` | Embedding request latency |
```

- [ ] **Step 2: Create the Grafana Dashboard JSON**

Create the JSON payload at `docs/observability/grafana-dashboard.json` containing variable definitions and 4 row panel setups.

```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": {
          "type": "datasource",
          "uid": "grafana"
        },
        "enable": true,
        "hide": true,
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 0 },
      "id": 1,
      "title": "Agent Activity Overview",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 1 },
      "id": 2,
      "title": "Total Tool Calls (1h)",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(increase(nexus_tool_calls_total{project=~\"$project\"}[1h]))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 4, "w": 6, "x": 6, "y": 1 },
      "id": 3,
      "title": "Total Context Lines Fetched (1h)",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(increase(nexus_context_lines_fetched_total{project=~\"$project\"}[1h]))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 1 },
      "id": 4,
      "title": "Avg Search Latency",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(rate(nexus_tool_duration_seconds_sum{project=~\"$project\",tool_name=~\"hybrid_search|semantic_search|grep_search\"}[5m])) / sum(rate(nexus_tool_duration_seconds_count{project=~\"$project\",tool_name=~\"hybrid_search|semantic_search|grep_search\"}[5m]))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 1 },
      "id": 5,
      "title": "Tool Usage Breakdown",
      "type": "piechart",
      "targets": [
        {
          "expr": "sum by (tool_name) (increase(nexus_tool_calls_total{project=~\"$project\"}[1h]))",
          "refId": "A"
        }
      ]
    },
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 5 },
      "id": 6,
      "title": "Search Quality & Performance",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 0, "y": 6 },
      "id": 7,
      "title": "Tool Latency P95",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum by (le, tool_name) (rate(nexus_tool_duration_seconds_bucket{project=~\"$project\"}[5m])))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 6, "y": 6 },
      "id": 8,
      "title": "Tool Latency P99",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum by (le, tool_name) (rate(nexus_tool_duration_seconds_bucket{project=~\"$project\"}[5m])))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 12, "y": 6 },
      "id": 9,
      "title": "Avg Results per Search",
      "type": "bargauge",
      "targets": [
        {
          "expr": "sum by (search_type) (rate(nexus_search_results_count_sum{project=~\"$project\"}[5m])) / sum by (search_type) (rate(nexus_search_results_count_count{project=~\"$project\"}[5m]))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 18, "y": 6 },
      "id": 10,
      "title": "Error Rate by Tool",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum by (tool_name) (rate(nexus_tool_calls_total{project=~\"$project\",status=\"error\"}[5m]))",
          "refId": "A"
        }
      ]
    },
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 12 },
      "id": 11,
      "title": "Indexing Pipeline Health",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 0, "y": 13 },
      "id": 12,
      "title": "Event Queue Size",
      "type": "timeseries",
      "targets": [
        {
          "expr": "nexus_event_queue_size{project=~\"$project\"}",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 6, "y": 13 },
      "id": 13,
      "title": "Dropped Events Rate",
      "type": "timeseries",
      "targets": [
        {
          "expr": "rate(nexus_event_queue_dropped_total{project=~\"$project\"}[5m])",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 12, "y": 13 },
      "id": 14,
      "title": "DLQ Size",
      "type": "stat",
      "targets": [
        {
          "expr": "nexus_dlq_size{project=~\"$project\"}",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 6, "x": 18, "y": 13 },
      "id": 15,
      "title": "Indexing Active",
      "type": "stat",
      "targets": [
        {
          "expr": "nexus_indexing_active{project=~\"$project\"}",
          "refId": "A"
        }
      ]
    },
    {
      "collapsed": false,
      "gridPos": { "h": 1, "w": 24, "x": 0, "y": 19 },
      "id": 16,
      "title": "Resource & Dependencies",
      "type": "row"
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 12, "x": 0, "y": 20 },
      "id": 17,
      "title": "Embedding API Latency P95",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum by (le, provider) (rate(nexus_embedding_duration_seconds_bucket{project=~\"$project\"}[5m])))",
          "refId": "A"
        }
      ]
    },
    {
      "datasource": { "type": "prometheus", "uid": "${DS_PROMETHEUS}" },
      "gridPos": { "h": 6, "w": 12, "x": 12, "y": 20 },
      "id": 18,
      "title": "Embedding Request Rate",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum by (provider, status) (rate(nexus_embedding_requests_total{project=~\"$project\"}[5m]))",
          "refId": "A"
        }
      ]
    }
  ],
  "refresh": "10s",
  "schemaVersion": 39,
  "tags": [],
  "templating": {
    "list": [
      {
        "current": {},
        "datasource": {
          "type": "prometheus",
          "uid": "${DS_PROMETHEUS}"
        },
        "definition": "label_values(nexus_tool_calls_total, project)",
        "hide": 0,
        "includeAll": true,
        "allValue": ".*",
        "multi": true,
        "name": "project",
        "options": [],
        "query": {
          "query": "label_values(nexus_tool_calls_total, project)",
          "refId": "StandardVariableQuery"
        },
        "refresh": 1,
        "regex": "",
        "skipUrlSync": false,
        "sort": 1,
        "type": "query"
      }
    ]
  },
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "timepicker": {},
  "timezone": "browser",
  "title": "Nexus - AI Agent Observability",
  "uid": "nexus-agent-observability",
  "version": 1,
  "weekStart": ""
}
```

- [ ] **Step 3: Verify documentation files are placed correctly**

Run: `ls -la docs/observability/`
Expected: Both files are listed.

- [ ] **Step 4: Commit**

*(※ユーザーから明示的なコミットの指示があった場合のみ実行)*
```bash
git add docs/observability/README.md docs/observability/grafana-dashboard.json
git commit -m "docs(observability): add Grafana dashboard provisioning json and setup documentation"
```
