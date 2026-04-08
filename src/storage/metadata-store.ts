import Database from 'better-sqlite3';

import type { DeadLetterEntry, IMetadataStore, IndexStatsRow, MerkleNodeRow } from '../types/index.js';
import { executeBatchedWithYield } from './batched-transaction.js';

export interface SqliteMetadataStoreOptions {
  databasePath: string;
  batchSize?: number;
}

const PRIMARY_STATS_ID = 'primary';

export class SqliteMetadataStore implements IMetadataStore {
  private readonly db: Database.Database;

  private readonly batchSize: number;

  private readonly asyncBoundary = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  constructor(options: SqliteMetadataStoreOptions) {
    this.db = new Database(options.databasePath);
    this.batchSize = options.batchSize ?? 100;
  }

  async initialize(): Promise<void> {
    await this.asyncBoundary();
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('wal_autocheckpoint = 1000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merkle_nodes (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        parent_path TEXT,
        is_directory INTEGER NOT NULL CHECK (is_directory IN (0, 1))
      );

      CREATE TABLE IF NOT EXISTS index_stats (
        id TEXT PRIMARY KEY,
        total_files INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        last_indexed_at TEXT,
        last_full_scan_at TEXT,
        overflow_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        error_message TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_retry_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dlq_created ON dead_letter_queue (created_at);
    `);
  }

  async bulkUpsertMerkleNodes(nodes: MerkleNodeRow[]): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO merkle_nodes (path, hash, parent_path, is_directory)
      VALUES (@path, @hash, @parentPath, @isDirectory)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        parent_path = excluded.parent_path,
        is_directory = excluded.is_directory
    `);

    await executeBatchedWithYield({
      items: nodes,
      batchSize: this.batchSize,
      executeBatch: async (batch) => {
        await this.asyncBoundary();
        const transaction = this.db.transaction((rows: MerkleNodeRow[]) => {
          for (const node of rows) {
            statement.run({
              path: node.path,
              hash: node.hash,
              parentPath: node.parentPath,
              isDirectory: node.isDirectory ? 1 : 0,
            });
          }
        });

        transaction(batch);
      },
      yieldAfterBatch: this.asyncBoundary,
    });
  }

  async bulkDeleteMerkleNodes(paths: string[]): Promise<void> {
    const statement = this.db.prepare('DELETE FROM merkle_nodes WHERE path = ?');

    await executeBatchedWithYield({
      items: paths,
      batchSize: this.batchSize,
      executeBatch: async (batch) => {
        await this.asyncBoundary();
        const transaction = this.db.transaction((rows: string[]) => {
          for (const targetPath of rows) {
            statement.run(targetPath);
          }
        });

        transaction(batch);
      },
      yieldAfterBatch: this.asyncBoundary,
    });
  }

  async deleteSubtree(pathPrefix: string): Promise<number> {
    await this.asyncBoundary();
    const escapedPrefix = pathPrefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = `${escapedPrefix}/%`;
    const result = this.db
      .prepare("DELETE FROM merkle_nodes WHERE path = ? OR path LIKE ? ESCAPE '\\'")
      .run(pathPrefix, prefix);

    return result.changes;
  }

  async getMerkleNode(path: string): Promise<MerkleNodeRow | null> {
    await this.asyncBoundary();
    const row = this.db
      .prepare(
        'SELECT path, hash, parent_path AS parentPath, is_directory AS isDirectory FROM merkle_nodes WHERE path = ?',
      )
      .get(path) as
      | { path: string; hash: string; parentPath: string | null; isDirectory: number }
      | undefined;

    if (row === undefined) {
      return null;
    }

    return {
      path: row.path,
      hash: row.hash,
      parentPath: row.parentPath,
      isDirectory: row.isDirectory === 1,
    };
  }

  async getAllNodes(): Promise<MerkleNodeRow[]> {
    await this.asyncBoundary();
    const rows = this.db
      .prepare(
        `SELECT path, hash, parent_path AS parentPath, is_directory AS isDirectory
         FROM merkle_nodes
         ORDER BY path ASC`,
      )
      .all() as Array<{ path: string; hash: string; parentPath: string | null; isDirectory: number }>;

    return rows.map((row) => ({
      path: row.path,
      hash: row.hash,
      parentPath: row.parentPath,
      isDirectory: row.isDirectory === 1,
    }));
  }

