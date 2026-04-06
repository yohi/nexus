import { describe, expect, it } from 'vitest';

import { gcOrphanNodes } from '../../../src/indexer/gc.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';

describe('gcOrphanNodes', () => {
  it('removes file nodes that no longer exist on disk', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.bulkUpsertMerkleNodes([
      { path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true },
      { path: 'src/auth.ts', hash: 'file-hash-1', parentPath: 'src', isDirectory: false },
      { path: 'src/stale.ts', hash: 'file-hash-2', parentPath: 'src', isDirectory: false },
      { path: 'tests', hash: 'tests-hash', parentPath: null, isDirectory: true },
      { path: 'tests/auth.test.ts', hash: 'test-hash', parentPath: 'tests', isDirectory: false },
    ]);

    const removed = await gcOrphanNodes(metadataStore, async (targetPath) => {
      return targetPath !== 'src/stale.ts';
    });

    expect(removed).toBe(1);
    await expect(metadataStore.getAllPaths()).resolves.toEqual([
      'src',
      'src/auth.ts',
      'tests',
      'tests/auth.test.ts',
    ]);
  });
});
