/** Storage interfaces (design doc §7.3). Canonical home since the Phase 1b relocation; re-exported from src/types/index.ts for backward compatibility. */
import type { CodeChunk, SymbolKind } from '../../types/index.js';

export interface VectorFilter {
  filePathPrefix?: string;
  language?: string;
  symbolKind?: SymbolKind;
}

export interface VectorSearchResult {
  chunk: CodeChunk;
  score: number;
  generationId?: string;
}

export interface VectorStoreStats {
  totalChunks: number;
  totalFiles: number;
  dimensions: number;
  fragmentationRatio: number;
  lastCompactedAt?: string;
}

export interface CompactionResult {
  compacted: boolean;
  fragmentationRatioBefore: number;
  fragmentationRatioAfter: number;
  chunksRemoved: number;
}

export interface CompactionConfig {
  fragmentationThreshold: number;
  minStaleChunks: number;
  idleDelayMs: number;
}

export interface CompactionMutex {
  waitForUnlock(abortSignal?: AbortSignal): Promise<void>;
}

/** Visibility of a structured vector row. */
export type StructuredRowVisibility = 'pending' | 'active';

/** A batch of chunks belonging to a single file generation. */
export interface GenerationChunkBatch {
  filePath: string;
  generationId: string;
  chunks: readonly CodeChunk[];
  vectors: readonly number[][];
}

/** A file/generation pair used to reconcile active structured rows. */
export interface ActiveGeneration {
  filePath: string;
  generationId: string;
}

/** Opaque handle for a structured shadow table used during full rebuilds. */
export interface StructuredShadowTable {
  readonly name: string;
}

/** Opaque handle for a legacy vector shadow table used during atomic full rebuilds. */
export interface LegacyShadowTable {
  readonly name: string;
}

/** A legacy chunk paired with its embedding vector for shadow staging. */
export interface ChunkWithEmbedding {
  readonly chunk: CodeChunk;
  readonly vector: number[];
}

/** File-path based removals staged into a legacy shadow table. */
export interface LegacyShadowDeletion {
  readonly filePaths?: readonly string[];
  readonly pathPrefixes?: readonly string[];
}

export interface IVectorStore {
  initialize(): Promise<void>;
  upsertChunks(chunks: CodeChunk[], embeddings?: number[][], affectedFilePaths?: string[]): Promise<void>;
  deleteByFilePath(filePath: string): Promise<number>;
  deleteByPathPrefix(pathPrefix: string): Promise<number>;
  renameFilePath(oldPath: string, newPath: string): Promise<number>;
  search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]>;
  compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs?: number,
    mutex?: CompactionMutex,
    abortSignal?: AbortSignal,
    mutexTimeoutMs?: number,
  ): NodeJS.Timeout;
  getStats(): Promise<VectorStoreStats>;
  close(timeoutMs?: number): Promise<void>;

  /** Structured-vector lifecycle methods. */
  stageGenerationChunks(batch: GenerationChunkBatch): Promise<void>;
  activateGenerationRows(filePath: string, generationId: string): Promise<void>;
  removeGenerationRows(filePath: string, generationId: string): Promise<void>;
  beginStructuredShadowTable(): Promise<StructuredShadowTable>;
  swapStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void>;
  abortStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void>;
  reconcileStructuredRows(activeGenerations: readonly ActiveGeneration[]): Promise<void>;

  /** Legacy-vector shadow lifecycle methods (atomic full rebuild). */
  beginLegacyShadowTable(): Promise<LegacyShadowTable>;
  stageLegacyShadowChunks(shadow: LegacyShadowTable, chunks: ChunkWithEmbedding[]): Promise<void>;
  stageLegacyShadowDeletions(shadow: LegacyShadowTable, deletions: LegacyShadowDeletion): Promise<void>;
  swapLegacyShadowTable(shadow: LegacyShadowTable): Promise<void>;
  abortLegacyShadowTable(shadow: LegacyShadowTable): Promise<void>;
}
