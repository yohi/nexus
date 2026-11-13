import * as lancedb from '@lancedb/lancedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LanceVectorStore } from '../../src/storage/vector-store.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import type { StructuredFullRebuildActivation } from '../../src/storage/interfaces/structured-catalog.js';

const V = new Array<number>(64).fill(0);
const activation: StructuredFullRebuildActivation = { rebuildEpoch: 1, files: [], retiredFiles: [] };

/** Fault injection is confined to mkdtemp storage, never the user's real index. */
describe('Nexus #360 B recovery safety (temporary storage)', () => {
  let dir: string;
  let vectorDir: string;
  let metadata: SqliteMetadataStore;
  let vectors: LanceVectorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexus-360-recovery-'));
    vectorDir = join(dir, 'vectors');
    metadata = new SqliteMetadataStore({ databasePath: join(dir, 'metadata.db'), deferFullRebuildRecovery: true });
    vectors = new LanceVectorStore({
      dbPath: vectorDir, dimensions: 64,
      deferRebuildCleanup: true, rebuildJournal: metadata,
    });
    await metadata.initialize();
    await vectors.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vectors?.close();
    await metadata?.close();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  const makeLegacyChunk = () => ({
    id: 'legacy-1', filePath: 'src/a.ts', content: 'export const a = 1;',
    language: 'typescript', symbolKind: 'function' as const,
    startLine: 1, endLine: 1, hash: 'hash-a',
  });

  async function startRebuild(metadata: SqliteMetadataStore, vectors: LanceVectorStore) {
    await vectors.upsertChunks([makeLegacyChunk()], [V]);
    expect(await metadata.incrementRebuildEpoch()).toBe(1);
    await metadata.setStructuredRebuildState({ rebuildState: 'building' });
    await metadata.prepareFullRebuild(activation, []);
    const shadow = await vectors.beginLegacyShadowTable();
    await vectors.swapLegacyShadowTable(shadow, 1);
    await metadata.setStructuredRebuildState({ rebuildState: 'legacy-swapped' });
    const journal = await metadata.getFullRebuildRecovery();
    expect(journal).not.toBeNull();
    const backup = journal!.vectorArtifacts.find((entry) => entry.table === 'legacy')?.backupName;
    expect(backup).toBeTruthy();
    return { shadow, backup: backup! };
  }

  it('does not discard the only backup or journal if Legacy rollback fails once', async () => {
    const { shadow, backup } = await startRebuild(metadata, vectors);
    const internals = vectors as unknown as {
      restoreTableFromBackup: (name: string | undefined, live: string, hadLive: boolean) => Promise<unknown>;
    };
    const restore = vi.spyOn(internals, 'restoreTableFromBackup');
    restore.mockRejectedValueOnce(new Error('injected-restore-failure'));
    await expect(vectors.abortLegacyShadowTable(shadow)).rejects.toThrow('injected-restore-failure');
    expect(await metadata.getFullRebuildRecovery()).not.toBeNull();
    expect(await (await lancedb.connect(vectorDir)).tableNames()).toContain(backup);

    restore.mockRestore();
    await vectors.abortLegacyShadowTable(shadow);
    // The last backup must survive until the catalog journal is retired.
    expect(await (await lancedb.connect(vectorDir)).tableNames()).toContain(backup);
    await metadata.rollbackFullRebuild(activation);
    await vectors.cleanupOrphanedRebuildTables();
    expect(await (await lancedb.connect(vectorDir)).tableNames()).not.toContain(backup);
  });

  it('preserves an earlier backup when a later artifact cannot be restored', async () => {
    const { backup } = await startRebuild(metadata, vectors);
    await metadata.recordFullRebuildVectorArtifact({
      rebuildEpoch: 1, table: 'structured',
      shadowName: 'structured_shadow_nonexistent_fault',
      replacementName: 'structured_replacement_nonexistent_fault',
      backupName: 'structured_backup_nonexistent_fault',
      hadLiveTable: true, backupComplete: true,
    });
    const journal = await metadata.getFullRebuildRecovery();
    expect(journal).not.toBeNull();
    await expect(vectors.recoverInterruptedFullRebuild(journal!, 'rollback')).rejects.toThrow();
    expect(await metadata.getFullRebuildRecovery()).not.toBeNull();
    expect(await (await lancedb.connect(vectorDir)).tableNames()).toContain(backup);
  });

  it('does not advance the rebuild epoch over a pending recovery journal', async () => {
    await startRebuild(metadata, vectors);
    await expect(metadata.incrementRebuildEpoch()).rejects.toThrow('unresolved recovery journal');
    expect((await metadata.getStructuredIndexState()).rebuildEpoch).toBe(1);
  });

  it('keeps backup until finalize has durably retired the commit journal', async () => {
    const { backup } = await startRebuild(metadata, vectors);
    await metadata.setStructuredRebuildState({ rebuildState: 'merkle-activated' });
    const journal = await metadata.getFullRebuildRecovery();
    await vectors.recoverInterruptedFullRebuild(journal!, 'finalize');
    expect(await (await lancedb.connect(vectorDir)).tableNames()).toContain(backup);
    await metadata.finalizeInterruptedFullRebuild();
    await vectors.cleanupOrphanedRebuildTables();
    expect(await (await lancedb.connect(vectorDir)).tableNames()).not.toContain(backup);
  });
});
