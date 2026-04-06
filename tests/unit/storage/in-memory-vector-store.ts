import type {
  CodeChunk,
  CompactionConfig,
  CompactionResult,
  IVectorStore,
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

  private deletedCount = 0;

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
      const prior = this.records.get(chunk.id);
      if (prior?.deleted) {
        this.deletedCount -= 1;
      }
      this.records.set(chunk.id, {
        chunk,
        vector: embeddings ? embeddings[i]! : this.vectorize(chunk.content),
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
    for (const record of this.records.values()) {
      if (record.chunk.filePath.startsWith(pathPrefix) && !record.deleted) {
        record.deleted = true;
        deleted += 1;
        this.deletedCount += 1;
      }
    }

    return deleted;
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<number> {
    let renamed = 0;
    for (const record of this.records.values()) {
      if (record.chunk.filePath !== oldPath || record.deleted) {
        continue;
      }

      record.chunk = {
        ...record.chunk,
        id: record.chunk.id.replace(oldPath, newPath),
        filePath: newPath,
        hash: record.chunk.hash.replace(oldPath, newPath),
      };
      renamed += 1;
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

    return [...this.records.values()]
      .filter((record) => !record.deleted)
      .filter((record) => {
        if (filter?.filePathPrefix !== undefined && !record.chunk.filePath.startsWith(filter.filePathPrefix)) {
          return false;
        }
        if (filter?.language !== undefined && record.chunk.language !== filter.language) {
          return false;
        }
        if (filter?.symbolKind !== undefined && record.chunk.symbolKind !== filter.symbolKind) {
          return false;
        }
        return true;
      })
      .map((record) => ({
        chunk: record.chunk,
        score: cosineSimilarity(queryVector, record.vector),
      }))
      .sort((left, right) => right.score - left.score || left.chunk.filePath.localeCompare(right.chunk.filePath))
      .slice(0, topK);
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

  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs = 0,
    mutex?: { waitForUnlock(): Promise<void> },
  ): void {
    setTimeout(() => {
      Promise.resolve()
        .then(() => mutex?.waitForUnlock())
        .then(() => runCompaction())
        .catch((error) => {
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
}
