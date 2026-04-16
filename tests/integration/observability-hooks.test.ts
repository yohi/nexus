import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterQueue } from '../../src/indexer/dead-letter-queue.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import type { IMetadataStore } from '../../src/types/index.js';

describe('Observability Hooks Integration', () => {
  let mockMetadataStore: any;

  beforeEach(() => {
    mockMetadataStore = {
      initialize: vi.fn().mockResolvedValue(undefined),
      bulkUpsertMerkleNodes: vi.fn().mockResolvedValue(undefined),
      bulkDeleteMerkleNodes: vi.fn().mockResolvedValue(undefined),
      bulkDeleteSubtrees: vi.fn().mockResolvedValue(0),
      deleteSubtree: vi.fn().mockResolvedValue(0),
      pruneEmptyParents: vi.fn().mockResolvedValue(undefined),
      renamePath: vi.fn().mockResolvedValue(undefined),
      getMerkleNode: vi.fn().mockResolvedValue(null),
      hasChildren: vi.fn().mockResolvedValue(false),
      getAllNodes: vi.fn().mockResolvedValue([]),
      getAllFileNodes: vi.fn().mockResolvedValue([]),
      getAllPaths: vi.fn().mockResolvedValue([]),
      getIndexStats: vi.fn().mockResolvedValue(null),
      setIndexStats: vi.fn().mockResolvedValue(undefined),
      upsertDeadLetterEntries: vi.fn().mockResolvedValue(undefined),
      removeDeadLetterEntries: vi.fn().mockResolvedValue(undefined),
      getDeadLetterEntries: vi.fn().mockResolvedValue([]),
      getMetadata: vi.fn().mockResolvedValue(null),
      setMetadata: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('DeadLetterQueue Hooks', () => {
    it('onDlqSnapshot and onRecoverySweepComplete are fired', async () => {
      const onDlqSnapshot = vi.fn();
      const onRecoverySweepComplete = vi.fn();

      const dlq = new DeadLetterQueue({
        metadataStore: mockMetadataStore as unknown as IMetadataStore,
        metricsHooks: {
          onDlqSnapshot,
          onRecoverySweepComplete,
        },
        name: 'test-dlq'
      });

      // load() triggers onDlqSnapshot
      await dlq.load();
      expect(onDlqSnapshot).toHaveBeenCalledWith(0, 'test-dlq');

      // recoverySweep() triggers onRecoverySweepComplete
      await dlq.recoverySweep();
      expect(onRecoverySweepComplete).toHaveBeenCalledWith(0, 0, 0, 'test-dlq');
    });
  });

  describe('IndexPipeline Hooks', () => {
    it('onChunksIndexed is fired during processEvents', async () => {
      const onChunksIndexed = vi.fn();
      
      const pipeline = new IndexPipeline({
        metadataStore: mockMetadataStore as unknown as IMetadataStore,
        indexer: {} as any,
        vectorStore: {
          deleteByFilePath: vi.fn().mockResolvedValue(undefined),
        } as any,
        chunker: {} as any,
        embeddingProvider: {} as any,
        pluginRegistry: {} as any,
        metricsHooks: {
          onChunksIndexed,
          onDlqSnapshot: vi.fn(),
        }
      });

      // To trigger onChunksIndexed, we can process a simple 'deleted' event
      // which doesn't require complex dependencies like chunker/embeddings.
      await pipeline.processEvents([
        { type: 'deleted', filePath: 'test.ts' }
      ]);

      expect(onChunksIndexed).toHaveBeenCalledWith(0);
    });
  });
});
