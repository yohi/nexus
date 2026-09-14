import { randomUUID } from 'node:crypto';

import type {
  ActiveGeneration,
  ChunkWithEmbedding,
  CodeChunk,
  CompactionConfig,
  CompactionMutex,
  CompactionResult,
  GenerationChunkBatch,
  IVectorStore,
  LegacyShadowDeletion,
  LegacyShadowTable,
  StructuredRowVisibility,
  StructuredShadowTable,
  VectorFilter,
  VectorSearchResult,
  VectorStoreStats,
} from '../../../src/types/index.js';

interface InMemoryVectorStoreOptions {
  dimensions: number;
}

interface StoredVector {
  chunk: CodeChunk;
  vector: number[];
  deleted: boolean;
}

interface StructuredRow {
  chunk: CodeChunk;
  vector: number[];
  generationId: string;
  visibility: StructuredRowVisibility;
}

interface StructuredShadowState {
  readonly name: string;
  readonly records: Map<string, StructuredRow>;
}

interface LegacyShadowState {
  readonly name: string;
  readonly records: Map<string, StoredVector>;
}

const cosineSimilarity = (left: number[], right: number[]): number => {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightMagnitude = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (leftMagnitude * rightMagnitude);
};

export class InMemoryVectorStore implements IVectorStore {
  private readonly dimensions: number;

  private readonly records = new Map<string, StoredVector>();
  private readonly structuredRecords = new Map<string, StructuredRow>();
  private structuredShadow: StructuredShadowState | undefined;
  private structuredSwapBackup: { readonly handleName: string; readonly records: Map<string, StructuredRow> } | undefined;
  private legacyShadow: LegacyShadowState | undefined;
  private legacySwapBackup: {
    readonly handleName: string;
    readonly records: Map<string, StoredVector>;
    readonly deletedCount: number;
  } | undefined;

  private deletedCount = 0;

  private failBatchNumber: number | null = null;
  private currentBatchNumber = 0;

  private lastCompactedAt: string | undefined;

