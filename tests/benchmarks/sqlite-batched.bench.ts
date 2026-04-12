import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { bench, describe } from 'vitest';

import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import type { MerkleNodeRow } from '../../src/types/index.js';

const NODE_COUNTS = [1000, 5000, 10000] as const;
const BATCH_SIZES = [25, 50, 100, 250, 500] as const;

// Benchmark conclusion (2026-04-12):
// Within this specific test harness, which includes the overhead of
// store initialization (mkdtemp, initialize) and cleanup (close, rm) in each
// measurement, batchSize=500 yielded the best end-to-end throughput.
// While these E2E results suggest 500 is optimal for batch operations under
// these conditions, the default is kept at 100 to prioritize event-loop
// responsiveness (frequent yielding) over raw throughput in long-running
// server contexts.


const makeNodes = (count: number): MerkleNodeRow[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    hash: `hash-${index}`,
    parentPath: 'src',
    isDirectory: false,
  }));

const withStore = async <T>(
  batchSize: number,
  setup: (store: SqliteMetadataStore) => Promise<void>,
  run: (store: SqliteMetadataStore) => Promise<T>,
): Promise<T> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-sqlite-bench-'));
  const store = new SqliteMetadataStore({
    databasePath: path.join(tempDir, 'metadata.db'),
    batchSize,
  });

  try {
    await store.initialize();
    await setup(store);
    return await run(store);
  } finally {
    try {
      await store.close();
    } catch (error) {
      console.error('Failed to close store during benchmark cleanup:', error);
    }
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
          await withStore(
            batchSize,
            async () => {}, // No setup needed for upsert
            async (store) => {
              await store.bulkUpsertMerkleNodes(nodes);
            },
          );
        },
        {
          iterations: 10,
        },
      );

      bench(
        `upsert+delete batchSize=${batchSize}`,
        async () => {
          await withStore(
            batchSize,
            async (store) => {
              // Preparation
              await store.bulkUpsertMerkleNodes(nodes);
            },
            async (store) => {
              // Measured operation (along with setup/lifecycle)
              await store.bulkDeleteMerkleNodes(paths);
            },
          );
        },
        {
          iterations: 10,
        },
      );
    }
  });
}
