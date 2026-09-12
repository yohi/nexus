import { describe, expect, it } from 'vitest';

import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { sha256Hex } from '../../../src/structured/hash.js';
import { createStructuredCoordinatorFixture } from '../../shared/structured-test-helpers.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';

const eventFor = (type: 'added' | 'modified', filePath: string, content: string) => ({
  type,
  filePath,
  contentHash: sha256Hex(new TextEncoder().encode(content)),
  detectedAt: new Date().toISOString(),
} as const);

const createCppPipeline = async () => {
  const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
  fixture.pluginRegistry.registerLanguage(new CppLanguagePlugin());
  const pipeline = new IndexPipeline({
    metadataStore: fixture.metadataStore,
    vectorStore: fixture.vectorStore,
    chunker: new Chunker(fixture.pluginRegistry),
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: fixture.pluginRegistry,
    structuredIndexCoordinator: fixture.coordinator,
  });
  return { ...fixture, pipeline };
};

const importFor = (content: string) => ({
  id: 'import_v1_test_stdio',
  moduleSpecifier: 'stdio.h',
  startByte: 0,
  endByte: Buffer.byteLength(content, 'utf8'),
  sourceHash: sha256Hex(new TextEncoder().encode(content)),
  completeness: 'complete' as const,
  position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: content.length },
});

describe('IndexPipeline structured import-only handling', () => {
  it('persists an ok import-only file through incremental processing', async () => {
    const { metadataStore, pipeline } = await createCppPipeline();
    const content = '#include <stdio.h>\n';
    await pipeline.processEvents([eventFor('added', 'header.h', content)], async () => content);

    await expect(metadataStore.resolveFile('header.h')).resolves.toMatchObject({ kind: 'active' });
    expect(metadataStore.getActiveImportsForFile('header.h')).toEqual(
      expect.arrayContaining([expect.objectContaining({ moduleSpecifier: 'stdio.h', completeness: 'complete' })]),
    );
  });

  it('routes degraded import-only incremental updates to DLQ without replacing active state', async () => {
    const { metadataStore, vectorStore, pipeline, pluginRegistry } = await createCppPipeline();
    const filePath = 'header.h';
    const initial = '#include <stdio.h>\n';
    const broken = '#include <stdio.h>\n// degraded\n';
    await pipeline.processEvents([eventFor('added', filePath, initial)], async () => initial);
    const activeBefore = await metadataStore.resolveFile(filePath);
    const vectorsBefore = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    const plugin = pluginRegistry.getLanguagePlugin(filePath);
    if (plugin?.createStructuredParser === undefined) throw new Error('C++ structured parser is unavailable');
    plugin.createStructuredParser = async () => ({
      parseStructured: async () => ({
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [importFor(broken)],
        failure: { reasonCode: 'parse_error', message: 'degraded import-only fixture' },
      }),
    });

    await pipeline.processEvents([eventFor('modified', filePath, broken)], async () => broken);
    await expect(metadataStore.getDeadLetterEntries()).resolves.toHaveLength(1);
    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual(activeBefore);
    const vectorsAfter = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    expect(vectorsAfter.map((result) => result.chunk.id)).toEqual(vectorsBefore.map((result) => result.chunk.id));
  });

  it('aborts a degraded import-only full rebuild and preserves active state', async () => {
    const { metadataStore, vectorStore, pipeline, pluginRegistry } = await createCppPipeline();
    const filePath = 'header.h';
    const initial = '#include <stdio.h>\n';
    const broken = '#include <stdio.h>\n// degraded rebuild\n';
    await pipeline.processEvents([eventFor('added', filePath, initial)], async () => initial);
    const activeBefore = await metadataStore.resolveFile(filePath);
    const vectorsBefore = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    const plugin = pluginRegistry.getLanguagePlugin(filePath);
    if (plugin?.createStructuredParser === undefined) throw new Error('C++ structured parser is unavailable');
    plugin.createStructuredParser = async () => ({
      parseStructured: async () => ({
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [importFor(broken)],
        failure: { reasonCode: 'parse_error', message: 'degraded import-only rebuild fixture' },
      }),
    });

    await expect(pipeline.reindex(
      async () => [eventFor('modified', filePath, broken)],
      async () => broken,
      true,
    )).rejects.toThrow(/Structured full rebuild aborted/);
    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual(activeBefore);
    const vectorsAfter = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    expect(vectorsAfter.map((result) => result.chunk.id)).toEqual(vectorsBefore.map((result) => result.chunk.id));
  });
});
