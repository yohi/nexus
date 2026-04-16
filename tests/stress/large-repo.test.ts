import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MerkleNodeRow } from '../../src/types/index.js';
import { MerkleTree } from '../../src/indexer/merkle-tree.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';

const LARGE_REPO_FILE_COUNT = 2_000;

describe('stress: large repository metadata', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-large-repo-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads and mutates a large persisted merkle tree without losing integrity', async () => {
    const databasePath = path.join(tempDir, 'metadata.db');
    let store = new SqliteMetadataStore({ databasePath, batchSize: 500 });
    await store.initialize();

    let nodes: MerkleNodeRow[] = [];
    try {
      nodes = [
        { path: 'src', hash: 'src-dir', parentPath: null, isDirectory: true },
        { path: 'src/packages', hash: 'packages-dir', parentPath: 'src', isDirectory: true },
      ];

      for (let packageIndex = 0; packageIndex < 10; packageIndex += 1) {
        const packagePath = `src/packages/pkg-${packageIndex}`;
        nodes.push({
          path: packagePath,
          hash: `dir-hash-${packageIndex}`,
          parentPath: 'src/packages',
          isDirectory: true,
        });

        for (let fileIndex = 0; fileIndex < 200; fileIndex += 1) {
          nodes.push({
            path: `${packagePath}/file-${fileIndex}.ts`,
            hash: `hash-${packageIndex}-${fileIndex}`,
            parentPath: packagePath,
            isDirectory: false,
          });
        }
      }

      expect(nodes.filter((node) => !node.isDirectory)).toHaveLength(LARGE_REPO_FILE_COUNT);

      await store.bulkUpsertMerkleNodes(nodes);

      const tree = new MerkleTree(store);
      await tree.load();

      expect(await tree.getNode('src/packages/pkg-0/file-0.ts')).toEqual(
        expect.objectContaining({
          path: 'src/packages/pkg-0/file-0.ts',
          hash: 'hash-0-0',
          isDirectory: false,
        }),
      );
      expect(await tree.getNode('src/packages/pkg-9/file-199.ts')).toEqual(
        expect.objectContaining({
          path: 'src/packages/pkg-9/file-199.ts',
          hash: 'hash-9-199',
          isDirectory: false,
        }),
      );
      expect(tree.getRootHash()).not.toBeNull();

      const removed = await store.deleteSubtree('src/packages/pkg-42');
      expect(removed).toBe(201);
    } finally {
      await store.close();
    }

    // P2 Fix: Re-create the store from the same database file to verify persistence recovery.
    store = new SqliteMetadataStore({ databasePath, batchSize: 500 });
    await store.initialize();

    try {
      const reloadedTree = new MerkleTree(store);
      await reloadedTree.load();

      expect(await reloadedTree.getNode('src/packages/pkg-42')).toBeUndefined();
      expect(await reloadedTree.getNode('src/packages/pkg-42/file-0.ts')).toBeUndefined();
      expect(await reloadedTree.getNode('src/packages/pkg-41/file-199.ts')).toEqual(
        expect.objectContaining({
          path: 'src/packages/pkg-41/file-199.ts',
          hash: 'hash-41-199',
        }),
      );

      const allPaths = await store.getAllPaths();
      expect(allPaths).toHaveLength(nodes.length - 201);
    } finally {
      await store.close();
    }
  }, 20_000);
});
