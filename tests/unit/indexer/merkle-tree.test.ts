import { describe, expect, it } from 'vitest';

import { MerkleTree } from '../../../src/indexer/merkle-tree.js';
import { computeStringHash } from '../../../src/indexer/hash.js';
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

  it('recomputes every ancestor from the updated descendant hash', async () => {
    const tree = new MerkleTree(new InMemoryMetadataStore());
    await tree.load();
    await tree.update('packages/pkg/src/a.ts', 'hash-a');
    await tree.update('packages/pkg/src/b.ts', 'hash-b');

    const expectedSourceDirectoryHash = await computeStringHash([
      'packages/pkg/src/a.ts',
      'packages/pkg/src/b.ts',
    ].map((filePath, index) => `${filePath.length}:${filePath}:${index === 0 ? 'hash-a' : 'hash-b'}`).join(''));
    const expectedPackageDirectoryHash = await computeStringHash(
      `${'packages/pkg/src'.length}:packages/pkg/src:${expectedSourceDirectoryHash}`,
    );

    expect((await tree.getNode('packages/pkg'))?.hash).toBe(expectedPackageDirectoryHash);
  });

  it('includes newly created intermediate directories in existing ancestor hashes', async () => {
    const tree = new MerkleTree(new InMemoryMetadataStore());
    await tree.load();
    await tree.update('packages/pkg/existing.ts', 'hash-existing');
    await tree.update('packages/pkg/new/deep.ts', 'hash-deep');

    const expectedDirectoryHash = await computeStringHash(
      `${'packages/pkg/new/deep.ts'.length}:packages/pkg/new/deep.ts:hash-deep`,
    );
    const expectedPackageHash = await computeStringHash([
      `${'packages/pkg/existing.ts'.length}:packages/pkg/existing.ts:hash-existing`,
      `${'packages/pkg/new'.length}:packages/pkg/new:${expectedDirectoryHash}`,
    ].join(''));

    expect((await tree.getNode('packages/pkg'))?.hash).toBe(expectedPackageHash);
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
