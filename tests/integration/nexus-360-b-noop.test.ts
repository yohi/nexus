import Database from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { DirectoryScanner } from '../../src/server/runtime/directory-scan.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import { LanceVectorStore } from '../../src/storage/vector-store.js';
import { ProjectWriteCoordinator } from '../../src/indexer/project-write-coordinator.js';
import { StructuredIndexCoordinator } from '../../src/indexer/structured-index-coordinator.js';
import type { EmbeddingConfig } from '../../src/types/index.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';

const embeddingConfig: EmbeddingConfig = {
  provider: 'test', model: 'nexus-360-test-model', dimensions: 64,
  maxConcurrency: 1, batchSize: 16, retryCount: 0, retryBaseDelayMs: 0,
};

function sqliteLogicalSnapshot(databasePath: string): string {
  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return JSON.stringify(tables.map(({ name }) => {
      const rows = database.prepare(`SELECT * FROM "${name}"`).all() as unknown[];
      return [name, rows.map((row) => JSON.stringify(row)).sort()];
    }));
  } finally {
    database.close();
  }
}

async function lanceVersions(databasePath: string): Promise<Readonly<Record<string, number>>> {
  const database = await lancedb.connect(databasePath);
  const versions: Record<string, number> = {};
  try {
    for (const name of await database.tableNames()) {
      const table = await database.openTable(name);
      try {
        versions[name] = await table.version();
      } finally {
        table.close();
      }
    }
    return versions;
  } finally {
    database.close();
  }
}

