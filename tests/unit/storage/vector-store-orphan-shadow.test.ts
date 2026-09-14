import * as lancedb from '@lancedb/lancedb';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import type {
  FullRebuildRecovery,
  FullRebuildVectorArtifact,
} from '../../../src/storage/interfaces/structured-catalog.js';
import type { CodeChunk } from '../../../src/types/index.js';

const legacyRow = {
  vector: new Array<number>(64).fill(0),
  id: 'legacy-row',
  filepath: 'src/legacy.ts',
  content: 'legacy',
  language: 'typescript',
  symbolname: '',
  symbolkind: 'function' as const,
  startline: 1,
  endline: 1,
  hash: 'legacy-hash',
  generationid: '',
};

const structuredRow = {
  ...legacyRow,
  id: 'structured-row',
  filepath: 'src/structured.ts',
  content: 'structured',
  symbolid: 'structured-symbol',
  generationid: 'generation-1',
  visibility: 'active' as const,
};

const legacyChunk: CodeChunk = {
  id: 'legacy-row',
  filePath: 'src/legacy.ts',
  content: 'legacy',
  language: 'typescript',
  symbolKind: 'function',
  startLine: 1,
  endLine: 1,
  hash: 'legacy-hash',
};

const artifact = (table: FullRebuildVectorArtifact['table'], prefix: string): FullRebuildVectorArtifact => ({
  rebuildEpoch: 1,
  table,
  shadowName: `${prefix}_shadow_protected`,
  replacementName: `${prefix}_replacement_protected`,
  backupName: `${prefix}_backup_protected`,
  hadLiveTable: true,
  backupComplete: true,
});

describe('LanceVectorStore rebuild-table cleanup', () => {
  let dbPath: string | undefined;
  let store: LanceVectorStore | undefined;

  afterEach(async () => {
    await store?.close();
    if (dbPath !== undefined) await rm(dbPath, { recursive: true, force: true });
  });

  it('preserves journal-referenced artifacts while deleting orphaned tables from all prefixes', async () => {
    dbPath = await mkdtemp(join(tmpdir(), 'nexus-vector-orphans-'));
    const db = await lancedb.connect(dbPath);
    await db.createTable('chunks', [legacyRow]);
    await db.createTable('structured_chunks', [structuredRow]);

    const protectedArtifacts = [
      artifact('legacy', 'chunks'),
      artifact('structured', 'structured_chunks'),
    ];
    const orphanNames = [
      'chunks_shadow_orphan',
      'chunks_replacement_orphan',
      'chunks_backup_orphan',
      'structured_chunks_shadow_orphan',
      'structured_chunks_replacement_orphan',
      'structured_chunks_backup_orphan',
    ];
    for (const name of [
      ...protectedArtifacts.flatMap((item) => [
        item.shadowName,
        item.replacementName,
        ...(item.backupName === null ? [] : [item.backupName]),
      ]),
      ...orphanNames,
    ]) {
      await db.createTable(name, name.startsWith('structured_chunks') ? [structuredRow] : [legacyRow]);
    }

    const recovery: FullRebuildRecovery = {
      rebuildEpoch: 1,
      phase: 'building',
      merkleSnapshot: [],
      vectorArtifacts: protectedArtifacts,
    };
    store = new LanceVectorStore({
      dbPath,
      dimensions: 64,
      rebuildJournal: {
        recordFullRebuildVectorArtifact: async () => {},
        markFullRebuildVectorBackupComplete: async () => {},
        getFullRebuildRecovery: async () => recovery,
      },
    });

    await store.initialize();
    const remaining = await db.tableNames();

    expect(remaining).toEqual(expect.arrayContaining([
      'chunks',
      'structured_chunks',
      ...protectedArtifacts.flatMap((item) => [
        item.shadowName,
        item.replacementName,
        ...(item.backupName === null ? [] : [item.backupName]),
      ]),
    ]));
    expect(remaining).not.toEqual(expect.arrayContaining(orphanNames));
  });

  it('resets counters when rollback removes a legacy table that did not exist before the rebuild', async () => {
    dbPath = await mkdtemp(join(tmpdir(), 'nexus-vector-empty-rollback-'));
    store = new LanceVectorStore({ dbPath, dimensions: 64 });
    await store.initialize();
    await store.upsertChunks([legacyChunk], [new Array<number>(64).fill(0)]);

    await store.recoverInterruptedFullRebuild({
      rebuildEpoch: 1,
      phase: 'building',
      merkleSnapshot: [],
      vectorArtifacts: [{
        rebuildEpoch: 1,
        table: 'legacy',
        shadowName: 'chunks_shadow_missing-live',
        replacementName: 'chunks_replacement_missing-live',
        backupName: null,
        hadLiveTable: false,
        backupComplete: true,
      }],
    }, 'rollback');

    await expect(store.getStats()).resolves.toMatchObject({ totalChunks: 0, totalFiles: 0 });
    await expect(readFile(join(dbPath, 'metadata.json'), 'utf8').then((value) => JSON.parse(value))).resolves.toMatchObject({
      staleCount: '0',
      totalFiles: '0',
    });
  });

  it('does not drop a journal-referenced backup while closing after a swap', async () => {
    dbPath = await mkdtemp(join(tmpdir(), 'nexus-vector-close-recovery-'));
    const artifacts = new Map<FullRebuildVectorArtifact['table'], FullRebuildVectorArtifact>();
    const journal = {
      recordFullRebuildVectorArtifact: async (input: FullRebuildVectorArtifact): Promise<void> => {
        artifacts.set(input.table, input);
      },
      markFullRebuildVectorBackupComplete: async (input: Pick<FullRebuildVectorArtifact, 'rebuildEpoch' | 'table'>): Promise<void> => {
        const current = artifacts.get(input.table);
        if (current !== undefined) artifacts.set(input.table, { ...current, backupComplete: true });
      },
      getFullRebuildRecovery: async (): Promise<FullRebuildRecovery> => ({
        rebuildEpoch: 1,
        phase: 'legacy-swapped',
        merkleSnapshot: [],
        vectorArtifacts: [...artifacts.values()],
      }),
    };
    store = new LanceVectorStore({ dbPath, dimensions: 64, rebuildJournal: journal });
    await store.initialize();
    await store.upsertChunks([legacyChunk], [new Array<number>(64).fill(0)]);

    const shadow = await store.beginLegacyShadowTable();
    await store.stageLegacyShadowChunks(shadow, [{
      chunk: { ...legacyChunk, id: 'replacement-row', content: 'replacement' },
      vector: new Array<number>(64).fill(0),
    }]);
    await store.swapLegacyShadowTable(shadow, 1);
    const backupName = artifacts.get('legacy')?.backupName;
    expect(backupName).not.toBeNull();

    await store.close();
    store = undefined;
    const reopenedDb = await lancedb.connect(dbPath);
    expect(await reopenedDb.tableNames()).toContain(backupName);
  });
});
