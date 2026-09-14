import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import type { DeadLetterEntry, EmbeddingCacheEntry, IMetadataStore, IndexStatsRow, MerkleNodeRow } from '../types/index.js';
import { DEFAULT_BATCH_SIZE } from '../config/index.js';
import { executeBatchedWithYield } from './batched-transaction.js';
import type {
  IStructuredCatalog,
  StructuredActivationResult,
  StructuredFileRetirement,
  StructuredGenerationActivation,
  StructuredGenerationStage,
  StructuredFullRebuildActivation,
  StructuredImportRecord,
  StructuredIndexCounts,
  StructuredIndexState,
  StructuredPendingClear,
  StructuredPendingSymbolResolution,
  StructuredReconciliationResult,
  StructuredSymbolResolution,
  StructuredTombstone,
} from './interfaces/structured-catalog.js';
import type { StructuredDeclaration, StructuredGeneration } from '../structured/contracts.js';
import { sha256Hex } from '../structured/hash.js';

export interface SqliteMetadataStoreOptions {
  databasePath: string;
  batchSize?: number;
}

const PRIMARY_STATS_ID = 'primary';

const UPSERT_INDEX_STATS_SQL = `
  INSERT INTO index_stats (
    id, total_files, total_chunks, last_indexed_at, last_full_scan_at, overflow_count, last_error
  ) VALUES (
    @id, @totalFiles, @totalChunks, @lastIndexedAt, @lastFullScanAt, @overflowCount, @lastError
  )
  ON CONFLICT(id) DO UPDATE SET
    total_files = excluded.total_files,
    total_chunks = excluded.total_chunks,
    last_indexed_at = excluded.last_indexed_at,
    last_full_scan_at = excluded.last_full_scan_at,
    overflow_count = excluded.overflow_count,
    last_error = excluded.last_error`;

export class SqliteMetadataStore implements IMetadataStore, IStructuredCatalog {
  private readonly db: Database.Database;

  private readonly batchSize: number;

  private readonly asyncBoundary = async (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private pruneUnreferencedStructuredData(filePath: string): number {
    const referencedGenerations = `
      SELECT active_generation AS generation
      FROM structured_files
      WHERE file_path = ? AND active_generation IS NOT NULL
      UNION
      SELECT pending_generation AS generation
      FROM structured_files
      WHERE file_path = ? AND pending_generation IS NOT NULL`;
    let deleted = 0;
    deleted += this.db.prepare(`DELETE FROM symbol_imports WHERE file_path = ? AND generation NOT IN (${referencedGenerations})`).run(filePath, filePath, filePath).changes;
    deleted += this.db.prepare(`DELETE FROM imports WHERE file_path = ? AND generation NOT IN (${referencedGenerations})`).run(filePath, filePath, filePath).changes;
    deleted += this.db.prepare(`DELETE FROM symbols WHERE file_path = ? AND generation NOT IN (${referencedGenerations})`).run(filePath, filePath, filePath).changes;
    deleted += this.db.prepare(`DELETE FROM symbol_generations WHERE file_path = ? AND generation NOT IN (${referencedGenerations})`).run(filePath, filePath, filePath).changes;
    return deleted;
  }

  private pruneOrphanedStructuredData(): number {
    let deleted = 0;
    deleted += this.db.prepare('DELETE FROM symbol_imports WHERE NOT EXISTS (SELECT 1 FROM structured_files AS f WHERE f.file_path = symbol_imports.file_path AND (f.active_generation = symbol_imports.generation OR f.pending_generation = symbol_imports.generation))').run().changes;
    deleted += this.db.prepare('DELETE FROM imports WHERE NOT EXISTS (SELECT 1 FROM structured_files AS f WHERE f.file_path = imports.file_path AND (f.active_generation = imports.generation OR f.pending_generation = imports.generation))').run().changes;
    deleted += this.db.prepare('DELETE FROM symbols WHERE NOT EXISTS (SELECT 1 FROM structured_files AS f WHERE f.file_path = symbols.file_path AND (f.active_generation = symbols.generation OR f.pending_generation = symbols.generation))').run().changes;
    deleted += this.db.prepare('DELETE FROM symbol_generations WHERE NOT EXISTS (SELECT 1 FROM structured_files AS f WHERE f.file_path = symbol_generations.file_path AND (f.active_generation = symbol_generations.generation OR f.pending_generation = symbol_generations.generation))').run().changes;
    return deleted;
  }

  constructor(options: SqliteMetadataStoreOptions) {
    this.db = new Database(options.databasePath);
    
    if (options.batchSize !== undefined) {
      if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
        throw new TypeError('SqliteMetadataStore batchSize must be a positive integer');
      }
      this.batchSize = options.batchSize;
    } else {
      this.batchSize = DEFAULT_BATCH_SIZE;
    }
  }

