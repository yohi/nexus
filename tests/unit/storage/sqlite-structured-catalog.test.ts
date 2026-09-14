import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';
import type { StructuredGenerationStage } from '../../../src/storage/interfaces/structured-catalog.js';

const generation = (id: string, fileCompleteness: 'complete' | 'partial' = 'complete') => ({ generationId: id, schemaVersion: 1 as const, parserId: 'test', parserVersion: '1', fileHash: `hash-${id}`, fileCompleteness });
const stage = (filePath: string, id: string, symbolId: string): StructuredGenerationStage => ({
  filePath, generation: generation(id), rebuildEpoch: 1, bytes: new TextEncoder().encode('not persisted'), fileHash: `hash-${id}`, fileCompleteness: 'complete',
  declarations: [{ name: symbolId, symbolId, qualifiedName: symbolId, kind: 'function', signatureDiscriminator: 'sig', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, startByte: 0, endByte: 3, sourceHash: '', languageId: 'typescript', isExact: true }],
  imports: [],
});

const readRows = <T>(databasePath: string, sql: string): T[] => {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare(sql).all() as T[];
  } finally {
    database.close();
  }
};
describe('SQLite structured catalog', () => {
  let dir: string;
  let store: SqliteMetadataStore;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-')); store = new SqliteMetadataStore({ databasePath: path.join(dir, 'metadata.db') }); });
  afterEach(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  it('bootstraps empty structured tables without migrating an existing search index', async () => {
    await store.initialize();
    expect((await store.getStructuredIndexState()).rebuildEpoch).toBe(0);
    expect(await store.getIndexStats()).toMatchObject({ id: 'primary' });
  });

  it('activates a staged generation and records disappeared symbols as tombstones atomically', async () => {
    await store.initialize();
    await store.stageGeneration(stage('src/a.ts', 'g1', 'old'));
    expect((await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 1 })).activated).toBe(true);
    await store.stageGeneration(stage('src/a.ts', 'g2', 'new'));
    expect((await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g2', expectedActiveGeneration: 'g1', expectedRebuildEpoch: 1 })).activated).toBe(true);
    expect(await store.getTombstone('old')).toMatchObject({ symbolId: 'old' });
    expect((await store.resolveSymbol('new')).kind).toBe('active');
  });

  it('restores the previous generations after a full rebuild rollback', async () => {
    await store.initialize();
    await store.incrementRebuildEpoch();
    await store.stageGeneration(stage('src/a.ts', 'g1', 'old'));
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 1 });

    const rebuildEpoch = await store.incrementRebuildEpoch();
    const activation = {
      rebuildEpoch,
      files: [{ filePath: 'src/a.ts', generationId: 'g2', expectedActiveGeneration: 'g1' }],
      retiredFiles: [],
    } as const;
    await store.prepareFullRebuild(activation);
    await store.stageGeneration({ ...stage('src/a.ts', 'g2', 'new'), rebuildEpoch });
    await store.activateFullRebuild(activation);
    await store.rollbackFullRebuild(activation);

    expect(await store.resolveFile('src/a.ts')).toEqual({ kind: 'active', generationId: 'g1' });
    expect(await store.getGeneration('src/a.ts', 'g2')).toBeNull();
    expect((await store.resolveSymbol('old')).kind).toBe('active');
    expect((await store.resolveSymbol('new')).kind).toBe('missing');
  });

  it('recovers an interrupted full rebuild during startup', async () => {
    const databasePath = path.join(dir, 'metadata.db');
    await store.initialize();
    await store.incrementRebuildEpoch();
    await store.stageGeneration(stage('src/a.ts', 'g1', 'old'));
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 1 });

    const rebuildEpoch = await store.incrementRebuildEpoch();
    const activation = {
      rebuildEpoch,
      files: [{ filePath: 'src/a.ts', generationId: 'g2', expectedActiveGeneration: 'g1' }],
      retiredFiles: [],
    } as const;
    await store.setStructuredRebuildState({ rebuildState: 'building' });
    await store.prepareFullRebuild(activation);
    await store.stageGeneration({ ...stage('src/a.ts', 'g2', 'new'), rebuildEpoch });
    await store.close();

    store = new SqliteMetadataStore({ databasePath });
    await store.initialize();

    expect(await store.resolveFile('src/a.ts')).toEqual({ kind: 'active', generationId: 'g1' });
    expect(await store.getGeneration('src/a.ts', 'g2')).toBeNull();
    expect(await store.getStructuredIndexState()).toMatchObject({
      rebuildState: 'failed',
      lastErrorCode: 'interrupted full rebuild rolled back during startup recovery',
    });
  });

  it('does not clear pending generation after a compare-and-swap conflict', async () => {
    await store.initialize(); await store.stageGeneration(stage('src/a.ts', 'g1', 'one'));
    const result = await store.clearPendingGeneration({ filePath: 'src/a.ts', expectedActiveGeneration: 'wrong', expectedPendingGeneration: 'g1', expectedRebuildEpoch: 1 });
    expect(result).toEqual({ cleared: false });
    expect((await store.resolveFile('src/a.ts')).kind).toBe('pending');
  });

  it('restages the same generation idempotently', async () => {
    await store.initialize();
    const first = { ...stage('src/a.ts', 'g1', 'one'), imports: [{ id: 'import-1', moduleSpecifier: 'pkg', startByte: 0, endByte: 3, sourceHash: '', completeness: 'complete' as const, position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }}] };
    const second = { ...first, declarations: [{ name: 'two', symbolId: 'two', qualifiedName: 'two', kind: 'function' as const, signatureDiscriminator: 'sig', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, startByte: 0, endByte: 3, sourceHash: '', languageId: 'typescript', isExact: true }] };
    await store.stageGeneration(first);
    await expect(store.stageGeneration(second)).resolves.toBeUndefined();
    expect((await store.getPendingSymbol('one')).kind).toBe('missing');
    expect((await store.getPendingSymbol('two')).kind).toBe('pending');
  });
  it('uses the same activation reason precedence as the in-memory catalog', async () => {
    await store.initialize();
    await store.stageGeneration({ ...stage('src/a.ts', 'g1', 'one'), rebuildEpoch: 0 });

    expect(await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'missing', expectedActiveGeneration: 'wrong', expectedRebuildEpoch: 1 })).toEqual({ activated: false, reason: 'stale_rebuild_epoch' });
    expect(await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: 'wrong', expectedRebuildEpoch: 0 })).toEqual({ activated: false, reason: 'stale_active_generation' });
    expect(await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'missing', expectedActiveGeneration: null, expectedRebuildEpoch: 0 })).toEqual({ activated: false, reason: 'missing_generation' });
  });

  it('refreshes all mutable generation metadata when restaging an existing generation', async () => {
    await store.initialize();
    const first = { ...stage('src/a.ts', 'g1', 'one'), generation: { ...generation('g1'), parserId: 'parser-a', parserVersion: '1', fileHash: 'hash-a' }, rebuildEpoch: 1, fileHash: 'hash-a' };
    const second = { ...first, generation: { ...first.generation, parserId: 'parser-b', parserVersion: '2', fileHash: 'hash-b' }, rebuildEpoch: 2, fileHash: 'hash-b' };
    await store.stageGeneration(first);
    await store.stageGeneration(second);

    const rows = readRows<{ parser_id: string; parser_version: string; content_hash: string; rebuild_epoch: number }>(path.join(dir, 'metadata.db'), "SELECT parser_id, parser_version, content_hash, rebuild_epoch FROM symbol_generations WHERE file_path='src/a.ts' AND generation='g1'");
    expect(rows).toEqual([{ parser_id: 'parser-b', parser_version: '2', content_hash: 'hash-b', rebuild_epoch: 2 }]);
  });

  it('round-trips partial file completeness for a generation', async () => {
    await store.initialize();
    const input = {
      ...stage('src/a.ts', 'g1', 'one'),
      generation: generation('g1', 'partial'),
      fileCompleteness: 'partial' as const,
    };

    await store.stageGeneration(input);

    await expect(store.getGeneration('src/a.ts', 'g1')).resolves.toMatchObject({ fileCompleteness: 'partial' });
  });

  it('does not retire an active file when the rebuild epoch is stale', async () => {
    await store.initialize();
    await store.stageGeneration({ ...stage('src/a.ts', 'g1', 'one'), rebuildEpoch: 4 });
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 4 });

    await store.retireFile({ filePath: 'src/a.ts', expectedActiveGeneration: 'g1', rebuildEpoch: 3 });

    expect(await store.resolveFile('src/a.ts')).toEqual({ kind: 'active', generationId: 'g1' });
    expect(await store.getTombstone('one')).toBeNull();
  });

  it('prunes generation payloads after pending replacement and activation', async () => {
    await store.initialize();
    await store.stageGeneration({ ...stage('src/a.ts', 'g1', 'one'), rebuildEpoch: 1 });
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 1 });
    await store.stageGeneration({ ...stage('src/a.ts', 'g2', 'two'), rebuildEpoch: 1 });
    await store.stageGeneration({ ...stage('src/a.ts', 'g3', 'three'), rebuildEpoch: 1 });
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g3', expectedActiveGeneration: 'g1', expectedRebuildEpoch: 1 });

    expect(readRows<{ generation: string }>(path.join(dir, 'metadata.db'), "SELECT generation FROM symbol_generations WHERE file_path='src/a.ts' ORDER BY generation")).toEqual([{ generation: 'g3' }]);
    expect(readRows<{ generation: string }>(path.join(dir, 'metadata.db'), "SELECT generation FROM symbols WHERE file_path='src/a.ts' ORDER BY generation")).toEqual([{ generation: 'g3' }]);
  });

  it('prunes a pending generation when compare-and-swap cleanup succeeds', async () => {
    await store.initialize();
    await store.stageGeneration({ ...stage('src/a.ts', 'g1', 'one'), rebuildEpoch: 1 });

    expect(await store.clearPendingGeneration({ filePath: 'src/a.ts', expectedActiveGeneration: null, expectedPendingGeneration: 'g1', expectedRebuildEpoch: 1 })).toEqual({ cleared: true });
    expect(readRows<{ generation: string }>(path.join(dir, 'metadata.db'), "SELECT generation FROM symbol_generations WHERE file_path='src/a.ts'")).toEqual([]);
  });

  it('creates symbol import rows keyed by declaration symbols', async () => {
    await store.initialize();
    const databasePath = path.join(dir, 'metadata.db');
    const bindingId = 'binding-1';
    const declaration = (symbolId: string) => ({ name: symbolId, symbolId, qualifiedName: symbolId, kind: 'function' as const, signatureDiscriminator: 'sig', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, startByte: 0, endByte: 3, sourceHash: '', languageId: 'typescript', isExact: true, importBindingIds: [bindingId] });
    const input = { ...stage('src/a.ts', 'g1', 'unused'), declarations: [declaration('symbol-a'), declaration('symbol-b')], imports: [{ id: bindingId, moduleSpecifier: 'pkg', startByte: 0, endByte: 3, sourceHash: '', completeness: 'complete' as const, position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }}] };
    await store.stageGeneration(input);

    const rows = readRows<{ symbol_id: string; source: string }>(databasePath, "SELECT symbol_id, source FROM symbol_imports WHERE file_path='src/a.ts' AND generation='g1' ORDER BY symbol_id");
    expect(rows).toEqual([{ symbol_id: 'symbol-a', source: 'pkg' }, { symbol_id: 'symbol-b', source: 'pkg' }]);
  });

  it('retrieves byte ranges for imports linked to an active symbol', async () => {
    await store.initialize();
    const bindingId = 'binding-1';
    const input = {
      ...stage('src/a.ts', 'g1', 'symbol-a'),
      declarations: [{ name: 'symbol-a', symbolId: 'symbol-a', qualifiedName: 'symbol-a', kind: 'function' as const, signatureDiscriminator: 'sig', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, startByte: 0, endByte: 3, sourceHash: '', languageId: 'typescript', isExact: true, importBindingIds: [bindingId] }],
      imports: [{ id: bindingId, moduleSpecifier: 'pkg', bindingName: 'name', startByte: 0, endByte: 3, sourceHash: '', completeness: 'complete' as const, position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } }],
    };
    await store.stageGeneration(input);
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 1 });

    await expect(store.getImportsForSymbol('symbol-a')).resolves.toEqual([
      expect.objectContaining({ id: bindingId, moduleSpecifier: 'pkg', bindingName: 'name', startByte: 0, endByte: 3, completeness: 'complete' }),
    ]);
  });

  it('creates lookup indexes for structured symbol and import queries', async () => {
    await store.initialize();
    const databasePath = path.join(dir, 'metadata.db');
    const symbolIndexes = readRows<{ name: string }>(databasePath, "PRAGMA index_list('symbols')");
    const importIndexes = readRows<{ name: string }>(databasePath, "PRAGMA index_list('imports')");

    expect(symbolIndexes.map((index) => index.name)).toContain('symbols_symbol_id_idx');
    expect(importIndexes.map((index) => index.name)).toContain('imports_file_generation_idx');
  });

  it('migrates legacy source-keyed import links to stable import IDs', async () => {
    const databasePath = path.join(dir, 'metadata.db');
    await store.close();

    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TABLE structured_files (
          file_path TEXT PRIMARY KEY, active_generation TEXT, pending_generation TEXT
        );
        CREATE TABLE imports (
          file_path TEXT NOT NULL, generation TEXT NOT NULL, source TEXT NOT NULL,
          imported_names TEXT NOT NULL, start_line INTEGER NOT NULL, start_column INTEGER NOT NULL,
          end_line INTEGER NOT NULL, end_column INTEGER NOT NULL,
          start_byte INTEGER NOT NULL DEFAULT 0, end_byte INTEGER NOT NULL DEFAULT 0,
          source_hash TEXT NOT NULL, is_complete INTEGER NOT NULL DEFAULT 1, diagnostics_json TEXT
        );
        CREATE TABLE symbol_imports (
          file_path TEXT NOT NULL, generation TEXT NOT NULL, symbol_id TEXT NOT NULL,
          source TEXT NOT NULL, source_hash TEXT NOT NULL,
          PRIMARY KEY (file_path, generation, symbol_id, source)
        );
      `);
      database.prepare('INSERT INTO structured_files (file_path,active_generation) VALUES (?,?)').run('src/a.ts', 'g1');
      const importRow = database.prepare('INSERT INTO imports (file_path,generation,source,imported_names,start_line,start_column,end_line,end_column,start_byte,end_byte,source_hash,is_complete,diagnostics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      importRow.run('src/a.ts', 'g1', 'pkg', 'alpha', 1, 0, 1, 1, 0, 1, 'hash-alpha', 1, '[]');
      importRow.run('src/a.ts', 'g1', 'pkg', 'beta', 2, 0, 2, 1, 2, 3, 'hash-beta', 1, '[]');
      database.prepare('INSERT INTO symbol_imports (file_path,generation,symbol_id,source,source_hash) VALUES (?,?,?,?,?)').run('src/a.ts', 'g1', 'symbol-a', 'pkg', 'legacy-hash');
    } finally {
      database.close();
    }

    store = new SqliteMetadataStore({ databasePath });
    await store.initialize();

    await expect(store.getImportsForSymbol('symbol-a')).resolves.toEqual([
      expect.objectContaining({ id: 'pkg\u0000alpha', bindingName: 'alpha', startByte: 0, endByte: 1 }),
      expect.objectContaining({ id: 'pkg\u0000beta', bindingName: 'beta', startByte: 2, endByte: 3 }),
    ]);
  });

  it('reconciles orphaned generation data and stale active tombstones', async () => {
    await store.initialize();
    await store.stageGeneration({ ...stage('src/a.ts', 'g1', 'live'), rebuildEpoch: 2 });
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 2 });

    const databasePath = path.join(dir, 'metadata.db');
    const database = new Database(databasePath);
    try {
      database.prepare('INSERT INTO symbol_generations (file_path,generation,schema_version,parser_id,parser_version,content_hash,rebuild_epoch) VALUES (?,?,?,?,?,?,?)').run('src/a.ts', 'orphan', 1, 'test', '1', 'orphan-hash', 2);
      database.prepare('INSERT INTO symbols (file_path,generation,symbol_id,name,qualified_name,kind,signature_discriminator,start_line,start_column,end_line,end_column,start_byte,end_byte,parent_symbol_id,language_id,is_exact,source_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('src/a.ts', 'orphan', 'orphan-symbol', 'orphan', 'orphan', 'function', 'sig', 1, 0, 1, 1, 0, 3, null, 'typescript', 1, '');
      database.prepare('INSERT INTO imports (file_path,generation,id,source,imported_names,start_line,start_column,end_line,end_column,source_hash,is_complete,diagnostics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('src/a.ts', 'orphan', 'pkg\u0000name', 'pkg', 'name', 1, 0, 1, 1, '', 1, '[]');
      database.prepare('INSERT INTO symbol_imports (file_path,generation,symbol_id,import_binding_id,source,source_hash) VALUES (?,?,?,?,?,?)').run('src/a.ts', 'orphan', 'orphan-symbol', 'pkg\u0000name', 'pkg', '');
      database.prepare('INSERT INTO symbol_tombstones (symbol_id,file_path,generation,retired_at_rebuild_epoch,retired_at) VALUES (?,?,?,?,?)').run('live', 'src/a.ts', 'old', 1, 0);
      database.prepare('UPDATE index_stats SET structured_last_error_code=? WHERE id=?').run('parse_error', 'primary');
    } finally {
      database.close();
    }

    expect(await store.reconcileStructuredState()).toEqual({ repaired: true, prunedTombstones: 1 });
    expect(readRows<{ generation: string }>(databasePath, "SELECT generation FROM symbol_generations WHERE file_path='src/a.ts' ORDER BY generation")).toEqual([{ generation: 'g1' }]);
    expect(await store.getTombstone('live')).toBeNull();
    expect(await store.getStructuredIndexState()).toMatchObject({ schemaVersion: 1, rebuildState: 'idle', lastErrorCode: 'parse_error' });
  });

  it('persists building state while a pending generation remains', async () => {
    await store.initialize();
    await store.stageGeneration({ ...stage('src/a.ts', 'g1', 'one'), rebuildEpoch: 3 });
    await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 3 });
    await store.stageGeneration({ ...stage('src/a.ts', 'g2', 'two'), rebuildEpoch: 3 });

    await store.reconcileStructuredState();

    expect(await store.getStructuredIndexState()).toMatchObject({ schemaVersion: 1, rebuildState: 'building', rebuildEpoch: 3 });
  });
});
