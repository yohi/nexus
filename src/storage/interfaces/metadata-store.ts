/** Storage interfaces (design doc §7.3). Canonical home since the Phase 1b relocation; re-exported from src/types/index.ts for backward compatibility. */
import type { DeadLetterEntry } from '../../types/index.js';
import type { IStructuredCatalog } from './structured-catalog.js';

export interface MerkleNodeRow {
  path: string;
  hash: string;
  parentPath: string | null;
  isDirectory: boolean;
}

export interface IndexStatsRow {
  id: 'primary';
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: string | null;
  lastFullScanAt: string | null;
  overflowCount: number;
  lastError: string | null;
}

export interface EmbeddingCacheEntry {
  hash: string;
  vector: number[];
}

export interface IMetadataStore extends Partial<IStructuredCatalog> {
  initialize(): Promise<void>;
  bulkUpsertMerkleNodes(nodes: MerkleNodeRow[]): Promise<void>;
  bulkDeleteMerkleNodes(paths: string[]): Promise<void>;
  bulkDeleteSubtrees(paths: string[]): Promise<number>;
  replaceAllMerkleNodes(nodes: MerkleNodeRow[]): Promise<void>;
  deleteSubtree(pathPrefix: string): Promise<number>;
  getSubtreePaths(pathPrefix: string): Promise<string[]>;
  pruneEmptyParents(path: string, pathExists: (targetPath: string) => Promise<boolean>): Promise<void>;
  renamePath(oldPath: string, newPath: string, hash: string): Promise<void>;
  getMerkleNode(path: string): Promise<MerkleNodeRow | null>;
  getChildren(path: string | null): Promise<MerkleNodeRow[]>;
  hasChildren(path: string | null): Promise<boolean>;
  getAllNodes(): Promise<MerkleNodeRow[]>;
  getAllFileNodes(): Promise<MerkleNodeRow[]>;
  getAllPaths(): Promise<string[]>;
  getIndexStats(): Promise<IndexStatsRow | null>;
  setIndexStats(stats: IndexStatsRow): Promise<void>;
  /**
   * Atomically checks whether the dead-letter queue is empty and, if so,
   * updates index_stats. Returns the DLQ entries for error reporting when
   * the queue is not empty.
   *
   * In SQLite this runs inside a single transaction so the DLQ read and the
   * index_stats write form one atomic boundary. The caller must hold the
   * completion lock before calling this method so DLQ modifications cannot
   * occur between the read and the write.
   */
  atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }>;
  upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void>;
  removeDeadLetterEntries(ids: string[]): Promise<void>;
  getDeadLetterEntries(): Promise<DeadLetterEntry[]>;
  getEmbeddings(hashes: string[]): Promise<Map<string, number[]>>;
  setEmbeddings(entries: EmbeddingCacheEntry[]): Promise<void>;
  deleteEmbeddings(hashes: string[]): Promise<void>;
  clearEmbeddings(): Promise<void>;
  pruneEmbeddings(maxAgeDays: number): Promise<number>;
}

export type StructuredCapableMetadataStore = IMetadataStore & IStructuredCatalog;

const structuredCatalogMethods = [
  'bootstrapStructuredSchema',
  'getStructuredIndexState',
  'stageGeneration',
  'activateGeneration',
  'clearPendingGeneration',
  'retireFile',
  'prepareFullRebuild',
  'activateFullRebuild',
  'rollbackFullRebuild',
  'finalizeFullRebuild',
  'resolveFile',
  'getActiveGenerationMap',
  'resolveSymbol',
  'getPendingSymbol',
  'getTombstone',
  'getStructuredCounts',
  'reconcileStructuredState',
] as const satisfies readonly (keyof IStructuredCatalog)[];

export const supportsStructuredCatalog = (store: IMetadataStore): store is StructuredCapableMetadataStore =>
  structuredCatalogMethods.every((method) => typeof store[method] === 'function');
