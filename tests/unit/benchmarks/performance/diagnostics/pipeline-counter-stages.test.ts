import { describe, expect, it } from 'vitest';

import { IndexPipeline } from '../../../../../src/indexer/pipeline.js';
import { DimensionMismatchError, RetryExhaustedError } from '../../../../../src/types/index.js';
import { TestEmbeddingProvider } from '../../../plugins/embeddings/test-embedding-provider.js';
import { createPipeline } from '../../../../shared/test-helpers.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../../src/observability/diagnostic-stage-trace.js';
import { createDiagnosticTestContext } from './diagnostic-test-helpers.js';

class FailingDiagnosticEmbeddingProvider extends TestEmbeddingProvider {
  override embed(): Promise<number[][]> {
    return Promise.reject(new RetryExhaustedError('injected embedding failure', 2));
  }
}

class MalformedDiagnosticEmbeddingProvider extends TestEmbeddingProvider {
  override embed(): Promise<number[][]> {
    return Promise.resolve([[0]]);
  }
}

describe('pipeline diagnostic counters', () => {
  it('records no-plugin fallback, cache/provider, and legacy vector counters without paths', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      embedBatchWindowSize: 2,
    });
    const context = createDiagnosticTestContext();
    const filePath = 'private/unsupported.txt';
    const result = await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents([{
        type: 'added', filePath, contentHash: 'h1', detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('plain text for fallback')));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    const stageIds = trace.filter((event) => event.event === 'span_started').map((event) => event.stageId);
    expect(result.chunksIndexed).toBeGreaterThan(0);
    expect(stageIds).toContain('S06_parse_chunk');
    expect(stageIds).toContain('S07_embedding_cache');
    expect(stageIds).toContain('S08_storage_write');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_fallback_no_plugin', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_fixedline_fallback_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_fixedline_fallback_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_cache_misses', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_inputs_submitted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_batches_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_batches_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_vectors_returned', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_inputs_completed', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_vector_rows_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_vector_rows_write_succeeded', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.pipeline_files_finalized', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.pipeline_files_indexed_succeeded', value: 1 }));
    expect(JSON.stringify(trace)).not.toContain(filePath);
  });

  it('captures overlapping S06 child spans for concurrent window reads', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      chunkConcurrency: 2,
      embedBatchWindowSize: 16,
    });
    const context = createDiagnosticTestContext();
    const events = [0, 1].map((index) => ({
      type: 'added' as const,
      filePath: `private/concurrent-${index}.txt`,
      contentHash: `concurrent-${index}`,
      detectedAt: '2026-01-01T00:00:00.000Z',
    }));

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents(events, () => Promise.resolve('concurrent fallback text')));

    const trace = context.recorder.snapshot().events;
    const starts = new Map(trace.flatMap((event) =>
      event.event === 'span_started' && event.stageId === 'S06_parse_chunk'
        ? [[event.spanId, BigInt(event.monotonicNs)] as const]
        : []));
    const finishes = new Map(trace.flatMap((event) =>
      event.event === 'span_finished' && event.stageId === 'S06_parse_chunk'
        ? [[event.spanId, BigInt(event.endMonotonicNs)] as const]
        : []));
    const intervals = [...starts].flatMap(([spanId, start]) => {
      const end = finishes.get(spanId);
      return end === undefined ? [] : [{ start, end }];
    });
    const hasOverlap = intervals.some((left, index) => intervals.slice(index + 1).some((right) =>
      left.start < right.end && right.start < left.end));

    expect(hasOverlap).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('private/concurrent-');
  });

  it('records two embedding batches for a 17-file workload split into 16-file windows', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      chunkConcurrency: 2,
      embedBatchWindowSize: 16,
    });
    const context = createDiagnosticTestContext();
    const events = Array.from({ length: 17 }, (_, index) => ({
      type: 'added' as const,
      filePath: `private/window-${index}.txt`,
      contentHash: `window-${index}`,
      detectedAt: '2026-01-01T00:00:00.000Z',
    }));

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents(events, () => Promise.resolve('windowed fallback text')));

    const counters = context.recorder.snapshot().events.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.window_files', value: 17 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_batches_attempted', value: 2 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_vector_rows_write_succeeded', value: 17 }));
  });

  it('records L1 hits, L2 hits, and misses as separate cumulative cache outcomes', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embeddingConfig = {
      provider: 'test' as const,
      model: 'diagnostic-cache-test',
      dimensions: 64,
      maxConcurrency: 1,
      batchSize: 16,
      retryCount: 0,
      retryBaseDelayMs: 0,
    };
    const makePipeline = () => new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      embeddingConfig,
    });
    const firstPipeline = makePipeline();
    const secondPipeline = makePipeline();
    const context = createDiagnosticTestContext();
    const event = [{
      type: 'added' as const,
      filePath: 'private/cache.ts',
      contentHash: 'cache-hash',
      detectedAt: '2026-01-01T00:00:00.000Z',
    }];
    const loadContent = () => Promise.resolve('same cacheable fallback text');

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), async () => {
      await firstPipeline.processEvents(event, loadContent);
      await firstPipeline.processEvents(event, loadContent);
      await secondPipeline.processEvents(event, loadContent);
    });

    const counters = context.recorder.snapshot().events.filter((entry) => entry.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_cache_l1_hits', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_cache_l2_hits', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_cache_misses', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_batches_attempted', value: 1 }));
  });

  it('records a failed embedding batch and finalized DLQ path without marking success', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new FailingDiagnosticEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents([{
        type: 'added',
        filePath: 'private/failed-embedding.txt',
        contentHash: 'failed-embedding',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('failed embedding text')));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_batches_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_batches_failed', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.pipeline_files_finalized', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.pipeline_files_skipped_or_dlq', value: 1 }));
    expect(counters.some((event) => event.counterId === 'index.embedding_batches_succeeded')).toBe(false);
    expect(counters.some((event) => event.counterId === 'index.pipeline_files_indexed_succeeded')).toBe(false);
    expect(JSON.stringify(trace)).not.toContain('private/failed-embedding.txt');
  });

  it('counts returned vectors without marking inputs complete when vector dimensions are invalid', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new MalformedDiagnosticEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const context = createDiagnosticTestContext();

    await expect(withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents([{
        type: 'added',
        filePath: 'private/invalid-vector.txt',
        contentHash: 'invalid-vector',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('invalid vector text')))).rejects.toBeInstanceOf(DimensionMismatchError);

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.embedding_vectors_returned', value: 1 }));
    expect(counters.some((event) => event.counterId === 'index.embedding_inputs_completed')).toBe(false);
    expect(JSON.stringify(trace)).not.toContain('private/invalid-vector.txt');
  });

  it('records parser failure and successful fixed-line fallback without path or error text', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    registry.registerLanguage({
      languageId: 'diagnostic-broken',
      fileExtensions: ['.broken'],
      supports: (filePath) => filePath.endsWith('.broken'),
      createParser: () => Promise.reject(new Error('private parser error')),
    });
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents([{
        type: 'added',
        filePath: 'private/parser-error.broken',
        contentHash: 'parser-error',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('fallback content after parser failure')));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_parser_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_parser_failed', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_fallback_parser_error', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_fixedline_fallback_succeeded', value: 1 }));
    expect(JSON.stringify(trace)).not.toContain('private/parser-error.broken');
    expect(JSON.stringify(trace)).not.toContain('private parser error');
  });
});
