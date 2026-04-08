import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { DeadLetterEntry, IndexStatsRow, MerkleNodeRow } from '../../../src/types/index.js';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';

const makeNode = (overrides: Partial<MerkleNodeRow>): MerkleNodeRow => ({
  path: overrides.path ?? 'src/index.ts',
  hash: overrides.hash ?? 'hash',
  parentPath: overrides.parentPath ?? 'src',
  isDirectory: overrides.isDirectory ?? false,
});

const makeDeadLetterEntry = (overrides: Partial<DeadLetterEntry>): DeadLetterEntry => ({
  id: overrides.id ?? 'dlq-1',
  filePath: overrides.filePath ?? '/repo/src/auth.ts',
  contentHash: overrides.contentHash ?? 'hash-1',
  errorMessage: overrides.errorMessage ?? 'embed failed',
  attempts: overrides.attempts ?? 3,
  createdAt: overrides.createdAt ?? '2026-04-07T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-07T00:00:00.000Z',
  lastRetryAt: overrides.lastRetryAt ?? null,
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

  it('stores, updates, and removes dead letter entries', async () => {
    const first = makeDeadLetterEntry({ id: 'dlq-1' });
    const second = makeDeadLetterEntry({ id: 'dlq-2', filePath: '/repo/src/other.ts', contentHash: 'hash-2' });

    await store.upsertDeadLetterEntries([first, second]);
    await expect(store.getDeadLetterEntries()).resolves.toEqual([first, second]);

    const updated = makeDeadLetterEntry({
      id: 'dlq-1',
      errorMessage: 'embed failed again',
      attempts: 4,
      updatedAt: '2026-04-07T00:01:00.000Z',
      lastRetryAt: '2026-04-07T00:01:00.000Z',
    });
    await store.upsertDeadLetterEntries([updated]);
    await store.removeDeadLetterEntries(['dlq-2']);

    await expect(store.getDeadLetterEntries()).resolves.toEqual([updated]);
  });

  it('renamePath preserves the isDirectory property of the node', async () => {
    // 1. Rename a file
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src/old.ts', hash: 'h1', isDirectory: false }),
    ]);
    await store.renamePath('src/old.ts', 'src/new.ts', 'h1-updated');
    const fileNode = await store.getMerkleNode('src/new.ts');
    expect(fileNode?.isDirectory).toBe(false);
    expect(fileNode?.hash).toBe('h1-updated');
    await expect(store.getMerkleNode('src/old.ts')).resolves.toBeNull();

    // 2. Rename a directory
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'old-dir', hash: 'd1', parentPath: null, isDirectory: true }),
    ]);
    await store.renamePath('old-dir', 'new-dir', 'd1-updated');
    const dirNode = await store.getMerkleNode('new-dir');
    expect(dirNode?.isDirectory).toBe(true);
    expect(dirNode?.hash).toBe('d1-updated');
    await expect(store.getMerkleNode('old-dir')).resolves.toBeNull();
  });
});
