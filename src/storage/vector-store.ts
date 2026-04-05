import type {
  CodeChunk,
  CompactionConfig,
  CompactionResult,
  IVectorStore,
  VectorFilter,
  VectorSearchResult,
  VectorStoreStats,
} from '../types/index.js';

interface LanceVectorStoreOptions {
  dimensions: number;
}

interface StoredVectorRow {
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

export class LanceVectorStore implements IVectorStore {
  // TODO: Replace Map with actual LanceDB integration (@lancedb/lancedb) in Phase 2.
  private readonly dimensions: number;

  private readonly rows = new Map<string, StoredVectorRow>();

  private deletedCount = 0;

  private lastCompactedAt: string | undefined;

  private readonly asyncBoundary = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  constructor(options: LanceVectorStoreOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('dimensions must be a positive integer');
    }
    this.dimensions = options.dimensions;
  }

  async initialize(): Promise<void> {
    await this.asyncBoundary();
    return;
  }

  async upsertChunks(chunks: CodeChunk[], embeddings?: number[][]): Promise<void> {
    await this.asyncBoundary();
    if (embeddings && embeddings.length !== chunks.length) {
      throw new Error(`VectorStore.upsertChunks: embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = embeddings ? embeddings[i]! : this.vectorize(chunk.content);

      if (vector.length !== this.dimensions) {
        throw new Error(`VectorStore.upsertChunks: vector length mismatch for chunk ${chunk.id} (expected ${this.dimensions}, got ${vector.length})`);
      }
      if (!vector.every(Number.isFinite)) {
        throw new Error(`VectorStore.upsertChunks: vector contains non-finite values for chunk ${chunk.id}`);
      }

      const existing = this.rows.get(chunk.id);
      if (existing?.deleted) {
        this.deletedCount -= 1;
      }
      this.rows.set(chunk.id, {
        chunk,
        vector,
        deleted: false,
      });
    }
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    await this.asyncBoundary();
    let deleted = 0;
    for (const row of this.rows.values()) {
      if (row.chunk.filePath === filePath && !row.deleted) {
        row.deleted = true;
        deleted += 1;
        this.deletedCount += 1;
      }
    }
    return deleted;
  }

  async deleteByPathPrefix(pathPrefix: string): Promise<number> {
    await this.asyncBoundary();
    let deleted = 0;
    for (const row of this.rows.values()) {
      if (row.chunk.filePath.startsWith(pathPrefix) && !row.deleted) {
        row.deleted = true;
        deleted += 1;
        this.deletedCount += 1;
      }
    }
    return deleted;
  }

  async search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]> {
    if (queryVector.length !== this.dimensions) {
      throw new Error(`queryVector length must be ${this.dimensions}`);
    }
    if (!queryVector.every(Number.isFinite)) {
      throw new TypeError('queryVector contains non-finite values');
    }
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new RangeError('topK must be a positive integer');
    }

    await this.asyncBoundary();
    return [...this.rows.values()]
      .filter((row) => !row.deleted)
      .filter((row) => {
        if (filter?.filePathPrefix !== undefined && !row.chunk.filePath.startsWith(filter.filePathPrefix)) {
          return false;
        }
        if (filter?.language !== undefined && row.chunk.language !== filter.language) {
          return false;
        }
        if (filter?.symbolKind !== undefined && row.chunk.symbolKind !== filter.symbolKind) {
          return false;
        }
        return true;
      })
      .map((row) => ({
        chunk: row.chunk,
        score: cosineSimilarity(queryVector, row.vector),
      }))
      .sort((left, right) => right.score - left.score || left.chunk.filePath.localeCompare(right.chunk.filePath))
      .slice(0, topK);
  }

  async compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    await this.asyncBoundary();
    const fragmentationRatioBefore = this.fragmentationRatio();
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

    const removedEntries = [...this.rows.entries()].filter(([, row]) => row.deleted);
    for (const [id] of removedEntries) {
      this.rows.delete(id);
    }
    this.deletedCount = 0;
    this.lastCompactedAt = new Date().toISOString();

    return {
      compacted: true,
      fragmentationRatioBefore,
      fragmentationRatioAfter: this.fragmentationRatio(),
      chunksRemoved: removedEntries.length,
    };
  }

  scheduleIdleCompaction(runCompaction: () => Promise<void>, delayMs = 0): void {
    setTimeout(() => {
      Promise.resolve()
        .then(() => runCompaction())
        .catch((error) => {
          console.error('Compaction failed:', error);
        });
    }, delayMs);
  }

  async getStats(): Promise<VectorStoreStats> {
    await this.asyncBoundary();
    const activeRows = [...this.rows.values()].filter((row) => !row.deleted);
    const fileCount = new Set(activeRows.map((row) => row.chunk.filePath)).size;

    return {
      totalChunks: activeRows.length,
      totalFiles: fileCount,
      dimensions: this.dimensions,
      fragmentationRatio: this.fragmentationRatio(),
      lastCompactedAt: this.lastCompactedAt,
    };
  }

  private vectorize(content: string): number[] {
    // TODO: Replace this trivial one-hot vectorization with actual embedding vectors 
    // from an EmbeddingProvider. This is a temporary scaffold.
    const first = content.charCodeAt(0) || 0;
    return Array.from({ length: this.dimensions }, (_, index) => (index === first % this.dimensions ? 1 : 0));
  }

  private fragmentationRatio(): number {
    if (this.rows.size === 0) {
      return 0;
    }
    return this.deletedCount / this.rows.size;
  }
}