  async getAllFileNodes(): Promise<MerkleNodeRow[]> {
    await this.asyncBoundary();
    const rows = this.db
      .prepare(
        `SELECT path, hash, parent_path AS parentPath, is_directory AS isDirectory
         FROM merkle_nodes
         WHERE is_directory = 0
         ORDER BY path ASC`,
      )
      .all() as Array<{ path: string; hash: string; parentPath: string | null; isDirectory: number }>;

    return rows.map((row) => ({
      path: row.path,
      hash: row.hash,
      parentPath: row.parentPath,
      isDirectory: row.isDirectory === 1,
    }));
  }

  async getAllPaths(): Promise<string[]> {
    await this.asyncBoundary();
    const rows = this.db.prepare('SELECT path FROM merkle_nodes ORDER BY path ASC').all() as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  async getIndexStats(): Promise<IndexStatsRow | null> {
    await this.asyncBoundary();
    const row = this.db
      .prepare(
        `SELECT id, total_files AS totalFiles, total_chunks AS totalChunks,
                last_indexed_at AS lastIndexedAt, last_full_scan_at AS lastFullScanAt,
                overflow_count AS overflowCount
         FROM index_stats
         WHERE id = ?`,
      )
      .get(PRIMARY_STATS_ID) as IndexStatsRow | undefined;

    return row ?? null;
  }

  async setIndexStats(stats: IndexStatsRow): Promise<void> {
    await this.asyncBoundary();
    this.db
      .prepare(
        `INSERT INTO index_stats (
            id, total_files, total_chunks, last_indexed_at, last_full_scan_at, overflow_count
          ) VALUES (
            @id, @totalFiles, @totalChunks, @lastIndexedAt, @lastFullScanAt, @overflowCount
          )
          ON CONFLICT(id) DO UPDATE SET
            total_files = excluded.total_files,
            total_chunks = excluded.total_chunks,
            last_indexed_at = excluded.last_indexed_at,
            last_full_scan_at = excluded.last_full_scan_at,
            overflow_count = excluded.overflow_count`,
      )
      .run(stats);
  }

  async upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO dead_letter_queue (
        id, file_path, content_hash, error_message, attempts, created_at, updated_at, last_retry_at
      ) VALUES (
        @id, @filePath, @contentHash, @errorMessage, @attempts, @createdAt, @updatedAt, @lastRetryAt
      )
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        error_message = excluded.error_message,
        attempts = excluded.attempts,
        updated_at = excluded.updated_at,
        last_retry_at = excluded.last_retry_at
    `);

    await executeBatchedWithYield({
      items: entries,
      batchSize: this.batchSize,
      executeBatch: async (batch) => {
        await this.asyncBoundary();
        const transaction = this.db.transaction((rows: DeadLetterEntry[]) => {
          for (const entry of rows) {
            statement.run(entry);
          }
        });

        transaction(batch);
      },
      yieldAfterBatch: this.asyncBoundary,
    });
  }

  async removeDeadLetterEntries(ids: string[]): Promise<void> {
    const statement = this.db.prepare('DELETE FROM dead_letter_queue WHERE id = ?');

    await executeBatchedWithYield({
      items: ids,
      batchSize: this.batchSize,
      executeBatch: async (batch) => {
        await this.asyncBoundary();
        const transaction = this.db.transaction((rows: string[]) => {
          for (const id of rows) {
            statement.run(id);
          }
        });

        transaction(batch);
      },
      yieldAfterBatch: this.asyncBoundary,
    });
  }

  async getDeadLetterEntries(): Promise<DeadLetterEntry[]> {
    await this.asyncBoundary();
    return this.db
      .prepare(
        `SELECT id,
                file_path AS filePath,
                content_hash AS contentHash,
                error_message AS errorMessage,
                attempts,
                created_at AS createdAt,
                updated_at AS updatedAt,
                last_retry_at AS lastRetryAt
         FROM dead_letter_queue
         ORDER BY created_at ASC`,
      )
      .all() as DeadLetterEntry[];
  }

  getPragmaValue(name: string): unknown {
    return this.db.pragma(`${name}`, { simple: true });
  }

  async close(): Promise<void> {
    await this.asyncBoundary();
    this.db.close();
  }
}
