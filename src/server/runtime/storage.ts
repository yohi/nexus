import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SqliteMetadataStore } from '../../storage/metadata-store.js';
import { LanceVectorStore } from '../../storage/vector-store.js';
import type { Config } from '../../types/index.js';

export class StorageManager {
  static async ensureDirectories(config: Config): Promise<void> {
    const root = resolve(config.storage.rootDir);
    const meta = dirname(resolve(config.storage.metadataDbPath));
    const vector = resolve(config.storage.vectorDbPath);
    await mkdir(root, { recursive: true });
    await mkdir(meta, { recursive: true });
    if (!config.storage.vectorDbPath.startsWith('memory://')) await mkdir(vector, { recursive: true });
  }

  static async initializeStores(config: Config) {
    if (config.storage.batchSize !== undefined &&
      (!Number.isInteger(config.storage.batchSize) || config.storage.batchSize <= 0)) {
      throw new TypeError('SqliteMetadataStore batchSize must be a positive integer');
    }
    const metadataStore = new SqliteMetadataStore({
      databasePath: config.storage.metadataDbPath, batchSize: config.storage.batchSize,
      deferFullRebuildRecovery: true,
    });
    try {
      const vectorStore = new LanceVectorStore({
        dbPath: config.storage.vectorDbPath, dimensions: config.embedding.dimensions,
        deferRebuildCleanup: true, rebuildJournal: metadataStore,
      });
      return { metadataStore, vectorStore };
    } catch (error) {
      try { await metadataStore.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Store construction and cleanup failed'); }
      throw error;
    }
  }
}
