import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  generationid?: string;
  _distance?: number;
  [key: string]: unknown;
}

interface LanceStructuredRow extends LanceRow {
  symbolid: string | null;
  generationid: string;
  visibility: StructuredRowVisibility;
}

const STRUCTURED_TABLE_NAME = 'structured_chunks';
const STRUCTURED_SHADOW_PREFIX = 'structured_chunks_shadow_';
const LEGACY_SHADOW_PREFIX = 'chunks_shadow_';

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
  private structuredTable: Table | undefined;
  private structuredShadowTable: Table | undefined;
  private structuredShadowName: string | undefined;
  private legacyShadowTable: Table | undefined;
  private legacyShadowName: string | undefined;

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
      let localStructuredTable: Table | undefined;

      try {
        localDb = await lancedb.connect(this.dbPath);
        if (this.isClosed) {
          return;
        }

        const tableNames = await localDb.tableNames();

        // Drop orphaned shadow tables left behind by an interrupted full-rebuild
        // swap. No shadow lifecycle can be in flight while initialize() runs, so
        // any leftover `chunks_shadow_*` / `structured_chunks_shadow_*` table is
        // a stale artifact.
        for (const name of tableNames) {
          if (name.startsWith(LEGACY_SHADOW_PREFIX) || name.startsWith(STRUCTURED_SHADOW_PREFIX)) {
            await localDb.dropTable(name).catch(() => {});
          }
        }

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

        if (tableNames.includes(STRUCTURED_TABLE_NAME)) {
          localStructuredTable = await localDb.openTable(STRUCTURED_TABLE_NAME);
        }

        // All checks passed and not closed - commit to instance fields
        if (!this.isClosed) {
          this.db = localDb;
          this.table = localTable;
          this.structuredTable = localStructuredTable;
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
    if (this.structuredTable && this.db) {
      await this.structuredTable.delete('true');
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
      await this.waitForInflightOperations(timeoutMs);

      // 3. Release LanceDB resources
      await this.releaseLanceResources();
      this.closingResolve = undefined;
    })();

    await this.closePromise;
  }

  private async waitForInflightOperations(timeoutMs?: number): Promise<void> {
    if (this.inflightOps === 0) {
      return;
    }

    const effectiveTimeout = timeoutMs ?? LanceVectorStore.CLOSE_TIMEOUT_MS;
    const inflightDone = new Promise<void>((resolve) => {
      if (this.inflightOps === 0) {
        resolve();
      } else {
        this.closingResolve = resolve;
      }
    });
    let timerHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timerHandle = setTimeout(() => resolve('timeout'), effectiveTimeout);
    });
    const result = await Promise.race([inflightDone.then(() => 'done' as const), timeout]);
    if (timerHandle) {
      clearTimeout(timerHandle);
    }
    if (result === 'timeout') {
      console.error(
        `[LanceVectorStore] close() timed out after ${effectiveTimeout}ms ` +
        `with ${this.inflightOps} in-flight operation(s). Forcing resource release.`,
      );
    }
  }

  private async releaseLanceResources(): Promise<void> {
    await this.closeResource(this.legacyShadowTable, 'legacy shadow table resources');
    this.legacyShadowTable = undefined;
    await this.closeResource(this.structuredShadowTable, 'structured shadow table resources');
    this.structuredShadowTable = undefined;
    await this.closeResource(this.structuredTable, 'structured table resources');
    this.structuredTable = undefined;
    await this.closeResource(this.table, 'table resources');
    this.table = undefined;
    await this.closeResource(this.db, 'DB connection');
    this.db = undefined;
  }

  private async closeResource(resource: unknown, resourceName: string): Promise<void> {
    try {
      if (
        typeof resource === 'object' &&
        resource !== null &&
        'close' in resource &&
        typeof (resource as Record<string, unknown>).close === 'function'
      ) {
        await (resource as Closable).close();
      }
    } catch (error) {
      console.error(`[LanceVectorStore] Error closing ${resourceName}:`, error);
    }
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
              ...(chunk.generationId === undefined ? {} : { generationid: chunk.generationId }),
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

      const sqlFilter = this.buildSqlFilter(filter);
      const legacyResults = await this.searchLegacyResults(queryVector, topK, sqlFilter);
      const structuredResults = await this.searchStructuredResults(queryVector, topK, sqlFilter);
      return this.mergeSearchResults(structuredResults, legacyResults, topK);
    });
  }

  private async searchLegacyResults(
    queryVector: number[],
    topK: number,
    sqlFilter: string | undefined,
  ): Promise<VectorSearchResult[]> {
    if (!this.table) {
      return [];
    }

    let query = this.table.vectorSearch(queryVector)
      .column('vector')
      .distanceType('cosine')
      .limit(topK);
    if (sqlFilter) {
      query = query.where(sqlFilter);
    }

    const rows = await query.toArray() as unknown as LanceRow[];
    return rows.map((row) => this.toSearchResult(row));
  }

  private async searchStructuredResults(
    queryVector: number[],
    topK: number,
    sqlFilter: string | undefined,
  ): Promise<VectorSearchResult[]> {
    if (!this.structuredTable) {
      return [];
    }

    let query = this.structuredTable.vectorSearch(queryVector)
      .column('vector')
      .distanceType('cosine')
      .limit(topK)
      .where("visibility = 'active'");
    if (sqlFilter) {
      query = query.where(`${sqlFilter} AND visibility = 'active'`);
    }

    const rows = await query.toArray() as unknown as LanceStructuredRow[];
    return rows.map((row) => this.toSearchResult(row));
  }

  private toSearchResult(row: LanceRow): VectorSearchResult {
    const structuredRow = row as Partial<LanceStructuredRow>;
    return {
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
        ...(structuredRow.symbolid === undefined ? {} : { symbolId: structuredRow.symbolid ?? undefined }),
      },
      score: typeof row._distance === 'number' ? 1 - row._distance : 0,
      ...(row.generationid === undefined ? {} : { generationId: row.generationid }),
    };
  }

  private mergeSearchResults(
    structuredResults: VectorSearchResult[],
    legacyResults: VectorSearchResult[],
    topK: number,
  ): VectorSearchResult[] {
    const seen = new Set<string>();
    const combined: VectorSearchResult[] = [];
    // Prefer structured active rows over legacy rows for the same chunk id.
    const candidates = [...structuredResults, ...legacyResults]
      .sort((left, right) => right.score - left.score || left.chunk.filePath.localeCompare(right.chunk.filePath));
    for (const candidate of candidates) {
      if (seen.has(candidate.chunk.id)) {
        continue;
      }
      seen.add(candidate.chunk.id);
      combined.push(candidate);
      if (combined.length >= topK) {
        break;
      }
    }
    return combined.slice(0, topK);
  }

  async stageGenerationChunks(batch: GenerationChunkBatch): Promise<void> {
    if (batch.vectors.length !== batch.chunks.length) {
      throw new Error(
        `VectorStore.stageGenerationChunks: vectors length mismatch (expected ${batch.chunks.length}, got ${batch.vectors.length})`
      );
    }
    for (const [i, vector] of batch.vectors.entries()) {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `VectorStore.stageGenerationChunks: vector length mismatch for chunk ${batch.chunks[i]?.id}`
        );
      }
    }

    await this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      const targetTable = this.structuredShadowTable ?? this.structuredTable;
      const rows: LanceStructuredRow[] = batch.chunks.map((chunk, i) => ({
        vector: Array.from(batch.vectors[i]!),
        id: chunk.id,
        filepath: chunk.filePath,
        content: chunk.content,
        language: chunk.language,
        symbolname: chunk.symbolName ?? '',
        symbolkind: chunk.symbolKind,
        startline: chunk.startLine,
        endline: chunk.endLine,
        hash: chunk.hash,
        symbolid: chunk.symbolId ?? null,
        generationid: batch.generationId,
        visibility: 'pending',
      }));

      if (targetTable) {
        await targetTable.add(rows);
      } else {
        this.structuredTable = await this.db.createTable(STRUCTURED_TABLE_NAME, rows);
      }
    });
  }

  async activateGenerationRows(filePath: string, generationId: string): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.structuredTable) return;
      const filter = `filepath = '${this.escapeFilterValue(filePath)}' AND generationid = '${this.escapeFilterValue(generationId)}' AND visibility = 'pending'`;
      await this.structuredTable.update({
        where: filter,
        values: { visibility: 'active' },
      });
    });
  }

  async removeGenerationRows(filePath: string, generationId: string): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.structuredTable) return;
      const filter = `filepath = '${this.escapeFilterValue(filePath)}' AND generationid = '${this.escapeFilterValue(generationId)}'`;
      await this.structuredTable.delete(filter);
    });
  }

  async beginStructuredShadowTable(): Promise<StructuredShadowTable> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      this.structuredShadowName = `${STRUCTURED_SHADOW_PREFIX}${randomUUID().replaceAll('-', '_')}`;
      const sample: LanceStructuredRow[] = [{
        vector: new Array<number>(this.dimensions).fill(0),
        id: 'placeholder',
        filepath: 'placeholder',
        content: '',
        language: 'typescript',
        symbolname: '',
        symbolkind: 'function',
        startline: 0,
        endline: 0,
        hash: 'placeholder',
        symbolid: 'placeholder',
        generationid: 'placeholder',
        visibility: 'pending',
      }];
      this.structuredShadowTable = await this.db.createTable(this.structuredShadowName, sample);
      await this.structuredShadowTable.delete("filepath = 'placeholder'");
      return { name: this.structuredShadowName };
    });
  }

  async swapStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.structuredShadowTable || this.structuredShadowName !== shadowTable.name) {
        throw new Error('VectorStore.swapStructuredShadowTable: unknown shadow table');
      }

      const newTable = this.structuredShadowTable;
      const oldTable = this.structuredTable;
      const oldShadowName = this.structuredShadowName;

      this.structuredTable = newTable;
      this.structuredShadowTable = undefined;
      this.structuredShadowName = undefined;

      try {
        if (oldTable) {
          const oldName = oldTable.name;
          await oldTable.delete('true');
          await this.db.dropTable(oldName).catch(() => {});
        }
      } catch (e) {
        console.error('[LanceVectorStore] Error dropping old structured table during swap:', e);
      }

      const batchSize = 500;
      let offset = 0;
      let liveTable: Table | undefined;
      while (true) {
        const rowsRaw = await newTable.query().limit(batchSize).offset(offset).toArray() as unknown as LanceStructuredRow[];
        if (rowsRaw.length === 0) {
          break;
        }

        const rows: LanceStructuredRow[] = rowsRaw.map((row) => ({
          ...row,
          vector: Array.from(row.vector),
          visibility: 'active',
        }));
        if (liveTable === undefined) {
          liveTable = await this.db.createTable(STRUCTURED_TABLE_NAME, rows);
        } else {
          await liveTable.add(rows);
        }

        offset += rows.length;
        if (rows.length < batchSize) {
          break;
        }
      }
      await this.db.dropTable(oldShadowName).catch(() => {});
      this.structuredTable = liveTable;
    });
  }

  async abortStructuredShadowTable(shadowTable: StructuredShadowTable): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        return;
      }
      if (this.structuredShadowTable && this.structuredShadowName === shadowTable.name) {
        const name = this.structuredShadowName;
        this.structuredShadowTable = undefined;
        this.structuredShadowName = undefined;
        await this.db.dropTable(name).catch(() => {});
      }
    });
  }

  async beginLegacyShadowTable(): Promise<LegacyShadowTable> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      this.legacyShadowName = `${LEGACY_SHADOW_PREFIX}${randomUUID().replaceAll('-', '_')}`;
      const sample: LanceRow[] = [{
        vector: new Array<number>(this.dimensions).fill(0),
        id: 'placeholder',
        filepath: 'placeholder',
        content: '',
        language: 'typescript',
        symbolname: '',
        symbolkind: 'function',
        startline: 0,
        endline: 0,
        hash: 'placeholder',
      }];
      this.legacyShadowTable = await this.db.createTable(this.legacyShadowName, sample);
      await this.legacyShadowTable.delete("filepath = 'placeholder'");

      // Preserve existing live rows so the swap keeps files outside the rebuild input.
      if (this.table) {
        const batchSize = 500;
        let offset = 0;
        while (true) {
          const rowsRaw = await this.table.query().limit(batchSize).offset(offset).toArray() as unknown as LanceRow[];
          if (rowsRaw.length === 0) {
            break;
          }
          const rows: LanceRow[] = rowsRaw.map((row) => ({ ...row, vector: Array.from(row.vector) }));
          await this.legacyShadowTable.add(rows);
          offset += rows.length;
          if (rows.length < batchSize) {
            break;
          }
        }
      }
      return { name: this.legacyShadowName };
    });
  }

  async stageLegacyShadowChunks(shadow: LegacyShadowTable, chunks: ChunkWithEmbedding[]): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.legacyShadowTable || this.legacyShadowName !== shadow.name) {
        throw new Error('VectorStore.stageLegacyShadowChunks: unknown shadow table');
      }
      for (const item of chunks) {
        if (item.vector.length !== this.dimensions) {
          throw new Error(
            `VectorStore.stageLegacyShadowChunks: vector length mismatch for chunk ${item.chunk.id}`
          );
        }
      }
      const shadowTable = this.legacyShadowTable;

      // Upsert semantics: drop existing rows for the affected files before adding.
      const uniqueFilePaths = [...new Set(chunks.map((item) => item.chunk.filePath))];
      if (uniqueFilePaths.length > 0) {
        const escapedPaths = uniqueFilePaths.map((fp) => `'${this.escapeFilterValue(fp)}'`).join(', ');
        await shadowTable.delete(`filepath IN (${escapedPaths})`);
      }

      const BATCH_SIZE = 500;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const rows: LanceRow[] = batch.map(({ chunk, vector }) => ({
          vector: Array.from(vector),
          id: chunk.id,
          filepath: chunk.filePath,
          content: chunk.content,
          language: chunk.language,
          symbolname: chunk.symbolName ?? '',
          symbolkind: chunk.symbolKind,
          startline: chunk.startLine,
          endline: chunk.endLine,
          hash: chunk.hash,
          ...(chunk.generationId === undefined ? {} : { generationid: chunk.generationId }),
        }));
        await shadowTable.add(rows);
      }
    });
  }

  async stageLegacyShadowDeletions(
    shadow: LegacyShadowTable,
    deletions: LegacyShadowDeletion,
  ): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.legacyShadowTable || this.legacyShadowName !== shadow.name) {
        throw new Error('VectorStore.stageLegacyShadowDeletions: unknown shadow table');
      }
      const shadowTable = this.legacyShadowTable;
      for (const filePath of deletions.filePaths ?? []) {
        await shadowTable.delete(this.filePathFilter(filePath));
      }
      for (const pathPrefix of deletions.pathPrefixes ?? []) {
        await shadowTable.delete(this.filePathPrefixFilter(pathPrefix));
      }
    });
  }

  async swapLegacyShadowTable(shadow: LegacyShadowTable): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        throw new Error('VectorStore not initialized');
      }
      if (!this.legacyShadowTable || this.legacyShadowName !== shadow.name) {
        throw new Error('VectorStore.swapLegacyShadowTable: unknown shadow table');
      }

      const shadowTable = this.legacyShadowTable;
      const oldShadowName = this.legacyShadowName;

      // Materialize the new live table from the shadow before dropping the shadow.
      // This is not atomic: the first `createTable(..., { mode: 'overwrite' })`
      // batch already replaces the previous `chunks` table, so a failure from
      // that point on leaves the live table partially rebuilt (only the batches
      // written so far) even though the shadow still holds the full new
      // contents. LanceDB has no atomic rename. The shadow fields stay set
      // until the swap succeeds so `abortLegacyShadowTable` can drop the
      // shadow after a failure; a crash leaves an orphaned `chunks_shadow_*`
      // table that `initialize()` removes on the next start.
      const batchSize = 500;
      let offset = 0;
      let liveTable: Table | undefined;
      while (true) {
        const rowsRaw = await shadowTable.query().limit(batchSize).offset(offset).toArray() as unknown as LanceRow[];
        if (rowsRaw.length === 0) {
          break;
        }
        const rows: LanceRow[] = rowsRaw.map((row) => ({ ...row, vector: Array.from(row.vector) }));
        if (liveTable === undefined) {
          liveTable = await this.db.createTable('chunks', rows, { mode: 'overwrite' });
        } else {
          await liveTable.add(rows);
        }
        offset += rows.length;
        if (rows.length < batchSize) {
          break;
        }
      }
      if (liveTable === undefined) {
        // The rebuild emptied every legacy row: keep an empty, schema-correct
        // `chunks` table instead of leaving the store without a live table.
        liveTable = await this.db.createEmptyTable('chunks', await shadowTable.schema(), { mode: 'overwrite' });
      }

      await this.db.dropTable(oldShadowName).catch(() => {});
      this.table = liveTable;
      this.legacyShadowTable = undefined;
      this.legacyShadowName = undefined;

      // Reconcile store counters with the swapped table contents.
      this.staleCount = 0;
      const filePathRows = await liveTable.query().select(['filepath']).toArray() as unknown as { filepath: string }[];
      this.totalFiles = new Set(filePathRows.map((row) => row.filepath)).size;
      await this.updateMetadata();
    });
  }

  async abortLegacyShadowTable(shadow: LegacyShadowTable): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.db) {
        return;
      }
      if (this.legacyShadowTable && this.legacyShadowName === shadow.name) {
        const name = this.legacyShadowName;
        this.legacyShadowTable = undefined;
        this.legacyShadowName = undefined;
        await this.db.dropTable(name).catch(() => {});
      }
    });
  }

  async reconcileStructuredRows(activeGenerations: readonly ActiveGeneration[]): Promise<void> {
    return this.runInWriteLock(async () => {
      if (!this.structuredTable) return;
      if (activeGenerations.length === 0) {
        await this.structuredTable.delete('true');
        return;
      }

      const conditions = activeGenerations.map(
        (ag) => `(filepath = '${this.escapeFilterValue(ag.filePath)}' AND generationid = '${this.escapeFilterValue(ag.generationId)}')`,
      );
      const keepFilter = conditions.join(' OR ');
      await this.structuredTable.delete(`NOT (${keepFilter})`);
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

  private buildSqlFilter(filter?: VectorFilter): string | undefined {
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
    return sqlFilters.length > 0 ? sqlFilters.join(' AND ') : undefined;
  }
}
