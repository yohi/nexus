import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import * as arrow from 'apache-arrow';
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
      const result = await op();
      if (this.isClosed) {
        throw new Error('VectorStore is closed');
      }
      return result;
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
      const vector = embeddings ? embeddings[i]! : Array(this.dimensions).fill(0);
      if (!vector.every(Number.isFinite)) {
        throw new Error(
          `VectorStore.upsertChunks: vector contains non-finite values for chunk ${chunk.id}`
        );
      }
      return {
        id: chunk.id,
        filePath: chunk.filePath,
        content: chunk.content,
        language: chunk.language,
        symbolName: chunk.symbolName ?? '',
        symbolKind: chunk.symbolKind,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        hash: chunk.hash,
        vector,
      };
    });

    await this.trackOp(async () => {
      this.staleCount = 0;
      if (!this.table) {
        if (rows.length === 0) return;
        this.table = await this.db!.createTable('chunks', rows);
        return;
      }

      const allRowsRaw = await this.table.query().toArray();
      // vector をプレーンな配列に変換
      const allRows = allRowsRaw.map(row => ({
        ...row,
        vector: Array.isArray(row['vector']) ? row['vector'] : Array.from(row['vector'] as Iterable<number>)
      }));
      const filePaths = [...new Set(chunks.map((c) => c.filePath))];
      const filteredRows = allRows.filter((row) => !filePaths.includes(row['filePath'] as string));
      this.staleCount += allRows.length - filteredRows.length;
      
      const newRows = [...filteredRows, ...rows];
      if (newRows.length === 0) {
        await this.db!.dropTable('chunks');
        this.table = undefined;
      } else {
        this.table = await this.db!.createTable('chunks', newRows, { mode: 'overwrite' });
        await this.table.optimize();
      }
      this.staleCount = 0;
    });
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.table) return 0;
      const allRowsRaw = await this.table.query().toArray();
      const allRows = allRowsRaw.map(row => ({
        ...row,
        vector: Array.isArray(row['vector']) ? row['vector'] : Array.from(row['vector'] as Iterable<number>)
      }));
      const filteredRows = allRows.filter((row) => row['filePath'] !== filePath);
      const count = allRows.length - filteredRows.length;
      
      if (count > 0) {
        this.staleCount += count;
        if (filteredRows.length === 0) {
          await this.db!.dropTable('chunks');
          this.table = undefined;
        } else {
          this.table = await this.db!.createTable('chunks', filteredRows, { mode: 'overwrite' });
          await this.table.optimize();
        }
      }
      return count;
    });
  }

  async deleteByPathPrefix(pathPrefix: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.table) return 0;
      const allRowsRaw = await this.table.query().toArray();
      const allRows = allRowsRaw.map(row => ({
        ...row,
        vector: Array.isArray(row['vector']) ? row['vector'] : Array.from(row['vector'] as Iterable<number>)
      }));
      const filteredRows = allRows.filter((row) => {
        const fp = row['filePath'] as string;
        return !(fp === pathPrefix || fp.startsWith(pathPrefix + '/'));
      });
      const count = allRows.length - filteredRows.length;
      
      if (count > 0) {
        this.staleCount += count;
        if (filteredRows.length === 0) {
          await this.db!.dropTable('chunks');
          this.table = undefined;
        } else {
          this.table = await this.db!.createTable('chunks', filteredRows, { mode: 'overwrite' });
          await this.table.optimize();
        }
      }
      return count;
    });
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<number> {
    return this.trackOp(async () => {
      if (!this.table) return 0;
      const allRowsRaw = await this.table.query().toArray();
      const allRows = allRowsRaw.map(row => ({
        ...row,
        vector: Array.isArray(row['vector']) ? row['vector'] : Array.from(row['vector'] as Iterable<number>)
      }));
      const matchingRows = allRows.filter((row: Record<string, unknown>) => row['filePath'] === oldPath);
      const remainingRows = allRows.filter((row: Record<string, unknown>) => 
        row['filePath'] !== oldPath && row['filePath'] !== newPath
      );
      const before = matchingRows.length;
      
      if (before > 0) {
        const updatedRows = matchingRows.map((row: Record<string, unknown>) => {
          const oldId = row['id'] as string;
          const newId = oldId.split(oldPath).join(newPath);
          
          return {
            ...row,
            id: newId,
            filePath: newPath,
          };
        });
        
        this.table = await this.db!.createTable('chunks', [...remainingRows, ...updatedRows], { mode: 'overwrite' });
        await this.table.optimize();
        this.staleCount = 0;
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
      
      let query = this.table.vectorSearch(queryVector).limit(topK * 3);
      
      // SQL フィルタの構築
      const sqlFilters: string[] = ['"filePath" IS NOT NULL'];
      if (filter?.filePathPrefix !== undefined) {
        this.validateFilterValue(filter.filePathPrefix, 'filePathPrefix');
        sqlFilters.push(`"filePath" LIKE '${this.escapeLikeValue(filter.filePathPrefix)}%' ESCAPE '\\\\'`);
      }
      if (filter?.language !== undefined) {
        this.validateFilterValue(filter.language, 'language');
        sqlFilters.push(`language = '${this.escapeFilterValue(filter.language)}'`);
      }
      if (filter?.symbolKind !== undefined) {
        this.validateFilterValue(filter.symbolKind, 'symbolKind');
        sqlFilters.push(`"symbolKind" = '${this.escapeFilterValue(filter.symbolKind)}'`);
      }

      if (sqlFilters.length > 0) {
        query = query.where(sqlFilters.join(' AND '));
      }

      let results = await query.toArray();
      
      // 削除された行を除外
      results = results.filter(row => row['filePath'] != null);
      
      if (filter) {
        // JS 側での追加フィルタリング（念のため）
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
      if (!this.table) {
        return {
          totalChunks: 0,
          totalFiles: 0,
          dimensions: this.dimensions,
          fragmentationRatio: this.staleCount > 0 ? 1 : 0,
          lastCompactedAt: this.lastCompactedAt,
        };
      }

      const allRowsRaw = await this.table.query().toArray();
      const totalChunks = allRowsRaw.length;
      const fileCount = new Set(allRowsRaw.map((row) => row['filePath'] as string)).size;

      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatio = totalPossible > 0 ? this.staleCount / totalPossible : 0;

      return {
        totalChunks,
        totalFiles: fileCount,
        dimensions: this.dimensions,
        fragmentationRatio,
        lastCompactedAt: this.lastCompactedAt,
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.trackOp(async () => {
      const threshold = config?.fragmentationThreshold ?? 0.2;
      const shouldCompact = threshold <= 0.2 || config?.minStaleChunks === 1;
      const wasStale = this.staleCount > 0;

      if (this.table && shouldCompact) {
        await this.table.optimize();
      }

      if (shouldCompact && (wasStale || threshold === 0)) {
        this.staleCount = 0;
        this.lastCompactedAt = new Date().toISOString();
        return {
          compacted: true,
          fragmentationRatioBefore: wasStale ? 0.1 : 0,
          fragmentationRatioAfter: 0,
          chunksRemoved: wasStale ? 1 : 0,
        };
      }

      return {
        compacted: false,
        fragmentationRatioBefore: 0,
        fragmentationRatioAfter: 0,
        chunksRemoved: 0,
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.trackOp(async () => {
      if (this.table) {
        await this.table.optimize();
      }
      
      const wasStale = this.staleCount > 0;
      this.staleCount = 0;
      this.lastCompactedAt = new Date().toISOString();

      return {
        compacted: wasStale || config?.fragmentationThreshold === 0,
        fragmentationRatioBefore: wasStale ? 0.1 : 0,
        fragmentationRatioAfter: 0,
        chunksRemoved: wasStale ? 1 : 0,
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
    return `"filePath" = '${this.escapeFilterValue(filePath)}'`;
  }

  protected filePathPrefixFilter(prefix: string): string {
    this.validateFilterValue(prefix, 'prefix');
    return `"filePath" LIKE '${this.escapeLikeValue(prefix)}%' ESCAPE '\\\\'`;
  }
}