  constructor(options: InMemoryVectorStoreOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('dimensions must be a positive integer');
    }
    this.dimensions = options.dimensions;
  }

  async initialize(): Promise<void> {
    return;
  }

  async upsertChunks(chunks: CodeChunk[], embeddings?: number[][]): Promise<void> {
    if (embeddings && embeddings.length !== chunks.length) {
      throw new Error(`InMemoryVectorStore.upsertChunks: embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = embeddings ? embeddings[i]! : this.vectorize(chunk.content);

      if (vector.length !== this.dimensions) {
        throw new Error(`InMemoryVectorStore.upsertChunks: vector length mismatch for chunk ${chunk.id} (expected ${this.dimensions}, got ${vector.length})`);
      }
      if (!vector.every(Number.isFinite)) {
        throw new Error(`InMemoryVectorStore.upsertChunks: vector contains non-finite values for chunk ${chunk.id}`);
      }

      const prior = this.records.get(chunk.id);
      if (prior?.deleted) {
        this.deletedCount -= 1;
      }
      this.records.set(chunk.id, {
        chunk,
        vector,
        deleted: false,
      });
    }
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    let deleted = 0;
    for (const record of this.records.values()) {
      if (record.chunk.filePath === filePath && !record.deleted) {
        record.deleted = true;
        deleted += 1;
        this.deletedCount += 1;
      }
    }

    return deleted;
  }

  async deleteByPathPrefix(pathPrefix: string): Promise<number> {
    let deleted = 0;
    const prefixWithSlash = pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`;
    for (const record of this.records.values()) {
      const isMatch = record.chunk.filePath === pathPrefix || record.chunk.filePath.startsWith(prefixWithSlash);
      if (isMatch && !record.deleted) {
        record.deleted = true;
        deleted += 1;
        this.deletedCount += 1;
      }
    }

    return deleted;
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<number> {
    if (oldPath === newPath) {
      return 0;
    }

    // Check if oldPath exists first to avoid unnecessary mutations
    let exists = false;
    for (const record of this.records.values()) {
      if (record.chunk.filePath === oldPath && !record.deleted) {
        exists = true;
        break;
      }
    }

    if (!exists) {
      return 0;
    }

    // Clear any existing chunks at newPath to avoid mixing old/new data
    for (const [id, record] of [...this.records.entries()]) {
      if (record.chunk.filePath === newPath) {
        if (record.deleted) {
          this.deletedCount -= 1;
        }
        this.records.delete(id);
      }
    }

    let renamed = 0;
    const toAdd: [string, StoredVector][] = [];

    for (const [id, record] of this.records.entries()) {
      if (record.chunk.filePath !== oldPath || record.deleted) {
        continue;
      }

      this.records.delete(id);
      const nextChunk = {
        ...record.chunk,
        id: record.chunk.id.replaceAll(oldPath, newPath),
        filePath: newPath,
      };

      toAdd.push([nextChunk.id, { ...record, chunk: nextChunk }]);
      renamed += 1;
    }

    for (const [newId, newRecord] of toAdd) {
      const prior = this.records.get(newId);
      if (prior?.deleted) {
        this.deletedCount -= 1;
      }
      this.records.set(newId, newRecord);
    }

    return renamed;
  }

  async search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]> {
    if (queryVector.length !== this.dimensions) {
      throw new Error(`queryVector length must be ${this.dimensions}`);
    }
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new RangeError('topK must be a positive integer');
    }

    const legacyCandidates = [...this.records.values()]
      .filter((record) => !record.deleted)
      .map((record) => ({
        chunk: record.chunk,
        score: cosineSimilarity(queryVector, record.vector),
      }));

    const structuredCandidates = [...this.structuredRecords.values()]
      .filter((row) => row.visibility === 'active')
      .map((row) => ({
        chunk: row.chunk,
        score: cosineSimilarity(queryVector, row.vector),
        generationId: row.generationId,
      }));

    const candidates = [...structuredCandidates, ...legacyCandidates]
      .filter((candidate) => {
        if (filter?.filePathPrefix !== undefined && !candidate.chunk.filePath.startsWith(filter.filePathPrefix)) {
          return false;
        }
        if (filter?.language !== undefined && candidate.chunk.language !== filter.language) {
          return false;
        }
        if (filter?.symbolKind !== undefined && candidate.chunk.symbolKind !== filter.symbolKind) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.score - left.score || left.chunk.filePath.localeCompare(right.chunk.filePath));
    const seen = new Set<string>();
    const results: VectorSearchResult[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.chunk.id)) {
        continue;
      }
      seen.add(candidate.chunk.id);
      results.push(candidate);
      if (results.length >= topK) {
        break;
      }
    }

    return results;
  }

  async stageGenerationChunks(batch: GenerationChunkBatch): Promise<void> {
    this.currentBatchNumber += 1;
    if (this.failBatchNumber === this.currentBatchNumber) {
      this.failBatchNumber = null;
      throw new Error(`batch ${this.currentBatchNumber} failed`);
    }
    if (batch.vectors.length !== batch.chunks.length) {
      throw new Error(`InMemoryVectorStore.stageGenerationChunks: vectors length mismatch (expected ${batch.chunks.length}, got ${batch.vectors.length})`);
    }

    for (let i = 0; i < batch.chunks.length; i++) {
      const chunk = batch.chunks[i]!;
      const vector = batch.vectors[i]!;
      if (vector.length !== this.dimensions) {
        throw new Error(`InMemoryVectorStore.stageGenerationChunks: vector length mismatch for chunk ${chunk.id}`);
      }
      if (!vector.every(Number.isFinite)) {
        throw new Error(`InMemoryVectorStore.stageGenerationChunks: vector contains non-finite values for chunk ${chunk.id}`);
      }

      const key = this.structuredKey(batch.filePath, batch.generationId, chunk.id);
      const target = this.structuredShadow?.records ?? this.structuredRecords;
      target.set(key, {
        chunk,
        vector,
        generationId: batch.generationId,
        visibility: 'pending',
      });
    }
  }

  failOnBatch(batchNumber: number): void {
    this.failBatchNumber = batchNumber;
  }

  async activateGenerationRows(filePath: string, generationId: string): Promise<void> {
    for (const [key, row] of this.structuredRecords.entries()) {
      if (row.chunk.filePath === filePath && row.generationId === generationId && row.visibility === 'pending') {
        this.structuredRecords.set(key, { ...row, visibility: 'active' });
      }
    }
  }

  async removeGenerationRows(filePath: string, generationId: string): Promise<void> {
    for (const key of this.structuredRecords.keys()) {
      const row = this.structuredRecords.get(key);
      if (row?.chunk.filePath === filePath && row.generationId === generationId) {
        this.structuredRecords.delete(key);
      }
    }
  }

  async beginStructuredShadowTable(): Promise<StructuredShadowTable> {
    this.structuredSwapBackup = undefined;
    const name = `in-memory-structured-shadow-${randomUUID()}`;
    this.structuredShadow = { name, records: new Map() };
    return { name };
  }

  async swapStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void> {
    if (this.structuredShadow?.name !== shadowTable.name) {
      throw new Error('InMemoryVectorStore.swapStructuredShadowTable: no shadow table in progress');
    }
    this.structuredSwapBackup = {
      handleName: shadowTable.name,
      records: new Map(this.structuredRecords),
    };
    this.structuredRecords.clear();
    for (const [key, row] of this.structuredShadow.records.entries()) {
      this.structuredRecords.set(key, { ...row, visibility: 'active' });
    }
    this.structuredShadow = undefined;
  }

  async finalizeStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void> {
    if (this.structuredSwapBackup?.handleName === shadowTable.name) {
      this.structuredSwapBackup = undefined;
    }
  }

  async abortStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void> {
    if (this.structuredSwapBackup?.handleName === shadowTable.name) {
      this.structuredRecords.clear();
      for (const [key, row] of this.structuredSwapBackup.records) this.structuredRecords.set(key, row);
      this.structuredSwapBackup = undefined;
      return;
    }
    if (this.structuredShadow?.name === shadowTable.name) {
      this.structuredShadow = undefined;
    }
  }

  async beginLegacyShadowTable(): Promise<LegacyShadowTable> {
    this.legacySwapBackup = undefined;
    const name = `in-memory-legacy-shadow-${randomUUID()}`;
    const records = new Map<string, StoredVector>();
    for (const [key, record] of this.records.entries()) {
      if (!record.deleted) {
        records.set(key, { ...record });
      }
    }
    this.legacyShadow = { name, records };
    return { name };
  }

  async stageLegacyShadowChunks(shadow: LegacyShadowTable, chunks: ChunkWithEmbedding[]): Promise<void> {
    const shadowState = this.legacyShadow;
    if (shadowState?.name !== shadow.name) {
      throw new Error('InMemoryVectorStore.stageLegacyShadowChunks: no shadow table in progress');
    }
    const shadowMap = shadowState.records;
    for (const { chunk, vector } of chunks) {
      if (vector.length !== this.dimensions) {
        throw new Error(`InMemoryVectorStore.stageLegacyShadowChunks: vector length mismatch for chunk ${chunk.id} (expected ${this.dimensions}, got ${vector.length})`);
      }
      if (!vector.every(Number.isFinite)) {
        throw new Error(`InMemoryVectorStore.stageLegacyShadowChunks: vector contains non-finite values for chunk ${chunk.id}`);
      }
    }

    // Upsert semantics: drop existing rows for the affected files before adding.
    const affectedFilePaths = new Set(chunks.map(({ chunk }) => chunk.filePath));
    for (const key of shadowMap.keys()) {
      const record = shadowMap.get(key);
      if (record && affectedFilePaths.has(record.chunk.filePath)) {
        shadowMap.delete(key);
      }
    }
    for (const { chunk, vector } of chunks) {
      shadowMap.set(chunk.id, { chunk, vector, deleted: false });
    }
  }

  async stageLegacyShadowDeletions(
    shadow: LegacyShadowTable,
    deletions: LegacyShadowDeletion,
  ): Promise<void> {
    const shadowState = this.legacyShadow;
    if (shadowState?.name !== shadow.name) {
      throw new Error('InMemoryVectorStore.stageLegacyShadowDeletions: no shadow table in progress');
    }
    const shadowMap = shadowState.records;
    const filePaths = new Set(deletions.filePaths ?? []);
    const prefixes = (deletions.pathPrefixes ?? []).map((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`));
    for (const key of shadowMap.keys()) {
      const record = shadowMap.get(key);
      if (!record) continue;
      const path = record.chunk.filePath;
      const matches = filePaths.has(path) || prefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
      if (matches) {
        shadowMap.delete(key);
      }
    }
  }

  async swapLegacyShadowTable(shadow: LegacyShadowTable): Promise<void> {
    const shadowState = this.legacyShadow;
    if (shadowState?.name !== shadow.name) {
      throw new Error('InMemoryVectorStore.swapLegacyShadowTable: no shadow table in progress');
    }
    this.legacySwapBackup = {
      handleName: shadow.name,
      records: new Map(this.records),
      deletedCount: this.deletedCount,
    };
    this.records.clear();
    for (const [key, record] of shadowState.records.entries()) {
      this.records.set(key, { ...record, deleted: false });
    }
    this.legacyShadow = undefined;
    // Staged rows are physically present (no tombstones), so counters are clean after the swap.
    this.deletedCount = 0;
  }

  async finalizeLegacyShadowTable(shadow: LegacyShadowTable): Promise<void> {
    if (this.legacySwapBackup?.handleName === shadow.name) {
      this.legacySwapBackup = undefined;
    }
  }

  async abortLegacyShadowTable(shadow: LegacyShadowTable): Promise<void> {
    if (this.legacySwapBackup?.handleName === shadow.name) {
      this.records.clear();
      for (const [key, record] of this.legacySwapBackup.records) this.records.set(key, record);
      this.deletedCount = this.legacySwapBackup.deletedCount;
      this.legacySwapBackup = undefined;
      return;
    }
    if (this.legacyShadow?.name === shadow.name) {
      this.legacyShadow = undefined;
    }
  }

  async reconcileStructuredRows(activeGenerations: readonly ActiveGeneration[]): Promise<void> {
    const activeKeys = new Set(activeGenerations.map((ag) => this.structuredKey(ag.filePath, ag.generationId, '')));
    for (const key of this.structuredRecords.keys()) {
      const row = this.structuredRecords.get(key);
      if (!row) continue;
      const rowFileGenKey = this.structuredKey(row.chunk.filePath, row.generationId, '');
      if (!activeKeys.has(rowFileGenKey)) {
        this.structuredRecords.delete(key);
      }
    }
  }

  async compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    const fragmentationRatioBefore = this.calculateFragmentationRatio();
    const threshold = config?.fragmentationThreshold ?? 0.2;
    const minStale = config?.minStaleChunks ?? 1;

    if (fragmentationRatioBefore <= threshold || this.deletedCount < minStale) {
      return {
        compacted: false,
        fragmentationRatioBefore,
        fragmentationRatioAfter: fragmentationRatioBefore,
        chunksRemoved: 0,
      };
    }

    const removed = [...this.records.entries()].filter(([, record]) => record.deleted);
    for (const [id] of removed) {
      this.records.delete(id);
    }
    this.deletedCount = 0;
    this.lastCompactedAt = new Date().toISOString();

    return {
      compacted: true,
      fragmentationRatioBefore,
      fragmentationRatioAfter: this.calculateFragmentationRatio(),
      chunksRemoved: removed.length,
    };
  }

  async compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.compactIfNeeded(config);
  }

  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs = 0,
    mutex?: CompactionMutex,
    abortSignal?: AbortSignal,
    mutexTimeoutMs = 30000,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      if (abortSignal?.aborted) {
        return;
      }

      Promise.resolve()
        .then(async () => {
          if (mutex) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
              controller.abort(new Error(`Compaction mutex acquisition timed out after ${mutexTimeoutMs}ms`));
            }, mutexTimeoutMs);

            const onAbort = () => {
              controller.abort();
            };
            if (abortSignal) {
              abortSignal.addEventListener('abort', onAbort, { once: true });
            }

            try {
              await mutex.waitForUnlock(controller.signal);
            } catch (error) {
              if (controller.signal.aborted && controller.signal.reason) {
                throw controller.signal.reason;
              }
              throw error;
            } finally {
              clearTimeout(timeoutId);
              if (abortSignal) {
                abortSignal.removeEventListener('abort', onAbort);
              }
            }
          }
        })
        .then(() => {
          if (abortSignal?.aborted) {
            return;
          }
          return runCompaction();
        })
        .catch((error) => {
          if (error.name === 'AbortError' || abortSignal?.aborted) {
            return;
          }
          console.error('Compaction failed:', error);
        });
    }, delayMs);
  }

  async getStats(): Promise<VectorStoreStats> {
    const active = [...this.records.values()].filter((record) => !record.deleted);
    const fileCount = new Set(active.map((record) => record.chunk.filePath)).size;

    return {
      totalChunks: active.length,
      totalFiles: fileCount,
      dimensions: this.dimensions,
      fragmentationRatio: this.calculateFragmentationRatio(),
      lastCompactedAt: this.lastCompactedAt,
    };
  }

  async close(_timeoutMs?: number): Promise<void> {
    // No-op: InMemoryVectorStore has no external resources to release.
  }

  private vectorize(content: string): number[] {
    const base = content.charCodeAt(0) % 10;
    return Array.from({ length: this.dimensions }, (_, index) => (index === base % this.dimensions ? 1 : 0));
  }

  private calculateFragmentationRatio(): number {
    const total = this.records.size;
    if (total === 0) {
      return 0;
    }

    return this.deletedCount / total;
  }

  private structuredKey(filePath: string, generationId: string, chunkId: string): string {
    return `${filePath}\u0000${generationId}\u0000${chunkId}`;
  }
}
