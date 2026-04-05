import type { IndexPipeline } from '../../indexer/pipeline.js';
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
  pipeline: IndexPipeline,
  pluginRegistry: PluginRegistry,
): Promise<IndexStatusResult> => ({
  indexStats: await metadataStore.getIndexStats(),
  vectorStats: await vectorStore.getStats(),
  skippedFiles: pipeline.getSkippedFiles().size,
  pluginHealth: await pluginRegistry.healthCheck(),
});
