import { describe, expect, it } from 'vitest';

import { Chunker } from '../../../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../../../src/indexer/pipeline.js';
import { TestEmbeddingProvider } from '../../../plugins/embeddings/test-embedding-provider.js';
import { createStructuredCoordinatorFixture, createStructuredStage } from '../../../../shared/structured-test-helpers.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../../src/observability/diagnostic-stage-trace.js';
import { createDiagnosticTestContext } from './diagnostic-test-helpers.js';

describe('structured parser diagnostic stages', () => {
  it('records a terminal failed structured parse without exposing paths', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    fixture.pluginRegistry.registerLanguage({
      languageId: 'diagnostic-failed',
      fileExtensions: ['.diagnostic-failed'],
      supports: (filePath) => filePath.endsWith('.diagnostic-failed'),
      createParser: () => Promise.resolve({
        parse: () => Promise.resolve({ rootType: 'root', declarations: [] }),
      }),
      createStructuredParser: () => Promise.resolve({
        parseStructured: () => Promise.resolve({
          status: 'failed',
          retrievability: 'none',
          failure: { reasonCode: 'parse_error', message: 'private parser details' },
          declarations: [],
          imports: [],
        }),
      }),
    });
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
        filePath: 'private/failed.diagnostic-failed',
        contentHash: 'failed-parse',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('export function fallback() { return 1; }')));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_parse_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_parse_failed', value: 1 }));
    expect(JSON.stringify(trace)).not.toContain('private/failed.diagnostic-failed');
    expect(JSON.stringify(trace)).not.toContain('private parser details');
  });

  it('records a degraded structured parse as completed rather than successful', async () => {
    const fixture = await createStructuredCoordinatorFixture();
    const stage = createStructuredStage('private/degraded.diagnostic-degraded', 'export function degraded() { return 1; }', 'degraded');
    fixture.pluginRegistry.registerLanguage({
      languageId: 'diagnostic-degraded',
      fileExtensions: ['.diagnostic-degraded'],
      supports: (filePath) => filePath.endsWith('.diagnostic-degraded'),
      createParser: () => Promise.resolve({
        parse: () => Promise.resolve({ rootType: 'root', declarations: [] }),
      }),
      createStructuredParser: () => Promise.resolve({
        parseStructured: () => Promise.resolve({
          status: 'degraded',
          retrievability: 'partial',
          failure: { reasonCode: 'parse_error', message: 'partial parse details' },
          declarations: [stage.symbol],
          imports: [],
        }),
      }),
    });
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
        filePath: stage.source.filePath,
        contentHash: stage.contentHash,
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve(stage.source.text)));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_parse_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.structured_parse_degraded', value: 1 }));
    expect(counters.some((event) => event.counterId === 'index.structured_parse_ok')).toBe(false);
    expect(JSON.stringify(trace)).not.toContain(stage.source.filePath);
  });
});
