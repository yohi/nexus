import { describe, expect, it } from 'vitest';

import { gcOrphanNodes } from '../../../src/indexer/gc.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

describe('gcOrphanNodes', () => {
  it('removes file nodes that no longer exist on disk and prunes parent directories', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 3 });
    await metadataStore.initialize();
    await metadataStore.bulkUpsertMerkleNodes([
      { path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true },
      { path: 'src/auth.ts', hash: 'file-hash-1', parentPath: 'src', isDirectory: false },
      { path: 'src/stale.ts', hash: 'file-hash-2', parentPath: 'src', isDirectory: false },
      { path: 'tests', hash: 'tests-hash', parentPath: null, isDirectory: true },
      { path: 'tests/auth.test.ts', hash: 'test-hash', parentPath: 'tests', isDirectory: false },
    ]);

    const removed = await gcOrphanNodes(metadataStore, vectorStore, async (targetPath) => {
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

  it('runs against an empty store with no removals', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 3 });
    const removed = await gcOrphanNodes(metadataStore, vectorStore, async () => false);
    expect(removed).toBe(0);
    expect(await metadataStore.getAllPaths()).toEqual([]);
  });

  it('preserves all nodes if pathExists always returns true', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 3 });
    await metadataStore.bulkUpsertMerkleNodes([
      { path: 'src/a.ts', hash: 'h1', parentPath: 'src', isDirectory: false },
    ]);
    const removed = await gcOrphanNodes(metadataStore, vectorStore, async () => true);
    expect(removed).toBe(0);
    expect((await metadataStore.getAllPaths()).length).toBe(1);
  });

  it('removes multiple file nodes and their empty parent directories', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 3 });
    await metadataStore.bulkUpsertMerkleNodes([
      { path: 'src', hash: '', parentPath: null, isDirectory: true },
      { path: 'src/a.ts', hash: 'h1', parentPath: 'src', isDirectory: false },
      { path: 'src/b.ts', hash: 'h2', parentPath: 'src', isDirectory: false },
      { path: 'keep', hash: '', parentPath: null, isDirectory: true },
      { path: 'keep/file.ts', hash: 'h3', parentPath: 'keep', isDirectory: false },
    ]);

    const removed = await gcOrphanNodes(metadataStore, vectorStore, async (p) =>
      p.startsWith('keep'),
    );
    expect(removed).toBe(2);
    expect(await metadataStore.getAllPaths()).toEqual(['keep', 'keep/file.ts']);
  });
});
