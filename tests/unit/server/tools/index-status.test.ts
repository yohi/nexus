import { describe, expect, it } from 'vitest';

import { executeIndexStatus } from '../../../../src/server/tools/index-status.js';
import { PluginRegistry } from '../../../../src/plugins/registry.js';
import { TestEmbeddingProvider } from '../../../unit/plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../../../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../../../unit/storage/in-memory-vector-store.js';

const pipeline = {
  getSkippedFiles: () => new Map([['src/auth.ts', 'embed failed']]),
};

describe('executeIndexStatus', () => {
  it('aggregates metadata, vector stats, skipped files, and plugin health', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
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

    const result = await executeIndexStatus(metadataStore, vectorStore, pipeline as never, registry);

    expect(result.skippedFiles).toBe(1);
    expect(result.indexStats).toMatchObject({ totalFiles: 1, totalChunks: 2 });
    expect(result.vectorStats).toMatchObject({ totalChunks: 0, totalFiles: 0, dimensions: 64 });
    expect(result.pluginHealth).toMatchObject({ embeddingProvider: 'test', healthy: true });
  });
});