describe('Nexus #360 same-generation no-op', () => {
  let root: string | undefined;
  let metadata: SqliteMetadataStore | undefined;
  let vectors: LanceVectorStore | undefined;
  let pipeline: IndexPipeline | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await vectors?.close();
    await metadata?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('leaves SQLite and both Lance table versions unchanged on a repeated full scan', async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-360-noop-'));
    const projectRoot = join(root, 'project');
    const databasePath = join(root, 'metadata.db');
    const vectorPath = join(root, 'vectors');
    const filePath = 'src/repeat.ts';
    let writerLeaseHeld = true;
    let shouldBlockNextRead = false;
    let signalRead = (): void => {};
    let releaseRead = (): void => {};
    const readEntered = new Promise<void>((resolve) => { signalRead = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, filePath), 'export const repeated = 42;\n');

    metadata = new SqliteMetadataStore({ databasePath });
    vectors = new LanceVectorStore({ dbPath: vectorPath, dimensions: 64 });
    await metadata.initialize();
    await vectors.initialize();
    await metadata.bootstrapStructuredSchema();
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const chunker = new Chunker(registry);
    const coordinator = new StructuredIndexCoordinator({
      metadataStore: metadata, vectorStore: vectors, chunker,
      projectWriteCoordinator: new ProjectWriteCoordinator(),
      config: { embedding: { dimensions: 64 } },
    });
    pipeline = new IndexPipeline({
      metadataStore: metadata, vectorStore: vectors, chunker, pluginRegistry: registry,
      embeddingProvider: new TestEmbeddingProvider(), embeddingConfig,
      structuredIndexCoordinator: coordinator,
      assertWriterLease: () => {
        if (!writerLeaseHeld) throw new Error('test writer lease lost');
      },
      isWriterLeaseHeld: () => writerLeaseHeld,
      loadFileBytes: async (path) => {
        const bytes = await readFile(join(projectRoot, path));
        if (shouldBlockNextRead) {
          shouldBlockNextRead = false;
          signalRead();
          await readGate;
        }
        return bytes;
      },
    });
    const runFullScan = async () => await DirectoryScanner.scan(projectRoot, projectRoot, []);
    const loadContent = async (path: string) => await readFile(join(projectRoot, path), 'utf8');

    const seeded = await pipeline.reindex(runFullScan, loadContent, true);
    expect('status' in seeded).toBe(false);
    const sqliteBefore = sqliteLogicalSnapshot(databasePath);
    const lanceBefore = await lanceVersions(vectorPath);
    const rowsBefore = [];
    for await (const row of vectors.iteratePhysicalRows({ pageSize: 17, signal: new AbortController().signal })) {
      rowsBefore.push(row);
    }
    const activeBefore = await metadata.resolveFile(filePath);
    if (activeBefore.kind !== 'active') throw new Error('active generation required');

    const repeated = await pipeline.reindex(runFullScan, loadContent, true);

    expect('status' in repeated).toBe(false);
    expect(sqliteLogicalSnapshot(databasePath)).toBe(sqliteBefore);
    expect(await lanceVersions(vectorPath)).toEqual(lanceBefore);
    const rowsAfter = [];
    for await (const row of vectors.iteratePhysicalRows({ pageSize: 17, signal: new AbortController().signal })) {
      rowsAfter.push(row);
    }
    expect(rowsAfter).toEqual(rowsBefore);
    const repeatedAgain = await pipeline.reindex(runFullScan, loadContent, true);
    expect('status' in repeatedAgain).toBe(false);
    expect(sqliteLogicalSnapshot(databasePath)).toBe(sqliteBefore);
    expect(await lanceVersions(vectorPath)).toEqual(lanceBefore);

    writerLeaseHeld = false;
    const leaseLost = await pipeline.reindex(runFullScan, loadContent, true);
    expect(leaseLost).toMatchObject({ status: 'integrity_unknown' });
    expect(sqliteLogicalSnapshot(databasePath)).toBe(sqliteBefore);
    expect(await lanceVersions(vectorPath)).toEqual(lanceBefore);
    writerLeaseHeld = true;

    await writeFile(join(projectRoot, filePath), 'export const repeated = 43;\n');
    const generationChanged = await pipeline.reindex(runFullScan, loadContent, true);
    expect('status' in generationChanged).toBe(false);
    const activeAfter = await metadata.resolveFile(filePath);
    expect(activeAfter).toMatchObject({ kind: 'active' });
    if (activeAfter.kind === 'active') expect(activeAfter.generationId).not.toBe(activeBefore.generationId);

    shouldBlockNextRead = true;
    const concurrentFullScan = pipeline.reindex(runFullScan, loadContent, true);
    await readEntered;
    await writeFile(join(projectRoot, filePath), 'export const repeated = 43;\n');
    const concurrentUpdate = pipeline.processEvents([
      { type: 'modified', filePath, detectedAt: new Date().toISOString() },
    ], loadContent);
    releaseRead();
    await expect(concurrentFullScan).resolves.toMatchObject({ status: 'integrity_unknown' });
    await concurrentUpdate;

    await writeFile(join(projectRoot, filePath), 'export const repeated = 44;\n');
    const setRebuildState = metadata.setStructuredRebuildState.bind(metadata);
    vi.spyOn(metadata, 'setStructuredRebuildState').mockImplementation(async (input) => {
      await setRebuildState(input);
      if (input.rebuildState === 'legacy-swapped') writerLeaseHeld = false;
    });
    await expect(pipeline.reindex(runFullScan, loadContent, true)).rejects.toThrow('test writer lease lost');
    expect(await metadata.getFullRebuildRecovery()).not.toBeNull();
    expect((await metadata.getIndexStats())?.lastError).toBeNull();
  });

  it('requests rebuild before writing and recovers confirmed missing physical rows outside the first run', async () => {
    root = await mkdtemp(join(tmpdir(), 'nexus-360-corruption-'));
    const projectRoot = join(root, 'project');
    const databasePath = join(root, 'metadata.db');
    const vectorPath = join(root, 'vectors');
    const filePath = 'src/recover.ts';
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, filePath), 'export const recover = 42;\n');

    metadata = new SqliteMetadataStore({ databasePath });
    vectors = new LanceVectorStore({ dbPath: vectorPath, dimensions: 64 });
    await metadata.initialize();
    await vectors.initialize();
    await metadata.bootstrapStructuredSchema();
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const chunker = new Chunker(registry);
    const coordinator = new StructuredIndexCoordinator({
      metadataStore: metadata, vectorStore: vectors, chunker,
      projectWriteCoordinator: new ProjectWriteCoordinator(),
      config: { embedding: { dimensions: 64 } },
    });
    const progressStates: boolean[] = [];
    pipeline = new IndexPipeline({
      metadataStore: metadata, vectorStore: vectors, chunker, pluginRegistry: registry,
      embeddingProvider: new TestEmbeddingProvider(), embeddingConfig,
      structuredIndexCoordinator: coordinator,
      metricsHooks: {
        onIndexingProgress: (_processed, _total, active) => progressStates.push(active),
        onChunksIndexed: () => {},
        onReindexComplete: () => {},
        onDlqSnapshot: () => {},
        onRecoverySweepComplete: () => {},
      },
      loadFileBytes: async (path) => await readFile(join(projectRoot, path)),
    });
    const runFullScan = async () => await DirectoryScanner.scan(projectRoot, projectRoot, []);
    const loadContent = async (path: string) => await readFile(join(projectRoot, path), 'utf8');
    const seeded = await pipeline.reindex(runFullScan, loadContent, true);
    expect('status' in seeded).toBe(false);

    await metadata.bulkUpsertMerkleNodes([
      { path: 'orphan', hash: 'orphan-hash', parentPath: null, isDirectory: true },
      { path: 'orphan/nested', hash: 'nested-hash', parentPath: 'orphan', isDirectory: true },
    ]);
    const orphanedDirectory = await pipeline.reindex(runFullScan, loadContent, true);
    expect(orphanedDirectory).toMatchObject({ status: 'rebuild_required' });
    if (!('status' in orphanedDirectory) || orphanedDirectory.status !== 'rebuild_required') {
      throw new Error('integrity recovery request required for orphaned directory');
    }
    const recoveredOrphan = await pipeline.reindex(
      runFullScan, loadContent, true, 'integrity-recovery', orphanedDirectory.request,
    );
    expect('status' in recoveredOrphan).toBe(false);

    const beforeDamage = sqliteLogicalSnapshot(databasePath);
    const legacy = [];
    for await (const row of vectors.iteratePhysicalRows({ pageSize: 17, signal: new AbortController().signal })) {
      if (row.view === 'legacy') legacy.push(row);
    }
    const missingRow = legacy[0];
    if (missingRow === undefined) throw new Error('legacy row required');
    const writer = await lancedb.connect(vectorPath);
    const table = await writer.openTable('chunks');
    try {
      await table.delete(`id = '${missingRow.id.replaceAll("'", "''")}'`);
    } finally {
      table.close();
      writer.close();
    }
    const damagedVersions = await lanceVersions(vectorPath);
    const requested = await pipeline.reindex(runFullScan, loadContent, true);

    expect(requested).toMatchObject({ status: 'rebuild_required' });
    expect(sqliteLogicalSnapshot(databasePath)).toBe(beforeDamage);
    expect(await lanceVersions(vectorPath)).toEqual(damagedVersions);
    if (!('status' in requested) || requested.status !== 'rebuild_required') {
      throw new Error('integrity recovery request required');
    }

    const progressCountBeforeIncomplete = progressStates.length;
    const incomplete = await pipeline.reindex(
      async () => [{ type: 'modified', filePath, detectedAt: new Date().toISOString() }],
      loadContent, true, 'integrity-recovery', requested.request,
    );
    expect(incomplete).toMatchObject({ status: 'integrity_unknown', reason: 'recovery_scan_input_incomplete' });
    expect(progressStates.slice(progressCountBeforeIncomplete)).toContain(false);
    await expect(metadata.getMerkleNode('orphan')).resolves.toBeNull();
    await expect(metadata.getMerkleNode('orphan/nested')).resolves.toBeNull();
    expect(sqliteLogicalSnapshot(databasePath)).toBe(beforeDamage);
    expect(await lanceVersions(vectorPath)).toEqual(damagedVersions);

    const recovered = await pipeline.reindex(runFullScan, loadContent, true, 'integrity-recovery', requested.request);
    expect('status' in recovered).toBe(false);
    const restoredRows = [];
    for await (const row of vectors.iteratePhysicalRows({ pageSize: 17, signal: new AbortController().signal })) {
      restoredRows.push(row);
    }
    expect(restoredRows).toEqual(expect.arrayContaining(legacy));

    const legacyRow = legacy[0];
    if (legacyRow === undefined) throw new Error('legacy row required');
    const stateBeforeVectorMismatch = sqliteLogicalSnapshot(databasePath);
    const vectorWriter = await lancedb.connect(vectorPath);
    const legacyTable = await vectorWriter.openTable('chunks');
    try {
      await legacyTable.update({
        where: `id = '${legacyRow.id.replaceAll("'", "''")}'`,
        values: { vector: new Array<number>(64).fill(1) },
      });
    } finally {
      legacyTable.close();
      vectorWriter.close();
    }
    const vectorMismatch = await pipeline.reindex(runFullScan, loadContent, true);
    expect(vectorMismatch).toMatchObject({ status: 'rebuild_required' });
    expect(sqliteLogicalSnapshot(databasePath)).toBe(stateBeforeVectorMismatch);
    if (!('status' in vectorMismatch) || vectorMismatch.status !== 'rebuild_required') {
      throw new Error('vector integrity recovery request required');
    }
    const vectorRecovered = await pipeline.reindex(
      runFullScan, loadContent, true, 'integrity-recovery', vectorMismatch.request,
    );
    expect('status' in vectorRecovered).toBe(false);

    const pendingChunk = {
      id: 'pending-duplicate', filePath, content: 'pending duplicate', language: 'typescript',
      symbolKind: 'function' as const, startLine: 1, endLine: 1, hash: 'pending-chunk-hash',
      symbolId: 'pending-symbol',
    };
    await vectors.stageGenerationChunks({
      filePath, generationId: 'pending-generation',
      chunks: [pendingChunk, pendingChunk], vectors: [new Array<number>(64).fill(0.5), new Array<number>(64).fill(0.5)],
    });
    const pendingCorruption = await pipeline.reindex(runFullScan, loadContent, true);
    expect(pendingCorruption).toMatchObject({ status: 'rebuild_required' });
    if (!('status' in pendingCorruption) || pendingCorruption.status !== 'rebuild_required') {
      throw new Error('pending row recovery request required');
    }
    const pendingRecovered = await pipeline.reindex(
      runFullScan, loadContent, true, 'integrity-recovery', pendingCorruption.request,
    );
    expect('status' in pendingRecovered).toBe(false);
    const finalRows = [];
    for await (const row of vectors.iteratePhysicalRows({ pageSize: 32, signal: new AbortController().signal })) {
      finalRows.push(row);
    }
    expect(finalRows.some((row) => row.view === 'structured' && row.visibility === 'pending')).toBe(false);
    expect(finalRows.some((row) => row.id === pendingChunk.id)).toBe(false);

    await metadata.clearEmbeddings();
    pipeline = new IndexPipeline({
      metadataStore: metadata, vectorStore: vectors, chunker, pluginRegistry: registry,
      embeddingProvider: new TestEmbeddingProvider(), embeddingConfig,
      structuredIndexCoordinator: coordinator,
      loadFileBytes: async (path) => await readFile(join(projectRoot, path)),
    });
    const stateBeforeUnknown = sqliteLogicalSnapshot(databasePath);
    const versionsBeforeUnknown = await lanceVersions(vectorPath);
    const unknown = await pipeline.reindex(runFullScan, loadContent, true, 'startup-reconciliation');
    expect(unknown).toMatchObject({ status: 'integrity_unknown' });
    expect(sqliteLogicalSnapshot(databasePath)).toBe(stateBeforeUnknown);
    expect(await lanceVersions(vectorPath)).toEqual(versionsBeforeUnknown);
  });
});
