import type { IIndexPipeline } from '../../indexer/pipeline.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { IMetadataStore, IVectorStore } from '../../types/index.js';

export interface IndexStatusResult {
  indexStats: Awaited<ReturnType<IMetadataStore['getIndexStats']>>;
  vectorStats: Awaited<ReturnType<IVectorStore['getStats']>>;
  skippedFiles: number;
  pluginHealth: Awaited<ReturnType<PluginRegistry['healthCheck']>>;
}

export const executeIndexStatus = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pipeline: IIndexPipeline,
  pluginRegistry: PluginRegistry,
): Promise<IndexStatusResult> => {
  const [indexStats, vectorStats, deadLetterEntries, pluginHealth] = await Promise.all([
    metadataStore.getIndexStats(),
    vectorStore.getStats(),
    metadataStore.getDeadLetterEntries(),
    pluginRegistry.healthCheck(),
  ]);

  void pipeline;

  return {
    indexStats,
    vectorStats,
    skippedFiles: deadLetterEntries.length,
    pluginHealth,
  };
};
