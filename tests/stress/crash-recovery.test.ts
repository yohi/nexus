import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MerkleTree } from '../../src/indexer/merkle-tree.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';

// P1 Fix: Use relative path to ensure it's included in the root hash computation.
const fixturePath = 'tests/fixtures/sample-project/src/auth.ts';

describe('stress: crash recovery', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-crash-recovery-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('restores persisted merkle metadata after a simulated process restart', async () => {
    const databasePath = path.join(tempDir, 'metadata.db');

    const initialEvents = Array.from({ length: 250 }, (_, index) => ({
      filePath: `src/generated/file-${index}.ts`,
      contentHash: `hash-${index}`,
    }));

    // Explicitly define what we expect to find in the store.
    const expectedPaths = new Set<string>();
    expectedPaths.add(fixturePath);
    // Ancestors for fixturePath: tests, tests/fixtures, tests/fixtures/sample-project, tests/fixtures/sample-project/src
    expectedPaths.add('tests');
    expectedPaths.add('tests/fixtures');
    expectedPaths.add('tests/fixtures/sample-project');
    expectedPaths.add('tests/fixtures/sample-project/src');

    for (const event of initialEvents) {
      expectedPaths.add(event.filePath);
    }
    // Ancestors for generated files: src, src/generated
    expectedPaths.add('src');
    expectedPaths.add('src/generated');

    let rootHashBeforeCrash: string | null = null;
    let persistedPathsBeforeCrash: string[] = [];

    const firstStore = new SqliteMetadataStore({ databasePath, batchSize: 128 });
    await firstStore.initialize();
    try {
      const firstTree = new MerkleTree(firstStore);
      await firstTree.load();

      await firstTree.update(fixturePath, 'fixture-hash');
      for (const event of initialEvents) {
        await firstTree.update(event.filePath, event.contentHash);
      }

      persistedPathsBeforeCrash = await firstStore.getAllPaths();
      rootHashBeforeCrash = firstTree.getRootHash();

      // Nitpick Fix: Verify all specific expected paths are present.
      expect(persistedPathsBeforeCrash.length).toBe(expectedPaths.size);
      for (const p of expectedPaths) {
        expect(persistedPathsBeforeCrash).toContain(p);
      }
    } finally {
      // Inline Comment Fix: Ensure firstStore is closed even if assertions fail.
      await firstStore.close();
    }

    const recoveredStore = new SqliteMetadataStore({ databasePath, batchSize: 128 });
    await recoveredStore.initialize();

    // P2 Fix: Wrap recovery assertions in try-finally to ensure the store is closed even if assertions fail.
    try {
      const recoveredTree = new MerkleTree(recoveredStore);
      await recoveredTree.load();

      expect(recoveredTree.getNode(fixturePath)).toEqual(
        expect.objectContaining({
          path: fixturePath,
          hash: 'fixture-hash',
          isDirectory: false,
        }),
      );
      expect(recoveredTree.getNode('src/generated')).toEqual(
        expect.objectContaining({
          path: 'src/generated',
          isDirectory: true,
        }),
      );
      // P2 Fix: Compare with the root hash captured before the "crash".
      expect(recoveredTree.getRootHash()).toBe(rootHashBeforeCrash);

      const recoveredPaths = await recoveredStore.getAllPaths();
      // Nitpick Fix: Verify all specific expected paths are present after recovery.
      expect(recoveredPaths.length).toBe(expectedPaths.size);
      expect(new Set(recoveredPaths)).toEqual(new Set(persistedPathsBeforeCrash));
      for (const p of expectedPaths) {
        expect(recoveredPaths).toContain(p);
      }
    } finally {
      await recoveredStore.close();
    }
  }, 20_000);
});
