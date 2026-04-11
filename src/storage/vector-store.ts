import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface LanceRow {
  id: string;
  filepath: string;
  content: string;
  language: string;
  symbolname: string;
  symbolkind: CodeChunk['symbolKind'];
  startline: number;
  endline: number;
  hash: string;
  vector: number[] | Float32Array;
  [key: string]: unknown;
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
  private staleCount = 0;

  constructor(options: LanceVectorStoreOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('dimensions must be a positive integer');
    }
    // インメモリモード (memory://) は削除操作が不安定な場合があるため、一時ディレクトリを優先する
    this.dbPath = options.dbPath && options.dbPath !== 'memory://'
      ? options.dbPath
      : join(tmpdir(), `nexus-lance-${Math.random().toString(36).slice(2)}`);
    this.dimensions = options.dimensions;
  }

  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }
    if (this.dbPath && !this.dbPath.includes('://')) {
      await mkdir(this.dbPath, { recursive: true });
    }
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
  async close(timeoutMs?: number): Promise<void> {
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
      const effectiveTimeout = timeoutMs ?? LanceVectorStore.CLOSE_TIMEOUT_MS;
      const inflightDone = new Promise<void>((resolve) => {
        if (this.inflightOps === 0) {
          resolve();
        } else {
          this.closingResolve = resolve;
        }
      });
      let timerHandle: NodeJS.Timeout;
      const timeout = new Promise<'timeout'>((resolve) => {
        timerHandle = setTimeout(() => { resolve('timeout'); }, effectiveTimeout);
      });
      const result = await Promise.race([inflightDone.then(() => 'done' as const), timeout]);
      clearTimeout(timerHandle!);
      if (result === 'timeout') {
        console.error(
          `[LanceVectorStore] close() timed out after ${effectiveTimeout}ms ` +
          `with ${this.inflightOps} in-flight operation(s). Forcing resource release.`
        );
      }
    }

    // 3. Release LanceDB resources
    try {
      const tableObj = this.table as unknown as Record<string, unknown>;
      if (tableObj && typeof tableObj.close === 'function') {
        await (tableObj.close as () => Promise<void>)();
      }

      const dbObj = this.db as unknown as Record<string, unknown>;
      if (dbObj && typeof dbObj.close === 'function') {
        await (dbObj.close as () => Promise<void>)();
      }
    } catch (e) {
      console.error('[LanceVectorStore] Error closing LanceDB resources:', e);
    }
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
    if (embeddings) {
      for (const [i, emb] of embeddings.entries()) {
        if (emb.length !== this.dimensions) {
          throw new Error(
            `VectorStore.upsertChunks: vector length mismatch for chunk ${chunks[i]?.id}`
          );
        }
      }
    }

    const rows = chunks.map((chunk, i) => {
      const vector = embeddings ? (embeddings[i] ?? Array(this.dimensions).fill(0)) : Array(this.dimensions).fill(0);
      if (!vector.every(Number.isFinite)) {
        throw new Error(
          `VectorStore.upsertChunks: vector contains non-finite values for chunk ${chunk.id}`
        );
      }
      return {
        id: chunk.id,
        filepath: chunk.filePath,
        content: chunk.content,
        language: chunk.language,
        symbolname: chunk.symbolName ?? '',
        symbolkind: chunk.symbolKind,
        startline: chunk.startLine,
        endline: chunk.endLine,
        hash: chunk.hash,
        vector,
      };
    });

    await this.trackOp(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      const db = this.db;
      if (!this.table) {
        if (rows.length === 0) return;
        this.table = await db.createTable('chunks', rows);
        return;
      }

      // パス B: delete-then-add
      // 対象ファイルのチャンクを削除し、新データを追加する
      const filePaths = [...new Set(chunks.map((c) => c.filePath))];
      for (const fp of filePaths) {
        const filter = this.filePathFilter(fp);
        const count = await this.table.countRows(filter);
        if (count > 0) {
          await this.table.delete(filter);
          this.staleCount += count;
        }
      }
      
      if (rows.length > 0) {
        await this.table.add(rows);
      }
    });
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.table) return 0;
      
      const filter = this.filePathFilter(filePath);
      const count = await this.table.countRows(filter);
      if (count > 0) {
        await this.table.delete(filter);
        this.staleCount += count;
      }
      return count;
    });
  }

  async deleteByPathPrefix(pathPrefix: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.table) return 0;

      const filter = this.filePathPrefixFilter(pathPrefix);
      const count = await this.table.countRows(filter);
      if (count > 0) {
        await this.table.delete(filter);
        this.staleCount += count;
      }
      return count;
    });
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.table) return 0;

      const filter = this.filePathFilter(oldPath);
      const count = await this.table.countRows(filter);
      if (count > 0) {
        await this.table.update({
          where: filter,
          values: { filepath: newPath },
        });
      }
      return count;
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
      
      // 明示的にコサイン類似度を使用し、スコア計算 (1 - distance) との整合性を確保する
      let query = this.table.vectorSearch(queryVector)
        .distanceType('cosine')
        .limit(topK);
      
      // SQL フィルタの構築
      const sqlFilters: string[] = [];
      if (filter?.filePathPrefix !== undefined) {
        sqlFilters.push(this.filePathPrefixFilter(filter.filePathPrefix));
      }
      if (filter?.language !== undefined) {
        this.validateFilterValue(filter.language, 'language');
        sqlFilters.push(`language = '${this.escapeFilterValue(filter.language)}'`);
      }
      if (filter?.symbolKind !== undefined) {
        this.validateFilterValue(filter.symbolKind, 'symbolKind');
        sqlFilters.push(`symbolkind = '${this.escapeFilterValue(filter.symbolKind)}'`);
      }

      if (sqlFilters.length > 0) {
        query = query.where(sqlFilters.join(' AND '));
      }

      const resultsRaw = await query.toArray() as unknown as LanceRow[];
      
      return resultsRaw.map((row) => ({
        chunk: {
          id: row.id,
          filePath: row.filepath,
          content: row.content,
          language: row.language,
          symbolName: row.symbolname || undefined,
          symbolKind: row.symbolkind,
          startLine: row.startline,
          endLine: row.endline,
          hash: row.hash ?? '',
        },
        score: row['_distance'] != null ? 1 - (row['_distance'] as number) : 0,
      }));
    });
  }

  async getStats(): Promise<VectorStoreStats> {
    return this.trackOp(async () => {
      if (!this.table) {
        return {
          totalChunks: 0,
          totalFiles: 0,
          dimensions: this.dimensions,
          fragmentationRatio: 0,
          lastCompactedAt: this.lastCompactedAt,
        };
      }

      const totalChunks = await this.table.countRows();
      const rows = await this.table.query().select(['filepath']).toArray() as unknown as { filepath: string }[];
      const totalFiles = new Set(rows.map(r => r.filepath)).size;

      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatio = totalPossible > 0 ? this.staleCount / totalPossible : 0;

      return {
        totalChunks,
        totalFiles,
        dimensions: this.dimensions,
        fragmentationRatio,
        lastCompactedAt: this.lastCompactedAt,
      };
    });
  }

  async compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.trackOp(async () => {
      const threshold = config?.fragmentationThreshold ?? 0.2;
      const minStale = config?.minStaleChunks ?? 1;

      const totalChunks = this.table ? await this.table.countRows() : 0;
      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatioBefore = totalPossible > 0 ? this.staleCount / totalPossible : 0;

      const shouldCompact =
        (threshold === 0) ||
        (this.staleCount >= minStale && fragmentationRatioBefore >= threshold);

      const wasStale = this.staleCount > 0;

      if (shouldCompact) {
        if (this.table) {
          await this.table.optimize();
        }
        const removed = this.staleCount;
        this.staleCount = 0;
        this.lastCompactedAt = new Date().toISOString();
        return {
          compacted: true,
          fragmentationRatioBefore,
          fragmentationRatioAfter: 0,
          chunksRemoved: wasStale ? removed : 0,
        };
      }

      return {
        compacted: false,
        fragmentationRatioBefore,
        fragmentationRatioAfter: fragmentationRatioBefore,
        chunksRemoved: 0,
      };
    });
  }

  async compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.trackOp(async () => {
      if (this.table) {
        await this.table.optimize();
      }
      
      const totalChunks = this.table ? await this.table.countRows() : 0;
      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatioBefore = totalPossible > 0 ? this.staleCount / totalPossible : 0;
      
      const wasStale = this.staleCount > 0;
      const removed = this.staleCount;
      this.staleCount = 0;
      this.lastCompactedAt = new Date().toISOString();

      return {
        compacted: wasStale || config?.fragmentationThreshold === 0,
        fragmentationRatioBefore,
        fragmentationRatioAfter: 0,
        chunksRemoved: wasStale ? removed : 0,
      };
    });
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

          abortSignal?.addEventListener('abort', onAbort, { once: true });
          this.abortController.signal.addEventListener('abort', onAbort, { once: true });

          try {
            await mutex.waitForUnlock(controller.signal);
          } catch (error) {
            if (controller.signal.aborted && controller.signal.reason) {
              throw controller.signal.reason;
            }
            throw error;
          } finally {
            clearTimeout(timeoutId);
            abortSignal?.removeEventListener('abort', onAbort);
            this.abortController.signal.removeEventListener('abort', onAbort);
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

  private static readonly ALLOWED_FILTER_VALUE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}\p{S}\p{M}]*$/u;
  // eslint-disable-next-line no-control-regex
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
    return `filepath = '${this.escapeFilterValue(filePath)}'`;
  }

  protected filePathPrefixFilter(prefix: string): string {
    this.validateFilterValue(prefix, 'prefix');
    return `filepath LIKE '${this.escapeLikeValue(prefix)}%' ESCAPE '\\\\'`;
  }
}