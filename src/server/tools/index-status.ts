import type { PluginRegistry } from '../../plugins/registry.js';
import type { IMetadataStore, IVectorStore, IIndexPipeline, PipelineProgress } from '../../types/index.js';
import { buildSharedIndexStatus } from './build-shared-index-status.js';
import type { StructuredIndexStatus } from './build-shared-index-status.js';

export interface IndexStatusResult {
  indexStats: Awaited<ReturnType<IMetadataStore['getIndexStats']>>;
  vectorStats: Awaited<ReturnType<IVectorStore['getStats']>>;
  skippedFiles: number;
  pluginHealth: Awaited<ReturnType<PluginRegistry['healthCheck']>>;
  pipelineProgress: PipelineProgress;
  structuredIndex?: StructuredIndexStatus;
}

export const executeIndexStatus = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pluginRegistry: PluginRegistry,
  pipeline: IIndexPipeline,
): Promise<IndexStatusResult> => {
  const shared = await buildSharedIndexStatus(metadataStore, vectorStore, pipeline);
  const pluginHealth = await pluginRegistry.healthCheck();
  return { ...shared, pluginHealth };
};

export type { StructuredIndexStatus };

export type { DashboardIndexStatusResult, DashboardProviderStatus } from "./build-dashboard-index-status-snapshot.js";
