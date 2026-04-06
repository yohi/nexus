import { describe, expect, it } from 'vitest';

import { executeIndexStatus } from '../../../../src/server/tools/index-status.js';
import { PluginRegistry } from '../../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../../src/plugins/languages/typescript.js';
import { TestEmbeddingProvider } from '../../../unit/plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../../../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../../../unit/storage/in-memory-vector-store.js';

const pipeline = {
  getSkippedFiles: () => new Map([['src/auth.ts', 'embed failed']]),
  reindex: async () => ({ startedAt: '', finishedAt: '', durationMs: 0, reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 }, chunksIndexed: 0 }),
};

describe('executeIndexStatus', () => {
  it('aggregates metadata, vector stats, skipped files, and plugin health', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerEmbeddingProvider('test', new TestEmbeddingProvider());

    await metadataStore.initialize();
    await vectorStore.initialize();
    await metadataStore.setIndexStats({
      id: 'primary',
      totalFiles: 1,
      totalChunks: 2,
      lastIndexedAt: null,
      lastFullScanAt: null,
      overflowCount: 0,
    });

    const result = await executeIndexStatus(metadataStore, vectorStore, pipeline, registry);

    expect(result.skippedFiles).toBe(1);
    expect(result.indexStats).toMatchObject({ totalFiles: 1, totalChunks: 2 });
    expect(result.vectorStats).toMatchObject({ totalChunks: 0, totalFiles: 0, dimensions: 64 });
    expect(result.pluginHealth).toMatchObject({
      languages: { registered: ['typescript'], healthy: true },
      embeddings: { provider: 'test', healthy: true },
      healthy: true,
    });
  });
});
