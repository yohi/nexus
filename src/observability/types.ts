import type { BackpressureState } from '../indexer/event-queue.js';

export type EmbeddingCacheOutcome = 'l1_hit' | 'l2_hit' | 'miss';

export interface MetricsHooks {
  onEmbeddingCacheLookup?(outcome: EmbeddingCacheOutcome, count: number): void;
  onQueueSnapshot(size: number, state: BackpressureState, droppedTotal: number, source?: string): void;

  onChunksIndexed(count: number): void;

  onReindexComplete(durationMs: number, fullRebuild: boolean): void;

  onDlqSnapshot(size: number, source?: string): void;

  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source?: string): void;

  onIndexingProgress(processed: number, total: number, active: boolean): void;

  // New hooks
  onToolCall(toolName: string, status: 'success' | 'error', durationSeconds: number): void;
  onSearchResults(searchType: 'semantic' | 'grep' | 'hybrid', resultCount: number): void;
  onContextLinesFetched(toolName: string, lineCount: number): void;
  onEmbeddingRequest(provider: string, status: 'success' | 'error', durationSeconds: number, batchSize: number): void;

  // Structured retrieval hooks
  onStructuredRetrievalOutcome(toolName: string, status: string): void;
  onStructuredParserOutcome(language: string, parseStatus: string): void;
  onStructuredContextTokens(toolName: string, requested: number, actual: number): void;
  onStructuredBudgetOverflow(toolName: string, omittedCount: number): void;
  onStructuredCatalogSnapshot(totalFiles: number, totalSymbols: number, exactFiles: number, degradedFiles: number, pendingFiles: number): void;
}
