export type RuntimeKnownHealth = "healthy" | "unhealthy" | "unknown";

export interface DashboardProviderStatus {
  providerName: string | null;
  health: RuntimeKnownHealth;
  lastError?: string | null;
}

export interface DashboardIndexStats {
  id: string;
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: string | null;
  lastFullScanAt: string | null;
  overflowCount: number;
  lastError: string | null;
}

export interface DashboardVectorStats {
  totalChunks: number;
  totalFiles: number;
  dimensions: number;
  fragmentationRatio: number;
}

export interface DashboardPipelineProgress {
  totalFiles: number;
  processedFiles: number;
  status: string;
  currentFile?: string | null;
  lastError?: string | null;
}

export interface DashboardStructuredIndex {
  schemaVersion: number | null;
  targetSchemaVersion: number;
  status: "idle" | "building" | "failed" | "reindex_required" | "unsupported";
  rebuildState: string | null;
  lastErrorCode: string | null;
  totalFiles: number;
  totalSymbols: number;
  exactFiles: number;
  degradedFiles: number;
  pendingFiles: number;
  reindexRequired: boolean;
}

export interface DashboardIndexStatusResult {
  indexStats: DashboardIndexStats | null;
  vectorStats: DashboardVectorStats;
  skippedFiles: number;
  pipelineProgress: DashboardPipelineProgress;
  structuredIndex?: DashboardStructuredIndex;
  providerStatus: DashboardProviderStatus;
}