  private addMissingColumns(
    tableName: string,
    columns: readonly (readonly [name: string, definition: string])[],
  ): void {
    const existingColumns = new Set(
      (this.db.pragma(`table_info(${tableName})`) as Array<{ name: string }>).map((column) => column.name),
    );
    for (const [name, definition] of columns) {
      if (!existingColumns.has(name)) {
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private migrateSchema(): void {
    this.addMissingColumns('dead_letter_queue', [['recovery_attempts', 'INTEGER NOT NULL DEFAULT 0']]);
    this.addMissingColumns('index_stats', [
      ['last_error', 'TEXT'],
      ['structured_schema_version', 'INTEGER'],
      ['structured_rebuild_state', 'TEXT'],
      ['structured_rebuild_epoch', 'INTEGER NOT NULL DEFAULT 0'],
      ['structured_last_error_code', 'TEXT'],
    ]);
    this.db.prepare('INSERT OR IGNORE INTO index_stats (id,total_files,total_chunks,last_indexed_at,last_full_scan_at,overflow_count,last_error,structured_rebuild_epoch) VALUES (?,?,?,?,?,?,?,?)').run(PRIMARY_STATS_ID, 0, 0, null, null, 0, null, 0);
    this.db.prepare('UPDATE index_stats SET structured_rebuild_epoch = COALESCE(structured_rebuild_epoch, 0) WHERE structured_rebuild_epoch IS NULL').run();
    this.addMissingColumns('imports', [
      ['id', "TEXT NOT NULL DEFAULT ''"],
      ['start_byte', 'INTEGER NOT NULL DEFAULT 0'],
      ['end_byte', 'INTEGER NOT NULL DEFAULT 0'],
      ['source_hash', "TEXT NOT NULL DEFAULT ''"],
      ['is_complete', 'INTEGER NOT NULL DEFAULT 1'],
      ['diagnostics_json', 'TEXT'],
    ]);
    this.migrateImportsPrimaryKey();
    this.addMissingColumns('symbol_imports', [
      ['import_binding_id', "TEXT NOT NULL DEFAULT ''"],
    ]);
    this.migrateSymbolImportsPrimaryKey();
    this.addMissingColumns('symbols', [
      ['start_byte', 'INTEGER NOT NULL DEFAULT 0'],
      ['end_byte', 'INTEGER NOT NULL DEFAULT 0'],
      ['parent_symbol_id', 'TEXT'],
      ['language_id', "TEXT NOT NULL DEFAULT ''"],
      ['is_exact', 'INTEGER NOT NULL DEFAULT 1'],
    ]);
    this.addMissingColumns('symbol_generations', [[
      'file_completeness', "TEXT NOT NULL DEFAULT 'complete' CHECK (file_completeness IN ('complete', 'partial'))",
    ]]);
    this.addMissingColumns('symbol_tombstones', [['retired_at', 'INTEGER NOT NULL DEFAULT 0']]);
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='structured_generations'").get()) {
      this.db.exec('INSERT OR IGNORE INTO symbol_generations (file_path,generation,schema_version,parser_id,parser_version,content_hash,rebuild_epoch) SELECT file_path,generation,schema_version,parser_id,parser_version,content_hash,rebuild_epoch FROM structured_generations');
    }
  }

  private migrateImportsPrimaryKey(): void {
    const info = this.db.pragma('table_info(imports)') as Array<{ name: string; pk: number }>;
    const pkColumns = info.filter((column) => column.pk > 0).map((column) => column.name);
    if (pkColumns.includes('id')) return;

    this.db.exec(`
      CREATE TABLE imports_new (
        file_path TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL,
        source TEXT NOT NULL, imported_names TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL,
        end_line INTEGER NOT NULL, end_column INTEGER NOT NULL,
        start_byte INTEGER NOT NULL DEFAULT 0, end_byte INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 1, diagnostics_json TEXT,
        PRIMARY KEY (file_path, generation, id)
      );
      INSERT OR IGNORE INTO imports_new
        SELECT file_path, generation, source || char(0) || imported_names, source, imported_names,
               start_line, start_column, end_line, end_column, start_byte, end_byte, source_hash, is_complete, diagnostics_json
        FROM imports;
      DROP TABLE imports;
      ALTER TABLE imports_new RENAME TO imports;
      CREATE INDEX imports_file_generation_idx ON imports (file_path, generation);
    `);
  }

  private migrateSymbolImportsPrimaryKey(): void {
    const info = this.db.pragma('table_info(symbol_imports)') as Array<{ name: string; pk: number }>;
    const pkColumns = info.filter((column) => column.pk > 0).map((column) => column.name);
    if (pkColumns.includes('import_binding_id')) return;

    this.db.exec(`
      CREATE TABLE symbol_imports_new (
        file_path TEXT NOT NULL, generation TEXT NOT NULL, symbol_id TEXT NOT NULL,
        import_binding_id TEXT NOT NULL, source TEXT NOT NULL, source_hash TEXT NOT NULL,
        PRIMARY KEY (file_path, generation, symbol_id, import_binding_id)
      );
      INSERT OR IGNORE INTO symbol_imports_new
        SELECT si.file_path, si.generation, si.symbol_id, i.id, si.source, si.source_hash
        FROM symbol_imports AS si
        JOIN imports AS i
          ON i.file_path = si.file_path
         AND i.generation = si.generation
         AND i.source = si.source;
      DROP TABLE symbol_imports;
      ALTER TABLE symbol_imports_new RENAME TO symbol_imports;
    `);
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

      CREATE INDEX IF NOT EXISTS merkle_nodes_parent_path_idx ON merkle_nodes (parent_path);

      CREATE TABLE IF NOT EXISTS index_stats (
        id TEXT PRIMARY KEY,
        total_files INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        last_indexed_at TEXT,
        last_full_scan_at TEXT,
        overflow_count INTEGER NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        error_message TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        recovery_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_retry_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dlq_created ON dead_letter_queue (created_at);

      CREATE TABLE IF NOT EXISTS embedding_cache (
        hash TEXT PRIMARY KEY,
        vector TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS structured_files (
        file_path TEXT PRIMARY KEY,
        active_generation TEXT,
        pending_generation TEXT
      );
      CREATE TABLE IF NOT EXISTS symbol_generations (
        file_path TEXT NOT NULL,
        generation TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        parser_id TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        rebuild_epoch INTEGER NOT NULL,
        file_completeness TEXT NOT NULL DEFAULT 'complete' CHECK (file_completeness IN ('complete', 'partial')),
        PRIMARY KEY (file_path, generation)
      );
      CREATE TABLE IF NOT EXISTS symbols (
        file_path TEXT NOT NULL, generation TEXT NOT NULL, symbol_id TEXT NOT NULL,
        name TEXT NOT NULL, qualified_name TEXT NOT NULL, kind TEXT NOT NULL,
        signature_discriminator TEXT NOT NULL, start_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_line INTEGER NOT NULL, end_column INTEGER NOT NULL,
        start_byte INTEGER NOT NULL DEFAULT 0, end_byte INTEGER NOT NULL DEFAULT 0,
        parent_symbol_id TEXT, language_id TEXT NOT NULL DEFAULT '', is_exact INTEGER NOT NULL DEFAULT 1, source_hash TEXT NOT NULL,
        PRIMARY KEY (file_path, generation, symbol_id)
      );
      CREATE INDEX IF NOT EXISTS symbols_symbol_id_idx ON symbols (symbol_id);
      CREATE TABLE IF NOT EXISTS imports (
        file_path TEXT NOT NULL, generation TEXT NOT NULL, id TEXT NOT NULL,
        source TEXT NOT NULL, imported_names TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL,
        end_line INTEGER NOT NULL, end_column INTEGER NOT NULL,
        start_byte INTEGER NOT NULL DEFAULT 0, end_byte INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 1, diagnostics_json TEXT,
        PRIMARY KEY (file_path, generation, id)
      );
      CREATE INDEX IF NOT EXISTS imports_file_generation_idx ON imports (file_path, generation);
      CREATE TABLE IF NOT EXISTS symbol_imports (
        file_path TEXT NOT NULL, generation TEXT NOT NULL, symbol_id TEXT NOT NULL,
        import_binding_id TEXT NOT NULL, source TEXT NOT NULL, source_hash TEXT NOT NULL,
        PRIMARY KEY (file_path, generation, symbol_id, import_binding_id)
      );
      CREATE TABLE IF NOT EXISTS symbol_tombstones (
        symbol_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, generation TEXT NOT NULL,
        retired_at_rebuild_epoch INTEGER NOT NULL, retired_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS structured_rebuild_backup_files (
        rebuild_epoch INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        active_generation TEXT,
        pending_generation TEXT,
        PRIMARY KEY (rebuild_epoch, file_path)
      );

      CREATE TABLE IF NOT EXISTS structured_rebuild_backup_tombstones (
        rebuild_epoch INTEGER NOT NULL,
        symbol_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        generation TEXT NOT NULL,
        retired_at_rebuild_epoch INTEGER NOT NULL,
        retired_at INTEGER NOT NULL,
        PRIMARY KEY (rebuild_epoch, symbol_id)
      );

      CREATE TABLE IF NOT EXISTS structured_rebuild_backup_runs (
        rebuild_epoch INTEGER PRIMARY KEY
      );
    `);
    this.migrateSchema();
    this.recoverInterruptedFullRebuild();
  }

  async bootstrapStructuredSchema(): Promise<void> {
    await this.initialize();
  }

  async getStructuredIndexState(): Promise<StructuredIndexState> {
    await this.asyncBoundary();
    const rows = this.db.prepare('SELECT file_path, active_generation FROM structured_files WHERE active_generation IS NOT NULL').all() as Array<{ file_path: string; active_generation: string }>;
    const state = this.db.prepare('SELECT structured_schema_version AS schemaVersion, structured_rebuild_state AS rebuildState, structured_rebuild_epoch AS rebuildEpoch, structured_last_error_code AS lastErrorCode FROM index_stats WHERE id = ?').get(PRIMARY_STATS_ID) as { schemaVersion: number | null; rebuildState: string | null; rebuildEpoch: number | null; lastErrorCode: string | null } | undefined;
    return { schemaVersion: state?.schemaVersion ?? null, rebuildState: state?.rebuildState ?? null, rebuildEpoch: state?.rebuildEpoch ?? 0, lastErrorCode: state?.lastErrorCode ?? null, counts: await this.getStructuredCounts(), activeGenerations: new Map(rows.map((row) => [row.file_path, row.active_generation])), reindexRequired: state?.schemaVersion === null || state?.schemaVersion === undefined };
  }

  async stageGeneration(input: StructuredGenerationStage): Promise<void> {
    await this.asyncBoundary();
    const transaction = () => {
      this.db.prepare('INSERT INTO symbol_generations (file_path,generation,schema_version,parser_id,parser_version,content_hash,rebuild_epoch,file_completeness) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(file_path,generation) DO UPDATE SET schema_version=excluded.schema_version, parser_id=excluded.parser_id, parser_version=excluded.parser_version, content_hash=excluded.content_hash, rebuild_epoch=excluded.rebuild_epoch, file_completeness=excluded.file_completeness').run(input.filePath, input.generation.generationId, input.generation.schemaVersion, input.generation.parserId, input.generation.parserVersion, input.generation.fileHash, input.rebuildEpoch, input.fileCompleteness);
      this.db.prepare('DELETE FROM symbols WHERE file_path = ? AND generation = ?').run(input.filePath, input.generation.generationId);
      this.db.prepare('DELETE FROM symbol_imports WHERE file_path = ? AND generation = ?').run(input.filePath, input.generation.generationId);
      this.db.prepare('DELETE FROM imports WHERE file_path = ? AND generation = ?').run(input.filePath, input.generation.generationId);
      const symbol = this.db.prepare('INSERT INTO symbols (file_path,generation,symbol_id,name,qualified_name,kind,signature_discriminator,start_line,start_column,end_line,end_column,start_byte,end_byte,parent_symbol_id,language_id,is_exact,source_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const declaration of input.declarations) symbol.run(input.filePath, input.generation.generationId, declaration.symbolId, declaration.name, declaration.qualifiedName, declaration.kind, declaration.signatureDiscriminator, declaration.position.startLine, declaration.position.startColumn, declaration.position.endLine, declaration.position.endColumn, declaration.startByte, declaration.endByte, declaration.parentSymbolId ?? null, declaration.languageId, declaration.isExact ? 1 : 0, sha256Hex(input.bytes.subarray(declaration.startByte, declaration.endByte)));
      const importRow = this.db.prepare('INSERT INTO imports (file_path,generation,id,source,imported_names,start_line,start_column,end_line,end_column,start_byte,end_byte,source_hash,is_complete,diagnostics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const bindingRow = this.db.prepare('INSERT INTO symbol_imports (file_path,generation,symbol_id,import_binding_id,source,source_hash) VALUES (?,?,?,?,?,?)');
      const importsById = new Map(input.imports.map((imported) => [imported.id, imported]));
      for (const imported of input.imports) importRow.run(input.filePath, input.generation.generationId, imported.id, imported.moduleSpecifier ?? '', imported.bindingName ?? '', imported.position.startLine, imported.position.startColumn, imported.position.endLine, imported.position.endColumn, imported.startByte, imported.endByte, sha256Hex(input.bytes.subarray(imported.startByte, imported.endByte)), imported.completeness === 'complete' ? 1 : 0, JSON.stringify(imported.diagnostics ?? []));
      for (const declaration of input.declarations) {
        const linkedBindingIds = new Set<string>();
        for (const bindingId of declaration.importBindingIds ?? []) {
          const imported = importsById.get(bindingId);
          if (imported === undefined) continue;
          if (linkedBindingIds.has(imported.id)) continue;
          linkedBindingIds.add(imported.id);
          bindingRow.run(input.filePath, input.generation.generationId, declaration.symbolId, imported.id, imported.moduleSpecifier ?? '', sha256Hex(input.bytes.subarray(imported.startByte, imported.endByte)));
        }
      }
      this.db.prepare('INSERT INTO structured_files (file_path,pending_generation) VALUES (?,?) ON CONFLICT(file_path) DO UPDATE SET pending_generation=excluded.pending_generation').run(input.filePath, input.generation.generationId);
      this.db.prepare('UPDATE index_stats SET structured_rebuild_epoch=? WHERE id=?').run(input.rebuildEpoch, PRIMARY_STATS_ID);
      this.pruneUnreferencedStructuredData(input.filePath);
    };
    this.immediateTransaction(transaction);
  }

  async activateGeneration(input: StructuredGenerationActivation): Promise<StructuredActivationResult> {
    await this.asyncBoundary();
    const transaction = (): StructuredActivationResult => {
      const epoch = this.db.prepare('SELECT structured_rebuild_epoch AS value FROM index_stats WHERE id = ?').get(PRIMARY_STATS_ID) as { value: number | null } | undefined;
      if ((epoch?.value ?? 0) !== input.expectedRebuildEpoch) return { activated: false, reason: 'stale_rebuild_epoch' };
      const file = this.db.prepare('SELECT active_generation,pending_generation FROM structured_files WHERE file_path = ?').get(input.filePath) as { active_generation: string | null; pending_generation: string | null } | undefined;
      if ((file?.active_generation ?? null) !== input.expectedActiveGeneration) return { activated: false, reason: 'stale_active_generation' };
      if (file?.pending_generation !== input.generationId) return { activated: false, reason: 'missing_generation' };
      if (file.active_generation) this.db.prepare('INSERT OR REPLACE INTO symbol_tombstones SELECT symbol_id,file_path,generation,?,? FROM symbols WHERE file_path=? AND generation=? AND symbol_id NOT IN (SELECT symbol_id FROM symbols WHERE file_path=? AND generation=?)').run(input.expectedRebuildEpoch, Date.now(), input.filePath, file.active_generation, input.filePath, input.generationId);
      this.db.prepare('DELETE FROM symbol_tombstones WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE file_path=? AND generation=?)').run(input.filePath, input.generationId);
      this.db.prepare('UPDATE structured_files SET active_generation = ?, pending_generation = NULL WHERE file_path = ?').run(input.generationId, input.filePath);
      this.pruneUnreferencedStructuredData(input.filePath);
      return { activated: true };
    };
    return this.immediateTransaction(transaction);
  }

  async clearPendingGeneration(input: StructuredPendingClear): Promise<{ cleared: boolean }> {
    await this.asyncBoundary();
    const transaction = () => {
      const row = this.db.prepare('SELECT active_generation,pending_generation FROM structured_files WHERE file_path=?').get(input.filePath) as { active_generation: string | null; pending_generation: string | null } | undefined;
      const epoch = this.db.prepare('SELECT structured_rebuild_epoch AS value FROM index_stats WHERE id=?').get(PRIMARY_STATS_ID) as { value: number | null } | undefined;
      if (!row || row.active_generation !== input.expectedActiveGeneration || row.pending_generation !== input.expectedPendingGeneration || (epoch?.value ?? 0) !== input.expectedRebuildEpoch) return { cleared: false };
      this.db.prepare('UPDATE structured_files SET pending_generation=NULL WHERE file_path=?').run(input.filePath);
      this.pruneUnreferencedStructuredData(input.filePath);
      return { cleared: true };
    };
    return this.immediateTransaction(transaction);
  }

  async retireFile(input: StructuredFileRetirement): Promise<void> {
    await this.asyncBoundary();
    const transaction = () => {
      const row = this.db.prepare('SELECT active_generation FROM structured_files WHERE file_path=?').get(input.filePath) as { active_generation: string | null } | undefined;
      if (!row || row.active_generation !== input.expectedActiveGeneration) return;
      const epoch = this.db.prepare('SELECT structured_rebuild_epoch AS value FROM index_stats WHERE id=?').get(PRIMARY_STATS_ID) as { value: number | null } | undefined;
      if ((epoch?.value ?? 0) !== input.rebuildEpoch) return;
      this.db.prepare('INSERT OR REPLACE INTO symbol_tombstones SELECT symbol_id,file_path,generation,?,? FROM symbols WHERE file_path=? AND generation=?').run(input.rebuildEpoch, input.tombstoneTimestamp ?? Date.now(), input.filePath, row.active_generation);
      this.db.prepare('UPDATE structured_files SET active_generation=NULL,pending_generation=NULL WHERE file_path=?').run(input.filePath);
      this.pruneUnreferencedStructuredData(input.filePath);
    };
    this.immediateTransaction(transaction);
  }

  async resolveFile(filePath: string) {
    await this.asyncBoundary();
    const row = this.db.prepare('SELECT active_generation,pending_generation FROM structured_files WHERE file_path=?').get(filePath) as { active_generation: string | null; pending_generation: string | null } | undefined;
    if (row?.active_generation) return { kind: 'active' as const, generationId: row.active_generation };
    if (row?.pending_generation) return { kind: 'pending' as const, generationId: row.pending_generation };
    return { kind: 'missing' as const };
  }

  async getActiveGenerationMap(filePaths: readonly string[]) {
    await this.asyncBoundary();
    const result = new Map<string, string>();
    const statement = this.db.prepare('SELECT active_generation FROM structured_files WHERE file_path=?');
    for (const filePath of filePaths) {
      const row = statement.get(filePath) as { active_generation: string | null } | undefined;
      if (row?.active_generation) result.set(filePath, row.active_generation);
    }
    return result;
  }

  private declaration(row: Record<string, unknown>): StructuredDeclaration { return { name: String(row.name), symbolId: String(row.symbol_id), qualifiedName: String(row.qualified_name), kind: row.kind as StructuredDeclaration['kind'], signatureDiscriminator: String(row.signature_discriminator), position: { startLine: Number(row.start_line), startColumn: Number(row.start_column), endLine: Number(row.end_line), endColumn: Number(row.end_column) }, startByte: Number(row.start_byte ?? 0), endByte: Number(row.end_byte ?? 0), sourceHash: String(row.source_hash), languageId: typeof row.language_id === 'string' ? row.language_id : '', isExact: Boolean(row.is_exact ?? 1), parentSymbolId: typeof row.parent_symbol_id === 'string' ? row.parent_symbol_id : undefined }; }

  async resolveSymbol(symbolId: string): Promise<StructuredSymbolResolution> {
    await this.asyncBoundary();
    const row = this.db.prepare('SELECT s.*, f.file_path AS file_path FROM symbols s JOIN structured_files f ON f.file_path=s.file_path AND f.active_generation=s.generation WHERE s.symbol_id=?').get(symbolId) as Record<string, unknown> | undefined;
    if (row) return { kind: 'active', declaration: this.declaration(row), filePath: String(row.file_path) };
    const tombstone = await this.getTombstone(symbolId);
    return tombstone ? { kind: 'tombstone', tombstone } : { kind: 'missing' };
  }

  async getPendingSymbol(symbolId: string): Promise<StructuredPendingSymbolResolution> {
    await this.asyncBoundary();
    const row = this.db.prepare('SELECT s.* FROM symbols s JOIN structured_files f ON f.file_path=s.file_path AND f.pending_generation=s.generation WHERE s.symbol_id=?').get(symbolId) as Record<string, unknown> | undefined;
    return row ? { kind: 'pending', declaration: this.declaration(row) } : { kind: 'missing' };
  }

  async getTombstone(symbolId: string): Promise<StructuredTombstone | null> {
    await this.asyncBoundary();
    const row = this.db.prepare('SELECT symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at FROM symbol_tombstones WHERE symbol_id=?').get(symbolId) as { symbol_id: string; file_path: string; generation: string; retired_at_rebuild_epoch: number; retired_at: number } | undefined;
    return row ? { symbolId: row.symbol_id, filePath: row.file_path, generationId: row.generation, retiredAtRebuildEpoch: row.retired_at_rebuild_epoch, retiredAt: row.retired_at } : null;
  }

  async getStructuredCounts(): Promise<StructuredIndexCounts> {
    await this.asyncBoundary();
    const activeFiles = this.db.prepare('SELECT count(*) AS n FROM structured_files WHERE active_generation IS NOT NULL').get() as { n: number };
    const pendingFiles = this.db.prepare('SELECT count(*) AS n FROM structured_files WHERE pending_generation IS NOT NULL').get() as { n: number };
    const activeSymbols = this.db.prepare('SELECT count(*) AS n FROM symbols s JOIN structured_files f ON f.file_path=s.file_path AND f.active_generation=s.generation').get() as { n: number };
    const pendingSymbols = this.db.prepare('SELECT count(*) AS n FROM symbols s JOIN structured_files f ON f.file_path=s.file_path AND f.pending_generation=s.generation').get() as { n: number };
    const tombstones = this.db.prepare('SELECT count(*) AS n FROM symbol_tombstones').get() as { n: number };
    return { activeFiles: activeFiles.n, activeSymbols: activeSymbols.n, pendingFiles: pendingFiles.n, pendingSymbols: pendingSymbols.n, tombstones: tombstones.n };
  }

  async getImportsForSymbol(symbolId: string): Promise<readonly StructuredImportRecord[]> {
    await this.asyncBoundary();
    const rows = this.db.prepare(`
      SELECT i.id AS bindingId, i.source AS moduleSpecifier, i.imported_names AS bindingName,
             i.start_byte AS startByte, i.end_byte AS endByte,
             i.source_hash AS sourceHash, i.is_complete AS isComplete
      FROM symbol_imports si
      JOIN imports i ON i.file_path = si.file_path AND i.generation = si.generation AND i.id = si.import_binding_id
      JOIN structured_files f ON f.file_path = si.file_path AND f.active_generation = si.generation
      WHERE si.symbol_id = ?
    `).all(symbolId) as Array<{
      bindingId: string;
      moduleSpecifier: string;
      bindingName: string;
      startByte: number;
      endByte: number;
      sourceHash: string;
      isComplete: number;
    }>;
    return rows.map((row) => ({
      id: row.bindingId,
      moduleSpecifier: row.moduleSpecifier || undefined,
      bindingName: row.bindingName || undefined,
      startByte: row.startByte,
      endByte: row.endByte,
      sourceHash: row.sourceHash,
      completeness: row.isComplete === 1 ? 'complete' : 'partial',
    }));
  }

  async getFileDeclarations(filePath: string): Promise<readonly StructuredDeclaration[]> {
    await this.asyncBoundary();
    const rows = this.db.prepare(`
      SELECT s.*, f.file_path AS file_path
      FROM symbols s
      JOIN structured_files f ON f.file_path = s.file_path AND f.active_generation = s.generation
      WHERE s.file_path = ?
      ORDER BY s.start_byte, s.qualified_name
    `).all(filePath) as Array<Record<string, unknown>>;
    return rows.map((row) => this.declaration(row));
  }

  async getGeneration(filePath: string, generationId: string): Promise<StructuredGeneration | null> {
    await this.asyncBoundary();
    const row = this.db.prepare(`
      SELECT file_path, generation, schema_version, parser_id, parser_version, content_hash, file_completeness
      FROM symbol_generations
      WHERE file_path = ? AND generation = ?
    `).get(filePath, generationId) as { file_path: string; generation: string; schema_version: number; parser_id: string; parser_version: string; content_hash: string; file_completeness: string } | undefined;
    if (row === undefined) return null;
    return {
      generationId: row.generation,
      schemaVersion: row.schema_version as 1,
      parserId: row.parser_id,
      parserVersion: row.parser_version,
      fileHash: row.content_hash,
      fileCompleteness: row.file_completeness === 'partial' ? 'partial' : 'complete',
    };
  }

  async prepareFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    await this.asyncBoundary();
    this.immediateTransaction(() => {
      const epoch = this.db.prepare('SELECT structured_rebuild_epoch AS value FROM index_stats WHERE id = ?').get(PRIMARY_STATS_ID) as { value: number | null } | undefined;
      if ((epoch?.value ?? 0) !== input.rebuildEpoch) {
        throw new Error(`SqliteMetadataStore.prepareFullRebuild: stale rebuild epoch ${input.rebuildEpoch}`);
      }

      const paths = new Set<string>();
      for (const file of input.files) {
        if (paths.has(file.filePath)) throw new Error(`SqliteMetadataStore.prepareFullRebuild: duplicate file ${file.filePath}`);
        paths.add(file.filePath);
        const row = this.db.prepare('SELECT active_generation FROM structured_files WHERE file_path = ?').get(file.filePath) as { active_generation: string | null } | undefined;
        if ((row?.active_generation ?? null) !== file.expectedActiveGeneration) {
          throw new Error(`SqliteMetadataStore.prepareFullRebuild: generation validation failed for ${file.filePath}`);
        }
      }
      for (const file of input.retiredFiles) {
        if (paths.has(file.filePath)) throw new Error(`SqliteMetadataStore.prepareFullRebuild: duplicate retired file ${file.filePath}`);
        paths.add(file.filePath);
        const row = this.db.prepare('SELECT active_generation FROM structured_files WHERE file_path = ?').get(file.filePath) as { active_generation: string | null } | undefined;
        if (row?.active_generation !== file.expectedActiveGeneration) {
          throw new Error(`SqliteMetadataStore.prepareFullRebuild: retired generation validation failed for ${file.filePath}`);
        }
      }

      this.db.prepare('DELETE FROM structured_rebuild_backup_runs WHERE rebuild_epoch = ?').run(input.rebuildEpoch);
      this.db.prepare('DELETE FROM structured_rebuild_backup_files WHERE rebuild_epoch = ?').run(input.rebuildEpoch);
      this.db.prepare('DELETE FROM structured_rebuild_backup_tombstones WHERE rebuild_epoch = ?').run(input.rebuildEpoch);
      this.db.prepare(`
        INSERT INTO structured_rebuild_backup_files (rebuild_epoch,file_path,active_generation,pending_generation)
        SELECT ?,file_path,active_generation,pending_generation
        FROM structured_files
      `).run(input.rebuildEpoch);
      this.db.prepare('INSERT INTO structured_rebuild_backup_tombstones (rebuild_epoch,symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at) SELECT ?,symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at FROM symbol_tombstones').run(input.rebuildEpoch);
      this.db.prepare('INSERT INTO structured_rebuild_backup_runs (rebuild_epoch) VALUES (?)').run(input.rebuildEpoch);
    });
  }

  async activateFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    await this.asyncBoundary();
    this.immediateTransaction(() => {
      const epoch = this.db.prepare('SELECT structured_rebuild_epoch AS value FROM index_stats WHERE id = ?').get(PRIMARY_STATS_ID) as { value: number | null } | undefined;
      if ((epoch?.value ?? 0) !== input.rebuildEpoch) {
        throw new Error(`SqliteMetadataStore.activateFullRebuild: stale rebuild epoch ${input.rebuildEpoch}`);
      }

      const paths = new Set<string>();
      for (const file of input.files) {
        if (paths.has(file.filePath)) throw new Error(`SqliteMetadataStore.activateFullRebuild: duplicate file ${file.filePath}`);
        paths.add(file.filePath);
        const row = this.db.prepare('SELECT active_generation,pending_generation FROM structured_files WHERE file_path = ?').get(file.filePath) as { active_generation: string | null; pending_generation: string | null } | undefined;
        if ((row?.active_generation ?? null) !== file.expectedActiveGeneration || row?.pending_generation !== file.generationId) {
          throw new Error(`SqliteMetadataStore.activateFullRebuild: generation validation failed for ${file.filePath}`);
        }
      }
      for (const file of input.retiredFiles) {
        if (paths.has(file.filePath)) throw new Error(`SqliteMetadataStore.activateFullRebuild: duplicate retired file ${file.filePath}`);
        paths.add(file.filePath);
        const row = this.db.prepare('SELECT active_generation FROM structured_files WHERE file_path = ?').get(file.filePath) as { active_generation: string | null } | undefined;
        if (row?.active_generation !== file.expectedActiveGeneration) {
          throw new Error(`SqliteMetadataStore.activateFullRebuild: retired generation validation failed for ${file.filePath}`);
        }
      }

      const pendingSymbols = this.db.prepare('SELECT symbol_id FROM symbols WHERE file_path = ? AND generation = ?');
      const previousSymbols = this.db.prepare('SELECT symbol_id FROM symbols WHERE file_path = ? AND generation = ?');
      const addTombstone = this.db.prepare('INSERT OR REPLACE INTO symbol_tombstones (symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at) VALUES (?,?,?,?,?)');
      const deleteNewTombstone = this.db.prepare('DELETE FROM symbol_tombstones WHERE symbol_id IN (SELECT symbol_id FROM symbols WHERE file_path = ? AND generation = ?)');
      const activate = this.db.prepare('UPDATE structured_files SET active_generation = ?, pending_generation = NULL WHERE file_path = ?');
      for (const file of input.files) {
        if (file.expectedActiveGeneration !== null) {
          const newSymbols = new Set((pendingSymbols.all(file.filePath, file.generationId) as Array<{ symbol_id: string }>).map((row) => row.symbol_id));
          for (const row of previousSymbols.all(file.filePath, file.expectedActiveGeneration) as Array<{ symbol_id: string }>) {
            if (!newSymbols.has(row.symbol_id)) addTombstone.run(row.symbol_id, file.filePath, file.expectedActiveGeneration, input.rebuildEpoch, Date.now());
          }
        }
        deleteNewTombstone.run(file.filePath, file.generationId);
        activate.run(file.generationId, file.filePath);
      }
      for (const file of input.retiredFiles) {
        for (const row of previousSymbols.all(file.filePath, file.expectedActiveGeneration) as Array<{ symbol_id: string }>) {
          addTombstone.run(row.symbol_id, file.filePath, file.expectedActiveGeneration, input.rebuildEpoch, Date.now());
        }
        activate.run(null, file.filePath);
      }
    });
  }

  async rollbackFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    await this.asyncBoundary();
    this.restoreFullRebuild(input.rebuildEpoch);
  }

  async finalizeFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    await this.asyncBoundary();
    this.immediateTransaction(() => {
      this.pruneOrphanedStructuredData();
      this.db.prepare('DELETE FROM structured_rebuild_backup_runs WHERE rebuild_epoch = ?').run(input.rebuildEpoch);
      this.db.prepare('DELETE FROM structured_rebuild_backup_files WHERE rebuild_epoch = ?').run(input.rebuildEpoch);
      this.db.prepare('DELETE FROM structured_rebuild_backup_tombstones WHERE rebuild_epoch = ?').run(input.rebuildEpoch);
    });
  }

  private recoverInterruptedFullRebuild(): void {
    const backup = this.db.prepare(`
      SELECT rebuild_epoch AS rebuildEpoch
      FROM structured_rebuild_backup_runs
      UNION
      SELECT rebuild_epoch AS rebuildEpoch
      FROM structured_rebuild_backup_files
      UNION
      SELECT rebuild_epoch AS rebuildEpoch
      FROM structured_rebuild_backup_tombstones
      ORDER BY rebuildEpoch DESC
      LIMIT 1
    `).get() as { rebuildEpoch: number } | undefined;
    if (backup === undefined) return;

    try {
      this.restoreFullRebuild(backup.rebuildEpoch);
      this.db.prepare('UPDATE index_stats SET structured_rebuild_state=?, structured_last_error_code=? WHERE id=?').run(
        'failed',
        'interrupted full rebuild rolled back during startup recovery',
        PRIMARY_STATS_ID,
      );
    } catch (error) {
      console.error('[Nexus MetadataStore] Failed to recover interrupted full rebuild:', error);
    }
  }

  private restoreFullRebuild(rebuildEpoch: number): void {
    this.immediateTransaction(() => {
      const backupFiles = this.db.prepare(`
        SELECT file_path AS filePath, active_generation AS activeGeneration, pending_generation AS pendingGeneration
        FROM structured_rebuild_backup_files
        WHERE rebuild_epoch = ?
      `).all(rebuildEpoch) as Array<{ filePath: string; activeGeneration: string | null; pendingGeneration: string | null }>;
      const deleteFile = this.db.prepare('DELETE FROM structured_files WHERE file_path = ?');
      const restoreFile = this.db.prepare('INSERT INTO structured_files (file_path,active_generation,pending_generation) VALUES (?,?,?)');
      this.db.prepare('DELETE FROM structured_files WHERE file_path NOT IN (SELECT file_path FROM structured_rebuild_backup_files WHERE rebuild_epoch = ?)').run(rebuildEpoch);
      for (const file of backupFiles) {
        deleteFile.run(file.filePath);
        if (file.activeGeneration !== null || file.pendingGeneration !== null) {
          restoreFile.run(file.filePath, file.activeGeneration, file.pendingGeneration);
        }
      }
      this.db.prepare('DELETE FROM symbol_tombstones').run();
      this.db.prepare(`
        INSERT INTO symbol_tombstones (symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at)
        SELECT symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at
        FROM structured_rebuild_backup_tombstones
        WHERE rebuild_epoch = ?
      `).run(rebuildEpoch);
      this.pruneOrphanedStructuredData();
      this.db.prepare('DELETE FROM structured_files WHERE active_generation IS NULL AND pending_generation IS NULL').run();
      this.db.prepare('DELETE FROM structured_rebuild_backup_runs WHERE rebuild_epoch = ?').run(rebuildEpoch);
      this.db.prepare('DELETE FROM structured_rebuild_backup_files WHERE rebuild_epoch = ?').run(rebuildEpoch);
      this.db.prepare('DELETE FROM structured_rebuild_backup_tombstones WHERE rebuild_epoch = ?').run(rebuildEpoch);
    });
  }

  async reconcileStructuredState(): Promise<StructuredReconciliationResult> {
    await this.asyncBoundary();
    return this.immediateTransaction(() => {
      const orphanedRows = this.pruneOrphanedStructuredData();
      const prunedTombstones = this.db.prepare('DELETE FROM symbol_tombstones WHERE symbol_id IN (SELECT s.symbol_id FROM symbols AS s JOIN structured_files AS f ON f.file_path=s.file_path AND f.active_generation=s.generation)').run().changes;
      const current = this.db.prepare('SELECT structured_schema_version AS schemaVersion, structured_rebuild_state AS rebuildState, structured_last_error_code AS lastErrorCode FROM index_stats WHERE id=?').get(PRIMARY_STATS_ID) as { schemaVersion: number | null; rebuildState: string | null; lastErrorCode: string | null } | undefined;
      const schema = this.db.prepare('SELECT MIN(sg.schema_version) AS minimum, MAX(sg.schema_version) AS maximum, COUNT(*) AS count FROM symbol_generations AS sg JOIN structured_files AS f ON f.file_path=sg.file_path AND f.active_generation=sg.generation').get() as { minimum: number | null; maximum: number | null; count: number };
      const pending = this.db.prepare('SELECT 1 FROM structured_files WHERE pending_generation IS NOT NULL LIMIT 1').get() !== undefined;
      const schemaVersion = schema.count > 0 && schema.minimum === schema.maximum ? schema.minimum : null;
      let rebuildState: string;
      if (pending) {
        rebuildState = 'building';
      } else if (current?.rebuildState === 'building') {
        rebuildState = 'failed';
      } else {
        rebuildState = current?.rebuildState ?? 'idle';
      }
      const stateChanged = current?.schemaVersion !== schemaVersion || current?.rebuildState !== rebuildState;
      this.db.prepare('UPDATE index_stats SET structured_schema_version=?, structured_rebuild_state=?, structured_last_error_code=? WHERE id=?').run(schemaVersion, rebuildState, current?.lastErrorCode ?? null, PRIMARY_STATS_ID);
      return { repaired: orphanedRows > 0 || prunedTombstones > 0 || stateChanged, prunedTombstones };
    });
  }

  async setStructuredRebuildState(input: { rebuildState: string; lastErrorCode?: string | null }): Promise<void> {
    await this.asyncBoundary();
    this.db.prepare('UPDATE index_stats SET structured_rebuild_state=?, structured_last_error_code=? WHERE id=?').run(input.rebuildState, input.lastErrorCode ?? null, PRIMARY_STATS_ID);
  }

  async incrementRebuildEpoch(): Promise<number> {
    await this.asyncBoundary();
    this.db.prepare('UPDATE index_stats SET structured_rebuild_epoch = COALESCE(structured_rebuild_epoch, 0) + 1 WHERE id=?').run(PRIMARY_STATS_ID);
    const row = this.db.prepare('SELECT structured_rebuild_epoch AS epoch FROM index_stats WHERE id=?').get(PRIMARY_STATS_ID) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
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

  async bulkDeleteSubtrees(paths: string[]): Promise<number> {
    const statement = this.db.prepare("DELETE FROM merkle_nodes WHERE path = ? OR path LIKE ? ESCAPE '\\'");

    await this.asyncBoundary();
    const transaction = this.db.transaction((allPaths: string[]) => {
      let totalChanges = 0;
      for (const targetPath of allPaths) {
        const escapedPrefix = targetPath.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const prefix = `${escapedPrefix}/%`;
        const result = statement.run(targetPath, prefix);
        totalChanges += result.changes;
      }
      return totalChanges;
    });

    return transaction(paths);
  }

  async replaceAllMerkleNodes(nodes: MerkleNodeRow[]): Promise<void> {
    await this.asyncBoundary();
    const transaction = this.db.transaction((rows: MerkleNodeRow[]) => {
      this.db.prepare('DELETE FROM merkle_nodes').run();
      const statement = this.db.prepare(`
        INSERT INTO merkle_nodes (path, hash, parent_path, is_directory)
        VALUES (@path, @hash, @parentPath, @isDirectory)
      `);
      for (const node of rows) {
        statement.run({
          path: node.path,
          hash: node.hash,
          parentPath: node.parentPath,
          isDirectory: node.isDirectory ? 1 : 0,
        });
      }
    });
    transaction(nodes);
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

  /**
   * Returns all paths within a subtree, including the root of the subtree.
   */
  async getSubtreePaths(pathPrefix: string): Promise<string[]> {
    await this.asyncBoundary();
    const escapedPrefix = pathPrefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = `${escapedPrefix}/%`;
    const rows = this.db
      .prepare("SELECT path FROM merkle_nodes WHERE path = ? OR path LIKE ? ESCAPE '\\'")
      .all(pathPrefix, prefix) as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  async renamePath(oldPath: string, newPath: string, hash: string): Promise<void> {
    await this.asyncBoundary();
    const parentPath = dirname(newPath);
    const normalizedParentPath = parentPath === '.' || parentPath === '/' || parentPath === '' ? null : parentPath;

    this.db.transaction(() => {
      // Get the existing node to preserve its is_directory type
      const oldNode = this.db
        .prepare('SELECT is_directory FROM merkle_nodes WHERE path = ?')
        .get(oldPath) as { is_directory: number } | undefined;

      const isDirectory = oldNode?.is_directory ?? 0;

      this.db.prepare('DELETE FROM merkle_nodes WHERE path = ?').run(oldPath);
      this.db
        .prepare(
          `
        INSERT INTO merkle_nodes (path, hash, parent_path, is_directory)
        VALUES (@path, @hash, @parentPath, @isDirectory)
        ON CONFLICT(path) DO UPDATE SET
          hash = excluded.hash,
          parent_path = excluded.parent_path,
          is_directory = excluded.is_directory
      `,
        )
        .run({
          path: newPath,
          hash,
          parentPath: normalizedParentPath,
          isDirectory,
        });
    })();
  }

  async pruneEmptyParents(
    path: string,
    pathExists: (targetPath: string) => Promise<boolean>,
  ): Promise<void> {
    let currentPath = dirname(path);
    const stmt = this.db.prepare('DELETE FROM merkle_nodes WHERE path = ?');

    while (currentPath !== '.' && currentPath !== '/' && currentPath !== '') {
      await this.asyncBoundary();
      const hasChildren = await this.hasChildren(currentPath);
      if (!hasChildren) {
        // If the directory still exists on disk, don't prune it from metadata
        if (await pathExists(currentPath)) {
          break;
        }
        stmt.run(currentPath);
        currentPath = dirname(currentPath);
      } else {
        break;
      }
    }
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

  async getChildren(path: string | null): Promise<MerkleNodeRow[]> {
    await this.asyncBoundary();
    const rows = this.db
      .prepare(
        `SELECT path, hash, parent_path AS parentPath, is_directory AS isDirectory
         FROM merkle_nodes
         WHERE parent_path ${path === null ? 'IS NULL' : '= ?'}
         ORDER BY path ASC`,
      )
      .all(path === null ? [] : [path]) as Array<{ path: string; hash: string; parentPath: string | null; isDirectory: number }>;

    return rows.map((row) => ({
      path: row.path,
      hash: row.hash,
      parentPath: row.parentPath,
      isDirectory: row.isDirectory === 1,
    }));
  }

  async hasChildren(path: string | null): Promise<boolean> {
    await this.asyncBoundary();
    const row = this.db
      .prepare(`SELECT 1 FROM merkle_nodes WHERE parent_path ${path === null ? 'IS NULL' : '= ?'} LIMIT 1`)
      .get(path === null ? [] : [path]);
    return row !== undefined;
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
                overflow_count AS overflowCount, last_error AS lastError
         FROM index_stats
         WHERE id = ?`,
      )
      .get(PRIMARY_STATS_ID) as IndexStatsRow | undefined;

    return row ?? null;
  }

  async setIndexStats(stats: IndexStatsRow): Promise<void> {
    await this.asyncBoundary();
    this.db.prepare(UPSERT_INDEX_STATS_SQL).run(stats);
  }

  async atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }> {
    await this.asyncBoundary();

    const runTransaction = this.db.transaction(() => {
      const dlqEntries = this.db
        .prepare(
          `SELECT id,
                  file_path AS filePath,
                  content_hash AS contentHash,
                  error_message AS errorMessage,
                  attempts,
                  recovery_attempts AS recoveryAttempts,
                  created_at AS createdAt,
                  updated_at AS updatedAt,
                  last_retry_at AS lastRetryAt
           FROM dead_letter_queue
           ORDER BY created_at ASC`,
        )
        .all() as DeadLetterEntry[];

      if (dlqEntries.length === 0) {
        this.db.prepare(UPSERT_INDEX_STATS_SQL).run(stats);
      }

      return { dlqEmpty: dlqEntries.length === 0, dlqEntries };
    });

    return runTransaction.immediate();
  }

  async upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO dead_letter_queue (
        id, file_path, content_hash, error_message, attempts, recovery_attempts, created_at, updated_at, last_retry_at
      ) VALUES (
        @id, @filePath, @contentHash, @errorMessage, @attempts, @recoveryAttempts, @createdAt, @updatedAt, @lastRetryAt
      )
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        error_message = excluded.error_message,
        attempts = excluded.attempts,
        recovery_attempts = excluded.recovery_attempts,
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
    await this.asyncBoundary();
    const statement = this.db.prepare('DELETE FROM dead_letter_queue WHERE id = ?');
    const transaction = this.db.transaction((rows: string[]) => {
      for (const id of rows) {
        statement.run(id);
      }
    });
    transaction(ids);
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
                recovery_attempts AS recoveryAttempts,
                created_at AS createdAt,
                updated_at AS updatedAt,
                last_retry_at AS lastRetryAt
         FROM dead_letter_queue
         ORDER BY created_at ASC`,
      )
      .all() as DeadLetterEntry[];
  }

  async getEmbeddings(hashes: string[]): Promise<Map<string, number[]>> {
    await this.asyncBoundary();
    const result = new Map<string, number[]>();
    if (hashes.length === 0) {
      return result;
    }

    const MAX_VARIABLES = 999; // SQLite default limit for older versions
    for (let offset = 0; offset < hashes.length; offset += MAX_VARIABLES) {
      const batch = hashes.slice(offset, offset + MAX_VARIABLES);
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`SELECT hash, vector FROM embedding_cache WHERE hash IN (${placeholders})`)
        .all(...batch) as Array<{ hash: string; vector: string }>;

      for (const row of rows) {
        try {
          result.set(row.hash, JSON.parse(row.vector) as number[]);
        } catch {
          console.warn(`[Nexus MetadataStore] Skipping corrupted embedding cache entry for hash ${row.hash}`);
        }
      }
    }

    return result;
  }
  async pruneEmbeddings(maxAgeDays: number): Promise<number> {
    await this.asyncBoundary();
    // Calculate cutoff date in JavaScript to enable parameterization.
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    const cutoffIso = cutoffDate.toISOString();

    const result = this.db
      .prepare(`DELETE FROM embedding_cache WHERE created_at < ?`)
      .run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  async setEmbeddings(entries: EmbeddingCacheEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.asyncBoundary();

    const statement = this.db.prepare(`
      INSERT INTO embedding_cache (hash, vector, dimensions, created_at)
      VALUES (@hash, @vector, @dimensions, @createdAt)
      ON CONFLICT(hash) DO UPDATE SET
        vector = excluded.vector,
        dimensions = excluded.dimensions
    `);
    const now = new Date().toISOString();
    const transaction = this.db.transaction((rows: EmbeddingCacheEntry[]) => {
      for (const entry of rows) {
        statement.run({
          hash: entry.hash,
          vector: JSON.stringify(entry.vector),
          dimensions: entry.vector.length,
          createdAt: now,
        });
      }
    });
    transaction(entries);
  }

  async deleteEmbeddings(hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.asyncBoundary();

    const statement = this.db.prepare('DELETE FROM embedding_cache WHERE hash = ?');
    const transaction = this.db.transaction((rows: string[]) => {
      for (const hash of rows) {
        statement.run(hash);
      }
    });
    transaction(hashes);
  }

  async clearEmbeddings(): Promise<void> {
    await this.asyncBoundary();
    this.db.exec('DELETE FROM embedding_cache');
  }


  getPragmaValue(name: string): unknown {
    return this.db.pragma(`${name}`, { simple: true });
  }

  async close(): Promise<void> {
    await this.asyncBoundary();
    this.db.close();
  }
}
