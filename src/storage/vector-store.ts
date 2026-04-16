import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  _distance?: number;
  [key: string]: unknown;
}

interface SidecarMetadata {
  dimensions?: string;
  staleCount?: string;
  lastCompactedAt?: string;
  totalFiles?: string;
}

interface Closable {
  close(): Promise<void>;
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
  private totalFiles = 0;
  private metadataMutex: Promise<void> = Promise.resolve();
  private writeMutex: Promise<void> = Promise.resolve();
  private initPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: LanceVectorStoreOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('dimensions must be a positive integer');
    }
    // インメモリモード (memory://) は削除操作が不安定な場合があるため、一時ディレクトリを優先する
    this.dbPath = options.dbPath && options.dbPath !== 'memory://'
      ? options.dbPath
      : join(tmpdir(), `nexus-lance-${randomUUID()}`);
    
    // Path security check to prevent injection
    if (this.dbPath.includes('\0')) {
      throw new Error('Invalid dbPath: contains null byte');
    }

    this.dimensions = options.dimensions;
  }

  async initialize(): Promise<void> {
    if (this.isClosed) {
      throw new Error('VectorStore is closed');
    }
    if (this.db) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.trackOp(async () => {
      // Re-check this.db inside the lock
      if (this.db) {
        return;
      }

      // Security: dbPath is validated in constructor and potentially derived from tmpdir()
      const isUri = this.dbPath.includes('://');
      if (!isUri) {
        await mkdir(this.dbPath, { recursive: true });
      }

      let localDb: lancedb.Connection | undefined;
      let localTable: Table | undefined;

      try {
        localDb = await lancedb.connect(this.dbPath);
        if (this.isClosed) {
          return;
        }

        const tableNames = await localDb.tableNames();
        
        // 1. Attempt to load sidecar metadata for URI consistency and dimensions
        let metadata: SidecarMetadata | undefined;
        if (!isUri) {
          try {
            const metaPath = join(this.dbPath, 'metadata.json');
            const content = await readFile(metaPath, 'utf8');
            metadata = JSON.parse(content) as SidecarMetadata;
          } catch {
            // Fallback for non-existent or corrupted metadata
          }
        }

        // 2. Validate dimensions
        if (metadata?.dimensions !== undefined) {
          const persistedDim = parseInt(metadata.dimensions, 10);
          if (persistedDim !== this.dimensions) {
            throw new Error(
              `VectorStore dimension mismatch: existing storage has ${persistedDim}, but expected ${this.dimensions}`
            );
          }
        }

        if (tableNames.includes('chunks')) {
          localTable = await localDb.openTable('chunks');
          if (this.isClosed) {
            return;
          }

          // 3. Fallback dimension check from schema/data if metadata is missing
          if (metadata?.dimensions === undefined) {
            const schema = await localTable.schema();
            const vectorField = schema.fields.find(f => f.name === 'vector');
            if (!vectorField) {
              throw new Error(
                `VectorStore dimension mismatch: missing 'vector' column in existing table; reinitialize required`
              );
            }

            const firstRow = await localTable.query().limit(1).toArray() as unknown as LanceRow[];
            if (firstRow.length > 0 && firstRow[0]?.vector) {
              const actualDim = firstRow[0].vector.length;
              if (actualDim !== this.dimensions) {
                throw new Error(
                  `VectorStore dimension mismatch: existing table has ${actualDim}, but expected ${this.dimensions}`
                );
              }
            } else {
              // Empty table without metadata is treated as a mismatch to avoid silent dimension errors
              throw new Error(
                'VectorStore dimension mismatch: empty table without sidecar metadata. Explicit reinitialization required.'
              );
            }
          }

          // Restore other metadata fields
          if (metadata) {
            if (metadata.staleCount !== undefined) {
              const parsed = parseInt(metadata.staleCount, 10);
              if (Number.isFinite(parsed) && parsed >= 0) {
                this.staleCount = parsed;
              }
            }
            if (metadata.lastCompactedAt !== undefined) {
              this.lastCompactedAt = metadata.lastCompactedAt;
            }
            let validTotalFiles = false;
            if (metadata.totalFiles !== undefined) {
              const parsed = parseInt(metadata.totalFiles, 10);
              if (Number.isFinite(parsed) && parsed >= 0) {
                this.totalFiles = parsed;
                validTotalFiles = true;
              }
            }
            if (!validTotalFiles) {
              const rows = await localTable.query().select(['filepath']).toArray() as unknown as { filepath: string }[];
              this.totalFiles = new Set(rows.map(r => r.filepath)).size;
            }
          } else {
            // Initial or missing metadata: perform expensive distinct count once
            const rows = await localTable.query().select(['filepath']).toArray() as unknown as { filepath: string }[];
            this.totalFiles = new Set(rows.map(r => r.filepath)).size;
          }
        }

        // All checks passed and not closed - commit to instance fields
        if (!this.isClosed) {
          this.db = localDb;
          this.table = localTable;
          // Prevent cleanup in finally block
          localDb = undefined;
          localTable = undefined;
        }
      } finally {
        // Cleanup transient resources if they weren't committed (e.g., on error or close)
        if (localTable) {
          try {
            if ('close' in localTable && typeof (localTable as unknown as Record<string, unknown>).close === 'function') {
              await (localTable as unknown as Closable).close();
            }
          } catch (e) {
            console.error('[LanceVectorStore] Error cleaning up transient table:', e);
          }
        }
        if (localDb) {
          try {
            if ('close' in localDb && typeof (localDb as unknown as Record<string, unknown>).close === 'function') {
              await (localDb as unknown as Closable).close();
            }
          } catch (e) {
            console.error('[LanceVectorStore] Error cleaning up transient DB:', e);
          }
        }
      }
    }).finally(() => {
      this.initPromise = undefined;
    });

    return this.initPromise;
  }

  private async updateMetadata(): Promise<void> {
    if (!this.dbPath || this.dbPath.includes('://')) {
      return;
    }

    const p = this.metadataMutex.then(async () => {
      try {
        const metaPath = join(this.dbPath, 'metadata.json');
        const tmpPath = `${metaPath}.${randomUUID()}.tmp`;
        const metadata: SidecarMetadata = {
          dimensions: this.dimensions.toString(),
          staleCount: this.staleCount.toString(),
          lastCompactedAt: this.lastCompactedAt,
          totalFiles: this.totalFiles.toString(),
        };
        await writeFile(tmpPath, JSON.stringify(metadata, null, 2), 'utf8');
        await rename(tmpPath, metaPath);
      } catch (e) {
        console.error('[LanceVectorStore] Failed to update sidecar metadata:', e);
        throw e;
      }
    });

    this.metadataMutex = p.catch(() => {});
    await p;
  }

  async resetForTest(): Promise<void> {
    if (this.table && this.db) {
      await this.table.delete('true');
      this.staleCount = 0;
      this.totalFiles = 0;
      this.lastCompactedAt = undefined;
      await this.updateMetadata();
    }
  }

  private async runInWriteLock<T>(op: () => Promise<T>): Promise<T> {
    const currentMutex = this.writeMutex;
    const opPromise = this.trackOp(async () => {
      await currentMutex;
      return await op();
    });
    this.writeMutex = opPromise.then(() => {}).catch(() => {});
    return await opPromise;
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
      return this.closePromise ?? Promise.resolve();
    }
    this.isClosed = true;

    this.closePromise = (async () => {
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
        let timerHandle: NodeJS.Timeout | undefined = undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timerHandle = setTimeout(() => { resolve('timeout'); }, effectiveTimeout);
        });
        const result = await Promise.race([inflightDone.then(() => 'done' as const), timeout]);
        if (timerHandle) {
          clearTimeout(timerHandle);
        }
        if (result === 'timeout') {
          console.error(
            `[LanceVectorStore] close() timed out after ${effectiveTimeout}ms ` +
            `with ${this.inflightOps} in-flight operation(s). Forcing resource release.`
          );
        }
      }

      // 3. Release LanceDB resources
      try {
        if (this.table && 'close' in this.table && typeof (this.table as unknown as Record<string, unknown>).close === 'function') {
          await (this.table as unknown as Closable).close();
        }
      } catch (e) {
        console.error('[LanceVectorStore] Error closing table resources:', e);
      } finally {
        this.table = undefined;
      }

      try {
        if (this.db && 'close' in this.db && typeof (this.db as unknown as Record<string, unknown>).close === 'function') {
          await (this.db as unknown as Closable).close();
        }
      } catch (e) {
        console.error('[LanceVectorStore] Error closing DB connection:', e);
      } finally {
        this.db = undefined;
      }
      this.closingResolve = undefined;
    })();

    await this.closePromise;
  }

  async upsertChunks(chunks: CodeChunk[], embeddings?: number[][], affectedFilePaths?: string[]): Promise<void> {
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

    await this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      const db = this.db;
      // affectedFilePaths が渡された場合はそれを使用し、そうでなければ chunks から抽出する
      const uniqueFilePaths = affectedFilePaths ?? [...new Set(chunks.map((c) => c.filePath))];
      let staleAdded = 0;
      let filesAdded = 0;

      // 1. Calculate stats and delete old records in a single batch
      if (this.table && uniqueFilePaths.length > 0) {
        const escapedPaths = uniqueFilePaths.map(fp => `'${this.escapeFilterValue(fp)}'`).join(', ');
        
        // Count existing rows for these files in a single query to avoid loop overhead
        const existingRows = await this.table.query()
          .where(`filepath IN (${escapedPaths})`)
          .select(['filepath'])
          .toArray() as unknown as { filepath: string }[];
        
        staleAdded = existingRows.length;
        const foundPaths = new Set(existingRows.map(r => r.filepath));
        filesAdded = uniqueFilePaths.length - foundPaths.size;

        // Batch delete old records for these files
        await this.table.delete(`filepath IN (${escapedPaths})`);
      } else if (!this.table && uniqueFilePaths.length > 0) {
        filesAdded = uniqueFilePaths.length;
      }

      // 2. Batch process data into the store (Memory efficient)
      if (chunks.length > 0) {
        const BATCH_SIZE = 500;
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const chunkBatch = chunks.slice(i, i + BATCH_SIZE);
          const rows: LanceRow[] = chunkBatch.map((chunk, j) => {
            const globalIdx = i + j;
            const vectorData = embeddings?.at(globalIdx);
            const vector =
              vectorData && vectorData.every(Number.isFinite)
                ? Array.from(vectorData)
                : Array(this.dimensions).fill(0);

            this.validateFilterValue(chunk.filePath, 'filePath');
            this.validateFilterValue(chunk.language, 'language');
            this.validateFilterValue(chunk.symbolKind, 'symbolKind');
            if (chunk.symbolName != null) this.validateFilterValue(chunk.symbolName, 'symbolName');

            return {
              vector,
              id: chunk.id,
              filepath: chunk.filePath,
              content: chunk.content,
              language: chunk.language,
              symbolname: chunk.symbolName ?? '',
              symbolkind: chunk.symbolKind,
              startline: chunk.startLine,
              endline: chunk.endLine,
              hash: chunk.hash,
            };
          });

          if (!this.table) {
            // First ever batch: initialize table with these rows
            this.table = await db.createTable('chunks', rows);
          } else {
            // Subsequent batches: just add to existing table
            await this.table.add(rows);
          }
        }
      }

      if (staleAdded > 0 || chunks.length > 0 || filesAdded > 0) {
        if (staleAdded > 0) {
          this.staleCount += staleAdded;
        }
        if (filesAdded > 0) {
          this.totalFiles += filesAdded;
        }
        await this.updateMetadata();
      }
    });
  }

  async deleteByFilePath(filePath: string): Promise<number> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.table) return 0;
      
      const filter = this.filePathFilter(filePath);
      const count = await this.table.countRows(filter);
      if (count > 0) {
        await this.table.delete(filter);
        this.staleCount += count;
        this.totalFiles--;
        await this.updateMetadata();
      }
      return count;
    });
  }

  async deleteByPathPrefix(pathPrefix: string): Promise<number> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.table) return 0;

      const filter = this.filePathPrefixFilter(pathPrefix);
      const count = await this.table.countRows(filter);
      if (count > 0) {
        const rows = await this.table.query()
          .where(filter)
          .select(['filepath'])
          .toArray() as unknown as { filepath: string }[];
        const affectedFiles = new Set(rows.map(r => r.filepath)).size;
        
        await this.table.delete(filter);
        this.staleCount += count;
        this.totalFiles -= affectedFiles;
        await this.updateMetadata();
      }
      return count;
    });
  }

  async renameFilePath(oldPath: string, newPath: string): Promise<number> {
    this.validateFilterValue(newPath, 'newPath');
    return this.runInWriteLock(async () => {
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
        await this.updateMetadata();
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
      await this.writeMutex;
      if (!this.table) return [];
      
      // 明示的にベクトル列とコサイン類似度を指定し、スコア計算 (1 - distance) との整合性を確保する
      let query = this.table.vectorSearch(queryVector)
        .column('vector')
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
          hash: row.hash,
        },
        score: typeof row._distance === 'number' ? 1 - row._distance : 0,
      }));
    });
  }

  async getStats(): Promise<VectorStoreStats> {
    return this.trackOp(async () => {
      await this.writeMutex;
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
      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatio = totalPossible > 0 ? this.staleCount / totalPossible : 0;

      return {
        totalChunks,
        totalFiles: this.totalFiles,
        dimensions: this.dimensions,
        fragmentationRatio,
        lastCompactedAt: this.lastCompactedAt,
      };
    });
  }

  async compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.runInWriteLock(async () => {
      const threshold = config?.fragmentationThreshold ?? 0.2;
      const minStale = config?.minStaleChunks ?? 1;

      const totalChunks = this.table ? await this.table.countRows() : 0;
      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatioBefore = totalPossible > 0 ? this.staleCount / totalPossible : 0;

      const shouldCompact =
        this.staleCount >= minStale &&
        (threshold === 0 ? this.staleCount > 0 : fragmentationRatioBefore >= threshold);

      const wasStale = this.staleCount > 0;

      if (shouldCompact) {
        if (this.table) {
          await this.table.optimize();
        }
        const removed = this.staleCount;
        this.staleCount = 0;
        this.lastCompactedAt = new Date().toISOString();
        await this.updateMetadata();
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult> {
    return this.runInWriteLock(async () => {
      let didOptimize = false;
      if (this.table) {
        await this.table.optimize();
        didOptimize = true;
      }

      const totalChunks = this.table ? await this.table.countRows() : 0;
      const totalPossible = totalChunks + this.staleCount;
      const fragmentationRatioBefore = totalPossible > 0 ? this.staleCount / totalPossible : 0;

      const wasStale = this.staleCount > 0;
      const removed = this.staleCount;

      if (didOptimize || wasStale) {
        this.staleCount = 0;
        this.lastCompactedAt = new Date().toISOString();
        await this.updateMetadata();
      }

      return {
        compacted: didOptimize || wasStale,
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

          const onAbort = (event: Event) => {
            const signal = event.target as AbortSignal;
            controller.abort(signal.reason);
          };

          if (abortSignal?.aborted) {
            controller.abort(abortSignal.reason);
          } else if (this.abortController.signal.aborted) {
            controller.abort(this.abortController.signal.reason);
          } else {
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.abortController.signal.addEventListener('abort', onAbort, { once: true });
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

  private static readonly ALLOWED_FILTER_VALUE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Zs}\p{S}\p{M}]*$/u;
  // eslint-disable-next-line no-control-regex
  private static readonly FORBIDDEN_CONTROL_CHARS = /[\x00-\x1f\x7f\u2028\u2029]/;

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
