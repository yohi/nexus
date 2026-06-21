import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { Registry } from 'prom-client';

import { initializeNexusRuntime, type NexusRuntimeOptions } from '../../../src/server/index.js';

import { PathSanitizer } from '../../../src/server/path-sanitizer.js';

const makeServerOptions = (): Omit<NexusRuntimeOptions, 'watcher'> => ({
  projectRoot: process.cwd(),
  sanitizer: {
    sanitize: async (p: string) => p,
    validateGlob: (p: string) => p,
  } as unknown as PathSanitizer,
  semanticSearch: { search: async () => [] },
  grepEngine: { search: async () => [] },
  orchestrator: { search: async () => ({ query: 'q', results: [], tookMs: 1 }) } as any,
  vectorStore: {
    initialize: async () => undefined,
    upsertChunks: async () => undefined,
    deleteByFilePath: async () => 0,
    deleteByPathPrefix: async () => 0,
    renameFilePath: async () => 0,
    search: async () => [],
    compactIfNeeded: async () => ({ compacted: false, fragmentationRatioBefore: 0, fragmentationRatioAfter: 0, chunksRemoved: 0 }),
    scheduleIdleCompaction: () => setTimeout(() => {}, 0),
    getStats: async () => ({ totalChunks: 0, totalFiles: 0, dimensions: 64, fragmentationRatio: 0 }),
  } as any,
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
  } as any,
  pipeline: {
    reconcileOnStartup: async () => ({
      startedAt: '2026-04-05T00:00:00.000Z',
      finishedAt: '2026-04-05T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }),
    getSkippedFiles: () => new Map(),
    start: () => undefined,
    stop: async () => {},
  } as any,
  pluginRegistry: {
    healthCheck: async () => ({ languages: ['typescript'], embeddingProvider: 'test', healthy: true }),
  } as any,
  runReindex: async () => [],
  loadFileContent: async () => '',
});

describe('initializeNexusRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    const runtime = await initializeNexusRuntime({ ...options, watcher } as unknown as NexusRuntimeOptions);

    expect(calls).toEqual([
      'metadata.initialize',
      'vector.initialize',
      'pipeline.reconcileOnStartup',
      'watcher.start',
    ]);

    await runtime.close();

    expect(calls.at(-1)).toBe('watcher.stop');
  });

  it('starts the server even if watcher.start fails (e.g. EMFILE)', async () => {
    const options = makeServerOptions();
    const watcher = {
      start: async () => {
        const error = new Error('EMFILE: too many open files');
        (error as any).code = 'EMFILE';
        throw error;
      },
      stop: async () => {},
    };

    // Should not throw
    const runtime = await initializeNexusRuntime({ ...options, watcher } as unknown as NexusRuntimeOptions);
    expect(runtime.server).toBeDefined();

    await runtime.close();
  });

  it('registers with a 1000ms timeout and projectRoot basename when aggregatorPort is configured', async () => {
    vi.useFakeTimers();
    const registrations: Array<{ readonly url: string; readonly body: unknown; readonly signal: AbortSignal | undefined }> = [];
    const fetchStub: typeof fetch = (input, init) => {
      registrations.push({
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        signal: init?.signal ?? undefined,
      });
      return new Promise<Response>(() => {});
    };
    vi.stubGlobal('fetch', fetchStub);

    const options = makeServerOptions();
    const watcher = {
      start: async () => undefined,
      stop: async () => undefined,
    };

    try {
      const runtime = await initializeNexusRuntime({
        ...options,
        watcher,
        projectRoot: path.join(process.cwd(), 'project-alpha'),
        metricsCollectorRegistry: new Registry(),
        metricsPort: 0,
        aggregatorPort: 9470,
      });
      await Promise.resolve();

      expect(registrations).toContainEqual({
        url: 'http://127.0.0.1:9470/api/discovery/register',
        body: expect.objectContaining({ projectId: 'project-alpha' }),
        signal: expect.any(AbortSignal),
      });
      expect(registrations[0]?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect(registrations[0]?.signal?.aborted).toBe(true);

      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
