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

    expect(tree.getNode('src/index.ts')?.hash).toBe('hash-b');
    expect(tree.getRootHash()).not.toBe(initialRootHash);
  });

  it('recomputes parent hashes when a file is removed', async () => {
    const tree = new MerkleTree(new InMemoryMetadataStore());

    await tree.load();
    await tree.update('src/index.ts', 'hash-a');
    await tree.update('src/lib.ts', 'hash-b');
    const rootHashWithTwoFiles = tree.getRootHash();

    await tree.remove('src/index.ts');

    expect(tree.getNode('src/index.ts')).toBeUndefined();
    expect(tree.getRootHash()).not.toBe(rootHashWithTwoFiles);
  });

  it('diff reports added, modified, and deleted files', async () => {
    const oldTree = new MerkleTree(new InMemoryMetadataStore());
    const newTree = new MerkleTree(new InMemoryMetadataStore());

    await oldTree.load();
    await newTree.load();

    await oldTree.update('src/keep.ts', 'same-hash');
    await oldTree.update('src/old.ts', 'old-hash');
    await oldTree.update('src/change.ts', 'before-hash');

    await newTree.update('src/keep.ts', 'same-hash');
    await newTree.update('src/change.ts', 'after-hash');
    await newTree.update('src/new.ts', 'new-hash');

    await expect(MerkleTree.diff(oldTree, newTree)).resolves.toEqual([
      {
        type: 'modified',
        filePath: 'src/change.ts',
        contentHash: 'after-hash',
        detectedAt: expect.any(String),
      },
      {
        type: 'added',
        filePath: 'src/new.ts',
        contentHash: 'new-hash',
        detectedAt: expect.any(String),
      },
      {
        type: 'deleted',
        filePath: 'src/old.ts',
        contentHash: 'old-hash',
        detectedAt: expect.any(String),
      },
    ]);
  });

  it('detects rename candidates through matching deleted and added hashes', async () => {
    const oldTree = new MerkleTree(new InMemoryMetadataStore());
    const newTree = new MerkleTree(new InMemoryMetadataStore());

    await oldTree.load();
    await newTree.load();

    await oldTree.update('src/old-name.ts', 'same-hash');
    await newTree.update('src/new-name.ts', 'same-hash');

    const diff = await MerkleTree.diff(oldTree, newTree);
    const renameCandidates = MerkleTree.detectRenameCandidates(diff);

    expect(renameCandidates).toEqual([
      {
        oldPath: 'src/old-name.ts',
        newPath: 'src/new-name.ts',
        hash: 'same-hash',
      },
    ]);
  });

  it('restores an in-memory tree from metadata store', async () => {
    const store = new InMemoryMetadataStore();
    await store.bulkUpsertMerkleNodes([
      { path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true },
      { path: 'src/index.ts', hash: 'file-hash', parentPath: 'src', isDirectory: false },
    ]);

    const tree = new MerkleTree(store);
    await tree.load();

    expect(tree.getNode('src/index.ts')).toEqual({
      path: 'src/index.ts',
      hash: 'file-hash',
      parentPath: 'src',
      isDirectory: false,
    });
    expect(tree.getNode('src')).toEqual({
      path: 'src',
      hash: 'dir-hash',
      parentPath: null,
      isDirectory: true,
    });
  });
});
