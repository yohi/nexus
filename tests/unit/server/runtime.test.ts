import { describe, expect, it } from 'vitest';

import { initializeNexusRuntime } from '../../../src/server/index.js';

const makeServerOptions = () => ({
  projectRoot: process.cwd(),
  semanticSearch: { search: async () => [] },
  grepEngine: { search: async () => [] },
  orchestrator: { search: async () => ({ query: 'q', results: [], tookMs: 1 }) },
  vectorStore: {
    initialize: async () => undefined,
    upsertChunks: async () => undefined,
    deleteByFilePath: async () => 0,
    deleteByPathPrefix: async () => 0,
    renameFilePath: async () => 0,
    search: async () => [],
    compactIfNeeded: async () => ({ compacted: false, fragmentationRatioBefore: 0, fragmentationRatioAfter: 0, chunksRemoved: 0 }),
    scheduleIdleCompaction: () => undefined,
    getStats: async () => ({ totalChunks: 0, totalFiles: 0, dimensions: 64, fragmentationRatio: 0 }),
  },
  metadataStore: {
    initialize: async () => undefined,
    bulkUpsertMerkleNodes: async () => undefined,
    bulkDeleteMerkleNodes: async () => undefined,
    deleteSubtree: async () => 0,
    renamePath: async () => undefined,
    getMerkleNode: async () => null,
    getAllNodes: async () => [],
    getAllFileNodes: async () => [],
    getAllPaths: async () => [],
    getIndexStats: async () => null,
    setIndexStats: async () => undefined,
  },
  pipeline: {
    reconcileOnStartup: async () => ({
      startedAt: '2026-04-05T00:00:00.000Z',
      finishedAt: '2026-04-05T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }),
    getSkippedFiles: () => new Map(),
  },
  pluginRegistry: {
    healthCheck: async () => ({ languages: ['typescript'], embeddingProvider: 'test', healthy: true }),
  },
  runReindex: async () => [],
  loadFileContent: async () => '',
});

describe('initializeNexusRuntime', () => {
  it('initializes stores, runs startup reconciliation, and starts the watcher in order', async () => {
    const calls: string[] = [];
    const options = makeServerOptions();

    options.metadataStore.initialize = async () => {
      calls.push('metadata.initialize');
    };
    options.vectorStore.initialize = async () => {
      calls.push('vector.initialize');
    };
    options.pipeline.reconcileOnStartup = async () => {
      calls.push('pipeline.reconcileOnStartup');
      return {
        startedAt: '2026-04-05T00:00:00.000Z',
        finishedAt: '2026-04-05T00:00:01.000Z',
        durationMs: 1000,
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      };
    };

    const watcher = {
      start: async () => {
        calls.push('watcher.start');
      },
      stop: async () => {
        calls.push('watcher.stop');
      },
    };

    const runtime = await initializeNexusRuntime({ ...options, watcher } as never);

    expect(calls).toEqual([
      'metadata.initialize',
      'vector.initialize',
      'pipeline.reconcileOnStartup',
      'watcher.start',
    ]);

    await runtime.close();

    expect(calls.at(-1)).toBe('watcher.stop');
  });
});
