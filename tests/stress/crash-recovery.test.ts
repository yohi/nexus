import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MerkleTree } from '../../src/indexer/merkle-tree.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

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

    const firstStore = new SqliteMetadataStore({ databasePath, batchSize: 128 });
    await firstStore.initialize();
    const firstTree = new MerkleTree(firstStore);
    await firstTree.load();

    const initialEvents = Array.from({ length: 250 }, (_, index) => ({
      filePath: `src/generated/file-${index}.ts`,
      contentHash: `hash-${index}`,
    }));

    await firstTree.update(fixturePath, 'fixture-hash');
    for (const event of initialEvents) {
      await firstTree.update(event.filePath, event.contentHash);
    }

    const persistedPathsBeforeCrash = await firstStore.getAllPaths();
    expect(persistedPathsBeforeCrash.length).toBeGreaterThan(250);
    await firstStore.close();

    const recoveredStore = new SqliteMetadataStore({ databasePath, batchSize: 128 });
    await recoveredStore.initialize();

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
    expect(recoveredTree.getRootHash()).not.toBeNull();

    const recoveredPaths = await recoveredStore.getAllPaths();
    expect(recoveredPaths).toEqual(persistedPathsBeforeCrash);

    await recoveredStore.close();
  }, 20_000);
});
