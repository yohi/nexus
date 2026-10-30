import { describe, expect, it } from 'vitest';

import { IndexPipeline } from '../../../../../src/indexer/pipeline.js';
import { TestEmbeddingProvider } from '../../../plugins/embeddings/test-embedding-provider.js';
import { createPipeline } from '../../../../shared/test-helpers.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../../src/observability/diagnostic-stage-trace.js';
import { createDiagnosticTestContext } from './diagnostic-test-helpers.js';

describe('legacy parser diagnostic stages', () => {
  it('records parser attempt and success without fallback on a parsed file', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    registry.registerLanguage({
      languageId: 'diagnostic-success',
      fileExtensions: ['.diagnostic-success'],
      supports: (filePath) => filePath.endsWith('.diagnostic-success'),
      createParser: () => Promise.resolve({
        parse: () => Promise.resolve({
          rootType: 'root',
          declarations: [{
            type: 'function',
            name: 'sample',
            startLine: 1,
            endLine: 1,
            content: 'function sample() {}',
          }],
        }),
      }),
    });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      pipeline.processEvents([{
        type: 'added',
        filePath: 'private/success.diagnostic-success',
        contentHash: 'legacy-success',
        detectedAt: '2026-01-01T00:00:00.000Z',
      }], () => Promise.resolve('function sample() {}')));

    const trace = context.recorder.snapshot().events;
    const counters = trace.filter((event) => event.event === 'progress');
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_parser_attempted', value: 1 }));
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_parser_succeeded', value: 1 }));
    expect(counters.some((event) => event.counterId === 'index.legacy_parser_failed')).toBe(false);
    expect(counters).toContainEqual(expect.objectContaining({ counterId: 'index.legacy_fixedline_fallback_succeeded', value: 0 }));
    expect(JSON.stringify(trace)).not.toContain('private/success.diagnostic-success');
  });
});
