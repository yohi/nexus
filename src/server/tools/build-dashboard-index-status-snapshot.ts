import type { IMetadataStore, IVectorStore, IIndexPipeline } from "../../types/index.js";
import type { PluginRegistry, RuntimeKnownHealth } from "../../plugins/registry.js";
import { buildSharedIndexStatus, type SharedIndexStatus } from "./build-shared-index-status.js";

export type { RuntimeKnownHealth };

export interface DashboardProviderStatus {
  providerName: string | null;
  health: RuntimeKnownHealth;
  lastError?: string | null;
}

export type DashboardIndexStatusResult = Omit<import("./index-status.js").IndexStatusResult, "pluginHealth"> & {
  providerStatus: DashboardProviderStatus;
};

export const buildDashboardIndexStatusSnapshot = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pluginRegistry: PluginRegistry,
  pipeline: IIndexPipeline,
): Promise<DashboardIndexStatusResult> => {
  const shared: SharedIndexStatus = await buildSharedIndexStatus(metadataStore, vectorStore, pipeline);
  const activeName: string | null = pluginRegistry.getActiveEmbeddingProviderName() ?? null;
  let providerStatus: DashboardProviderStatus;

  if (activeName === null) {
    providerStatus = { providerName: null, health: "unknown", lastError: null };
  } else {
    const known = pluginRegistry.getEmbeddingProviderHealth(activeName);
    if (known === undefined) {
      providerStatus = { providerName: activeName, health: "unknown", lastError: null };
    } else {
      providerStatus = { providerName: activeName, health: known.health, lastError: known.lastError ?? null };
    }
  }

  return { ...shared, providerStatus } as DashboardIndexStatusResult;
};
