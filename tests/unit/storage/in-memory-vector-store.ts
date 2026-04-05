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
    this.dimensions = options.dimensions;
  }

  async initialize(): Promise<void> {
    return;
  }

  async upsertChunks(chunks: CodeChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.records.set(chunk.id, {
        chunk,
        vector: this.vectorize(chunk.content),
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

  async search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]> {
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

    if (fragmentationRatioBefore <= threshold) {
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

  scheduleIdleCompaction(runCompaction: () => Promise<void>, delayMs = 0): void {
    setTimeout(() => {
      void runCompaction();
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
