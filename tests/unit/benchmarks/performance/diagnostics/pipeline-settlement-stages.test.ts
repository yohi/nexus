import { describe, expect, it, vi } from 'vitest';

import { Chunker } from '../../../../../src/indexer/chunker.js';
import { EventQueue } from '../../../../../src/indexer/event-queue.js';
import { IndexPipeline } from '../../../../../src/indexer/pipeline.js';
import { TestEmbeddingProvider } from '../../../plugins/embeddings/test-embedding-provider.js';
import { createPipeline } from '../../../../shared/test-helpers.js';
import { createStructuredCoordinatorFixture } from '../../../../shared/structured-test-helpers.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../../src/observability/diagnostic-stage-trace.js';
import { createDiagnosticTestContext } from './diagnostic-test-helpers.js';

describe('pipeline settlement diagnostic stages', () => {
  it('records full-rebuild retained file, chunk, and vector counts', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const pipeline = new IndexPipeline({
      metadataStore: fixture.metadataStore,
      vectorStore: fixture.vectorStore,
      chunker: new Chunker(fixture.pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: fixture.pluginRegistry,
      structuredIndexCoordinator: fixture.coordinator,
    });
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents([{
        type: 'added',
        filePath: 'private/retained.ts',
        contentHash: 'retained-hash',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('export function retained() { return 3; }'), { fullRebuild: true }));

    const counters = context.recorder.snapshot().events.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.full_rebuild_retained_files', value: 1 }));
    expect(counters.some((event) => event.counterId === 'index.retained_chunks' && event.value > 0)).toBe(true);
    expect(counters.some((event) => event.counterId === 'index.retained_vectors' && event.value > 0)).toBe(true);
  });

  it('records settlement spans around compaction and completion', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.reindex(
        () => Promise.resolve([{
          type: 'added' as const,
          filePath: 'private/settlement.ts',
          contentHash: 'settlement-hash',
          detectedAt: '2026-01-01T00:00:00.000Z',
        }]),
        () => Promise.resolve('export function settle() { return 4; }'),
      ));

    const settlementSpans = context.recorder.snapshot().events.filter(
      (event) => event.event === 'span_started' && event.stageId === 'S09_index_settlement',
    );
    expect(settlementSpans.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps final vector writes serial while read and chunk children overlap', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      chunkConcurrency: 2,
      embedBatchWindowSize: 2,
    });
    const originalUpsert = vectorStore.upsertChunks.bind(vectorStore);
    let activeWrites = 0;
    let peakWrites = 0;
    vi.spyOn(vectorStore, 'upsertChunks').mockImplementation(async (...args) => {
      activeWrites += 1;
      peakWrites = Math.max(peakWrites, activeWrites);
      await Promise.resolve();
      try {
        return await originalUpsert(...args);
      } finally {
        activeWrites -= 1;
      }
    });
    const context = createDiagnosticTestContext();
    const events = [0, 1].map((index) => ({
      type: 'added' as const,
      filePath: `private/serial-${index}.txt`,
      contentHash: `serial-${index}`,
      detectedAt: '2026-01-01T00:00:00.000Z',
    }));

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents(events, () => Promise.resolve('serial finalization fallback')));

    expect(peakWrites).toBe(1);
    const counters = context.recorder.snapshot().events.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_vector_rows_write_succeeded', value: 2 }));
  });

  it('closes an aborted embedding span and preserves the reindex rejection', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    let markEmbeddingStarted: () => void = () => undefined;
    const embeddingStarted = new Promise<void>((resolve) => { markEmbeddingStarted = resolve; });
    const embeddingProvider = {
      dimensions: 64,
      async embed(_texts: string[], signal?: AbortSignal): Promise<number[][]> {
        markEmbeddingStarted();
        if (signal === undefined) throw new Error('abort signal was not provided');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
        return [];
      },
      healthCheck(): Promise<boolean> { return Promise.resolve(true); },
    };
    const pipeline = new IndexPipeline({ metadataStore, vectorStore, chunker, embeddingProvider, pluginRegistry: registry });
    const context = createDiagnosticTestContext();
    const reindex = withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.reindex(
        () => Promise.resolve([{
          type: 'added' as const,
          filePath: 'private/abort.ts',
          contentHash: 'abort-hash',
          detectedAt: '2026-01-01T00:00:00.000Z',
        }]),
        () => Promise.resolve('abort embedding text'),
      ));
    const rejection = expect(reindex).rejects.toThrow();

    await embeddingStarted;
    await pipeline.stop();
    await rejection;

    const trace = context.recorder.snapshot().events;
    expect(trace.some((event) =>
      event.event === 'span_finished' && event.stageId === 'S07_embedding_cache' && event.status === 'aborted')).toBe(true);
  });

  it('records decreasing queue gauges and cumulative dropped events at settlement', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const queue = new EventQueue({ debounceMs: 60_000, maxQueueSize: 1, fullScanThreshold: 1, concurrency: 1 });
    pipeline.setEventQueue(queue);
    const event = {
      type: 'added' as const,
      filePath: 'private/queued.ts',
      contentHash: 'queued',
      detectedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(queue.enqueue(event)).toBe(true);
    expect(queue.enqueue({ ...event, filePath: 'private/dropped.ts' })).toBe(false);
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), async () => {
      await pipeline.reindex(() => Promise.resolve([]), () => Promise.resolve(''));
      queue.clear();
      await pipeline.reindex(() => Promise.resolve([]), () => Promise.resolve(''));
    });

    const counters = context.recorder.snapshot().events.filter((entry) => entry.event === 'progress');
    const pendingValues = counters.filter((entry) => entry.counterId === 'settlement.queue_pending').map((entry) => entry.value);
    const droppedValues = counters.filter((entry) => entry.counterId === 'settlement.dropped_events').map((entry) => entry.value);
    expect(pendingValues).toContain(1);
    expect(pendingValues).toContain(0);
    expect(droppedValues.length).toBeGreaterThanOrEqual(2);
    expect(droppedValues.every((value) => value === 1)).toBe(true);
    expect(counters.some((entry) => entry.counterId === 'settlement.drain_inflight')).toBe(true);
  });
});
