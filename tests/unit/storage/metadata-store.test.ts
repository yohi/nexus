import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { IndexStatsRow, MerkleNodeRow } from '../../../src/types/index.js';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';

const makeNode = (overrides: Partial<MerkleNodeRow>): MerkleNodeRow => ({
  path: overrides.path ?? 'src/index.ts',
  hash: overrides.hash ?? 'hash',
  parentPath: overrides.parentPath ?? 'src',
  isDirectory: overrides.isDirectory ?? false,
});

describe('SqliteMetadataStore', () => {
  let tempDir: string;
  let store: SqliteMetadataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-metadata-store-'));
    store = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'metadata.db'),
      batchSize: 100,
    });

    await store.initialize();
  });

  afterEach(async () => {
    try {
      if (store) await store.close();
    } catch {
      // ignore
    }
    try {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('bulkUpsertMerkleNodes stores and returns file nodes', async () => {
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true }),
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    ]);

    await expect(store.getMerkleNode('src/index.ts')).resolves.toEqual(
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
    );

    await expect(store.getAllFileNodes()).resolves.toEqual([
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    ]);
  });

  it('bulkDeleteMerkleNodes removes only targeted paths', async () => {
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    ]);

    await store.bulkDeleteMerkleNodes(['src/index.ts']);

    await expect(store.getMerkleNode('src/index.ts')).resolves.toBeNull();
    await expect(store.getMerkleNode('src/lib.ts')).resolves.toEqual(
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    );
  });

  it('deleteSubtree removes descendants under the prefix', async () => {
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true }),
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/nested', hash: 'nested-hash', parentPath: 'src', isDirectory: true }),
      makeNode({ path: 'src/nested/deep.ts', hash: 'file-hash-2', parentPath: 'src/nested' }),
      makeNode({ path: 'tests/app.test.ts', hash: 'test-hash', parentPath: 'tests' }),
    ]);

    await expect(store.deleteSubtree('src')).resolves.toBe(4);
    await expect(store.getAllPaths()).resolves.toEqual(['tests/app.test.ts']);
  });

  it('splits batch writes at the configured boundary', async () => {
    const nodes = Array.from({ length: 101 }, (_, index) =>
      makeNode({
        path: `src/file-${index}.ts`,
        hash: `hash-${index}`,
      }),
    );

    await store.bulkUpsertMerkleNodes(nodes);

    await expect(store.getAllFileNodes()).resolves.toHaveLength(101);
  });

  it('persists index stats and exposes WAL autocheckpoint setting', async () => {
    const stats: IndexStatsRow = {
      id: 'primary',
      totalFiles: 3,
      totalChunks: 12,
      lastIndexedAt: '2026-04-05T10:00:00.000Z',
      lastFullScanAt: '2026-04-05T09:00:00.000Z',
      overflowCount: 1,
    };

    await store.setIndexStats(stats);

    await expect(store.getIndexStats()).resolves.toEqual(stats);
    expect(store.getPragmaValue('wal_autocheckpoint') as number).toBe(1000);
  });
});
