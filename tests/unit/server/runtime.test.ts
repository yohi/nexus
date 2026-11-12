import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Registry } from 'prom-client';

import { buildNexusRuntime, initializeNexusRuntime, type NexusRuntimeOptions } from '../../../src/server/index.js';

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
    getIndexStats: async () => ({
      id: 'primary',
      totalFiles: 0,
      totalChunks: 0,
      lastIndexedAt: '2026-08-20T00:00:00.000Z',
      lastFullScanAt: null,
      overflowCount: 0,
      lastError: null,
    }),
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
    reindex: async () => ({
      startedAt: '2026-08-20T00:00:00.000Z',
      finishedAt: '2026-08-20T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }),
    waitForActiveReindex: async () => {},
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

  it('does not start startup reindex when close happens during watcher startup', async () => {
    const options = makeServerOptions();
    options.metadataStore.getIndexStats = async () => null;
    const storageDir = await mkdtemp(path.join(tmpdir(), 'nexus-runtime-close-'));
    await mkdir(path.join(storageDir, 'metrics.port'));
    options.metricsCollectorRegistry = new Registry();
    options.storageDir = storageDir;
    options.metricsPort = 0;
    const reindex = vi.fn(async () => ({
      startedAt: '2026-08-20T00:00:00.000Z',
      finishedAt: '2026-08-20T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }));
    options.pipeline.reindex = reindex;

    let releaseStart: () => void = () => undefined;
    let reportStartEntered: () => void = () => undefined;
    const startEntered = new Promise<void>((resolve) => { reportStartEntered = resolve; });
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let watcherStopped = false;
    const watcher = {
      start: async () => { reportStartEntered(); await startGate; },
      stop: async () => { watcherStopped = true; },
    };
    const runtime = buildNexusRuntime({ ...options, watcher } as unknown as NexusRuntimeOptions);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const initialization = runtime.initialize();
      await startEntered;
      const closing = runtime.close();
      releaseStart();
      await Promise.all([initialization, closing]);

      expect(reindex).not.toHaveBeenCalled();
      expect(watcherStopped).toBe(true);
      expect(warn).not.toHaveBeenCalledWith('[Nexus] Failed to write metrics port file:', expect.anything());
    } finally {
      warn.mockRestore();
      await rm(storageDir, { recursive: true, force: true });
    }
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
    expect(runtime.createServer).toBeDefined();

    await runtime.close();
  });

  it('delegates manual reindexing to the pipeline with the scanner callback', async () => {
    const options = makeServerOptions();
    const runReindex = vi.fn(async () => []);
    const loadFileContent = vi.fn(async () => '');
    const pipelineReindex = vi.fn(async () => ({
      startedAt: '2026-07-17T00:00:00.000Z',
      finishedAt: '2026-07-17T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }));
    options.runReindex = runReindex;
    options.loadFileContent = loadFileContent;
    options.pipeline.reindex = pipelineReindex;
    const watcher = {
      start: async () => undefined,
      stop: async () => undefined,
    };
    const runtime = await initializeNexusRuntime({ ...options, watcher });

    await runtime.reindex(true);

    expect(pipelineReindex).toHaveBeenCalledWith(runReindex, loadFileContent, true);
    await runtime.close();
  });

  it('rejects manual reindexing when the pipeline is already running', async () => {
    const options = makeServerOptions();
    options.pipeline.reindex = vi.fn(async () => ({ status: 'already_running' as const }));
    const watcher = {
      start: async () => undefined,
      stop: async () => undefined,
    };
    const runtime = await initializeNexusRuntime({ ...options, watcher });

    await expect(runtime.reindex()).rejects.toThrow(
      'Reindex already running: already_running',
    );
    await runtime.close();
  });

  it('rejects manual reindexing when shutdown begins during initialization', async () => {
    const options = makeServerOptions();
    let releaseStart: () => void = () => undefined;
    let reportStartEntered: () => void = () => undefined;
    const startEntered = new Promise<void>((resolve) => { reportStartEntered = resolve; });
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const runtime = buildNexusRuntime({ ...options, watcher: {
      start: async () => { reportStartEntered(); await startGate; },
      stop: async () => undefined,
    } as unknown as NexusRuntimeOptions['watcher'] });
    const reindex = runtime.reindex();
    await startEntered;
    const closing = runtime.close();
    releaseStart();
    await expect(reindex).rejects.toThrow(/shutdown|shutting down/i);
    await closing;
  });

  it('reports an incomplete manual reindex separately from an already-running reindex', async () => {
    const options = makeServerOptions();
    options.pipeline.reindex = vi.fn(async () => ({ status: 'incomplete' as const }));
    const watcher = {
      start: async () => undefined,
      stop: async () => undefined,
    };
    const runtime = await initializeNexusRuntime({ ...options, watcher });

    await expect(runtime.reindex()).rejects.toThrow(
      'Reindex incomplete: dead-letter queue entries remain',
    );
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
