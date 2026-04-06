import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { bench, describe } from 'vitest';

import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import type { MerkleNodeRow } from '../../src/types/index.js';

const NODE_COUNTS = [1000, 5000, 10000] as const;
const BATCH_SIZES = [25, 50, 100, 250, 500] as const;

const makeNodes = (count: number): MerkleNodeRow[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    hash: `hash-${index}`,
    parentPath: 'src',
    isDirectory: false,
  }));

const withStore = async <T>(batchSize: number, run: (store: SqliteMetadataStore) => Promise<T>): Promise<T> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-sqlite-bench-'));
  const store = new SqliteMetadataStore({
    databasePath: path.join(tempDir, 'metadata.db'),
    batchSize,
  });

  try {
    await store.initialize();
    return await run(store);
  } finally {
    await store.close();
    await rm(tempDir, { recursive: true, force: true });
  }
};

for (const nodeCount of NODE_COUNTS) {
  describe(`sqlite batched writes (${nodeCount} nodes)`, () => {
    const nodes = makeNodes(nodeCount);
    const paths = nodes.map((node) => node.path);

    for (const batchSize of BATCH_SIZES) {
      bench(
        `upsert batchSize=${batchSize}`,
        async () => {
          await withStore(batchSize, async (store) => {
            await store.bulkUpsertMerkleNodes(nodes);
          });
        },
        {
          iterations: 3,
        },
      );

      bench(
        `delete batchSize=${batchSize}`,
        async () => {
          await withStore(batchSize, async (store) => {
            await store.bulkUpsertMerkleNodes(nodes);
            await store.bulkDeleteMerkleNodes(paths);
          });
        },
        {
          iterations: 3,
        },
      );
    }
  });
}
