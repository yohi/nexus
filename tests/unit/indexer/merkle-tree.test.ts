import { describe, expect, it } from 'vitest';

import { MerkleTree } from '../../../src/indexer/merkle-tree.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';

describe('MerkleTree', () => {
  it('updates root hash when files are added and modified', async () => {
    const tree = new MerkleTree(new InMemoryMetadataStore());

    await tree.load();
    await tree.update('src/index.ts', 'hash-a');
    const initialRootHash = tree.getRootHash();

    await tree.update('src/index.ts', 'hash-b');

    expect((await tree.getNode('src/index.ts'))?.hash).toBe('hash-b');
    expect(tree.getRootHash()).not.toBe(initialRootHash);
  });

  it('recomputes parent hashes when a file is removed', async () => {
    const tree = new MerkleTree(new InMemoryMetadataStore());

    await tree.load();
    await tree.update('src/index.ts', 'hash-a');
    await tree.update('src/lib.ts', 'hash-b');
    const rootHashWithTwoFiles = tree.getRootHash();

    await tree.remove('src/index.ts');

    expect(await tree.getNode('src/index.ts')).toBeUndefined();
    expect(tree.getRootHash()).not.toBe(rootHashWithTwoFiles);
  });

  it('throws error when diff is called (deprecated)', async () => {
    await expect(MerkleTree.diff()).rejects.toThrow('MerkleTree.diff() is deprecated');
  });

  it('restores an in-memory tree from metadata store', async () => {
    const store = new InMemoryMetadataStore();
    await store.bulkUpsertMerkleNodes([
      { path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true },
      { path: 'src/index.ts', hash: 'file-hash', parentPath: 'src', isDirectory: false },
    ]);

    const tree = new MerkleTree(store);
    await tree.load();

    expect(await tree.getNode('src/index.ts')).toEqual({
      path: 'src/index.ts',
      hash: 'file-hash',
      parentPath: 'src',
      isDirectory: false,
    });
    expect(await tree.getNode('src')).toEqual({
      path: 'src',
      hash: 'dir-hash',
      parentPath: null,
      isDirectory: true,
    });
  });
});
