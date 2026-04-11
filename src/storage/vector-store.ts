import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import { mkdir } from 'node:fs/promises';
import type {
  CodeChunk,
  CompactionConfig,
  CompactionMutex,
  CompactionResult,
  IVectorStore,
  VectorFilter,
  VectorSearchResult,
  VectorStoreStats,
} from '../types/index.js';

interface LanceVectorStoreOptions {
  dbPath?: string;
  dimensions: number;
}

export class LanceVectorStore implements IVectorStore {
  private readonly dbPath: string;
  private readonly dimensions: number;
  private db: lancedb.Connection | undefined;
  private table: Table | undefined;

  private inflightOps = 0;
  private closingResolve: (() => void) | undefined;
  private isClosed = false;
  private static readonly CLOSE_TIMEOUT_MS = 5_000;

  private readonly activeTimeouts = new Set<NodeJS.Timeout>();
  private readonly abortController = new AbortController();

  private lastCompactedAt: string | undefined;

  constructor(options: LanceVectorStoreOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('dimensions must be a positive integer');
    }
    this.dbPath = options.dbPath ?? '';
    this.dimensions = options.dimensions;
  }

  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }
    await mkdir(this.dbPath, { recursive: true });
    this.db = await lancedb.connect(this.dbPath);
    const tableNames = await this.db.tableNames();
    if (tableNames.includes('chunks')) {
      this.table = await this.db.openTable('chunks');
    }
  }

  async resetForTest(): Promise<void> {
    if (this.table && this.db) {
      await this.table.delete('true');
    }
  }

  private async trackOp<T>(op: () => Promise<T>): Promise<T> {
    if (this.isClosed) {
      throw new Error('VectorStore is closed');
    }
    this.inflightOps++;
    try {
      return await op();
    } finally {
      this.inflightOps--;
      if (this.isClosed && this.inflightOps === 0 && this.closingResolve) {
        this.closingResolve();
      }
    }
  }

  /**
   * Performs an idempotent, safe shutdown of the vector store.
   * Stops all timers, aborts ongoing operations, and waits for in-flight I/O to settle.
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    // 1. Abort ongoing operations and clear all scheduled timeouts
    this.abortController.abort();
    for (const timeout of this.activeTimeouts) {
      clearTimeout(timeout);
    }
    this.activeTimeouts.clear();

    // 2. Wait for in-flight operations to settle with a timeout
    if (this.inflightOps > 0) {
      const inflightDone = new Promise<void>((resolve) => {
        this.closingResolve = resolve;
      });
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), LanceVectorStore.CLOSE_TIMEOUT_MS);
      });
      const result = await Promise.race([inflightDone.then(() => 'done' as const), timeout]);
      if (result === 'timeout') {
        console.error(
          `[LanceVectorStore] close() timed out after ${LanceVectorStore.CLOSE_TIMEOUT_MS}ms ` +
          `with ${this.inflightOps} in-flight operation(s). Forcing resource release.`
        );
      }
    }

    // 3. Release LanceDB resources
    this.table = undefined;
    this.db = undefined;
    this.closingResolve = undefined;
  }

  async upsertChunks(chunks: CodeChunk[], embeddings?: number[][]): Promise<void> {
    if (embeddings && embeddings.length !== chunks.length) {
      throw new Error(
        `VectorStore.upsertChunks: embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`
      );
    }
    const rows = chunks.map((chunk, i) => ({
      id: chunk.id,
      filePath: chunk.filePath,
      content: chunk.content,
      language: chunk.language,
      symbolName: chunk.symbolName ?? '',
      symbolKind: chunk.symbolKind,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunk.hash,
      vector: embeddings ? embeddings[i]! : [],
    }));

    await this.trackOp(async () => {
      if (!this.table) {
        this.table = await this.db!.createTable('chunks', rows);
        return;
      }
      const filePaths = [...new Set(chunks.map((c) => c.filePath))];
      for (const fp of filePaths) {
        await this.table.delete(this.filePathFilter(fp));
      }
      await this.table.add(rows);
    });
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.table) return 0;
      const allRows = await this.table.query().toArray();
      const matchingRows = allRows.filter((row: Record<string, unknown>) => row['filePath'] === filePath);
      const before = matchingRows.length;
      if (before > 0) {
        await this.table.delete(this.filePathFilter(filePath));
      }
      return before;
    });
  }

  async deleteByPathPrefix(pathPrefix: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.table) return 0;
      const allRows = await this.table.query().toArray();
      const matchingRows = allRows.filter((row: Record<string, unknown>) => {
        const filePath = row['filePath'] as string;
        return filePath === pathPrefix || filePath.startsWith(pathPrefix + '/');
      });
      const before = matchingRows.length;
      if (before > 0) {
        const filter = this.filePathPrefixFilter(pathPrefix);
        await this.table.delete(filter);
      }
      return before;
    });
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.table) return 0;
      const allRows = await this.table.query().toArray();
      const matchingRows = allRows.filter((row: Record<string, unknown>) => row['filePath'] === oldPath);
      const before = matchingRows.length;
      
      if (before > 0) {
        const updatedRows = matchingRows.map((row: Record<string, unknown>) => {
          const vec = row['vector'];
          return {
            id: row['id'],
            filePath: newPath,
            content: row['content'],
            language: row['language'],
            symbolName: row['symbolName'] ?? '',
            symbolKind: row['symbolKind'],
            startLine: row['startLine'],
            endLine: row['endLine'],
            hash: row['hash'] ?? '',
            vector: Array.isArray(vec) ? vec : [],
          };
        });
        
        await this.table.delete(this.filePathFilter(oldPath));
        await this.table.add(updatedRows);
      }
      return before;
    });
  }

  async search(
    queryVector: number[],
    topK: number,
    filter?: VectorFilter,
  ): Promise<VectorSearchResult[]> {
    if (queryVector.length !== this.dimensions) {
      throw new Error(`queryVector length must be ${this.dimensions}`);
    }
    if (!queryVector.every(Number.isFinite)) {
      throw new TypeError('queryVector contains non-finite values');
    }
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new RangeError('topK must be a positive integer');
    }

    return this.trackOp(async () => {
      if (!this.table) return [];
      let results = await this.table.vectorSearch(queryVector).limit(topK * 3).toArray();
      
      if (filter) {
        results = results.filter((row: Record<string, unknown>) => {
          if (filter.filePathPrefix !== undefined) {
            const filePath = row['filePath'] as string;
            if (!filePath.startsWith(filter.filePathPrefix)) return false;
          }
          if (filter.language !== undefined) {
            if (row['language'] !== filter.language) return false;
          }
          if (filter.symbolKind !== undefined) {
            if (row['symbolKind'] !== filter.symbolKind) return false;
          }
          return true;
        });
      }

      return results.slice(0, topK).map((row: Record<string, unknown>) => ({
        chunk: {
          id: row['id'] as string,
          filePath: row['filePath'] as string,
          content: row['content'] as string,
          language: row['language'] as string,
          symbolName: (row['symbolName'] as string) || undefined,
          symbolKind: row['symbolKind'] as CodeChunk['symbolKind'],
          startLine: row['startLine'] as number,
          endLine: row['endLine'] as number,
          hash: (row['hash'] as string) ?? '',
        },
        score: row['_distance'] != null ? 1 - (row['_distance'] as number) : 0,
      }));
    });
  }

  async getStats(): Promise<VectorStoreStats> {
    return this.trackOp(async () => {
      const totalChunks = this.table ? await this.table.countRows() : 0;
      const fileCount = this.table ? (await this.table.query().toArray()).length : 0;

      return {
        totalChunks,
        totalFiles: fileCount,
        dimensions: this.dimensions,
        fragmentationRatio: 0,
        lastCompactedAt: this.lastCompactedAt,
      };
    });
  }

  async compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.trackOp(async () => {
      if (!this.table) {
        return {
          compacted: false,
          fragmentationRatioBefore: 0,
          fragmentationRatioAfter: 0,
          chunksRemoved: 0,
        };
      }

      const fragmentationRatioBefore = 0;

      return {
        compacted: false,
        fragmentationRatioBefore,
        fragmentationRatioAfter: fragmentationRatioBefore,
        chunksRemoved: 0,
      };
    });
  }

  async compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    if (!this.table) {
      return {
        compacted: false,
        fragmentationRatioBefore: 0,
        fragmentationRatioAfter: 0,
        chunksRemoved: 0,
      };
    }

    await this.table.optimize();
    this.lastCompactedAt = new Date().toISOString();

    return {
      compacted: true,
      fragmentationRatioBefore: 0,
      fragmentationRatioAfter: 0,
      chunksRemoved: 0,
    };
  }

  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs = 0,
    mutex?: CompactionMutex,
    abortSignal?: AbortSignal,
    mutexTimeoutMs = 30000,
  ): NodeJS.Timeout {
    if (this.isClosed) {
      // Return a dummy timeout if already closed
      return setTimeout(() => {}, 0);
    }

    const timeout = setTimeout(() => {
      this.activeTimeouts.delete(timeout);
      if (abortSignal?.aborted || this.abortController.signal.aborted) {
        return;
      }

      const operation = (async () => {
        if (mutex) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort(new Error(`Compaction mutex acquisition timed out after ${mutexTimeoutMs}ms`));
          }, mutexTimeoutMs);

          const onAbort = () => {
            controller.abort();
          };

          const combinedSignal = abortSignal || this.abortController.signal;
          combinedSignal.addEventListener('abort', onAbort, { once: true });

          try {
            await mutex.waitForUnlock(controller.signal);
          } catch (error) {
            if (controller.signal.aborted && controller.signal.reason) {
              throw controller.signal.reason;
            }
            throw error;
          } finally {
            clearTimeout(timeoutId);
            combinedSignal.removeEventListener('abort', onAbort);
          }
        }

        if (abortSignal?.aborted || this.abortController.signal.aborted) {
          return;
        }
        return runCompaction();
      })();

      operation.catch((error: unknown) => {
        if (
          (error instanceof Error && (error.name === 'AbortError' || error.message.includes('abort'))) ||
          abortSignal?.aborted ||
          this.abortController.signal.aborted
        ) {
          return;
        }
        console.error('Compaction failed:', error);
      });
    }, delayMs);

    this.activeTimeouts.add(timeout);
    return timeout;
  }

  // --- フィルタ値検証・エスケープユーティリティ ---

  private static readonly ALLOWED_FILTER_VALUE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}\p{S}]*$/u;
  private static readonly FORBIDDEN_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

  protected validateFilterValue(value: string, paramName: string): void {
    if (LanceVectorStore.FORBIDDEN_CONTROL_CHARS.test(value)) {
      throw new Error(
        `Invalid ${paramName}: contains control characters that could compromise filter integrity`
      );
    }
    if (!LanceVectorStore.ALLOWED_FILTER_VALUE_PATTERN.test(value)) {
      throw new Error(
        `Invalid ${paramName}: contains characters outside the allowed set (printable Unicode only)`
      );
    }
  }

  protected escapeFilterValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
  }

  protected escapeLikeValue(value: string): string {
    const escaped = this.escapeFilterValue(value);
    return escaped.replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  protected filePathFilter(filePath: string): string {
    this.validateFilterValue(filePath, 'filePath');
    return `"filePath" = '${this.escapeFilterValue(filePath)}'`;
  }

  protected filePathPrefixFilter(prefix: string): string {
    this.validateFilterValue(prefix, 'prefix');
    return `"filePath" LIKE '${this.escapeLikeValue(prefix)}%' ESCAPE '\\\\'`;
  }
}