import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from 'prom-client';

import { EventQueue } from '../../../src/indexer/event-queue.js';
import { buildNexusRuntime, initializeNexusRuntime, type NexusRuntimeOptions } from '../../../src/server/index.js';
import type { IndexStatsRow, ReindexResult } from '../../../src/types/index.js';

const indexedStats: IndexStatsRow = {
  id: 'primary',
  totalFiles: 1,
  totalChunks: 1,
  lastIndexedAt: '2026-08-20T00:00:00.000Z',
  lastFullScanAt: null,
  overflowCount: 0,
  lastError: null,
};

const reindexResult: ReindexResult = {
  startedAt: '2026-08-20T00:00:00.000Z',
  finishedAt: '2026-08-20T00:00:01.000Z',
  durationMs: 1000,
  reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
  chunksIndexed: 0,
};

const makeOptions = (overrides: Record<string, unknown> = {}): NexusRuntimeOptions => {
  const eventQueue = new EventQueue({
    debounceMs: 0,
    maxQueueSize: 10,
    fullScanThreshold: 8,
    concurrency: 1,
  });
  const options = {
    projectRoot: process.cwd(),
    sanitizer: {},
    semanticSearch: {},
    grepEngine: {},
    orchestrator: {},
    vectorStore: {
      initialize: vi.fn(async () => undefined),
    },
    metadataStore: {
      initialize: vi.fn(async () => undefined),
      getIndexStats: vi.fn(async () => null as IndexStatsRow | null),
    },
    pipeline: {
      reconcileOnStartup: vi.fn(async () => ({
        startedAt: '2026-08-20T00:00:00.000Z',
        finishedAt: '2026-08-20T00:00:00.000Z',
        durationMs: 0,
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      })),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      reindex: vi.fn(async () => reindexResult),
      waitForActiveReindex: vi.fn(async () => undefined),
      getProgress: vi.fn(() => ({ totalFiles: 0, processedFiles: 0, status: 'idle' as const })),
      getSkippedFiles: vi.fn(() => new Map()),
    },
    watcher: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
    pluginRegistry: {},
    runReindex: vi.fn(async () => []),
    loadFileContent: vi.fn(async () => ''),
    eventQueue,
    ...overrides,
  };
  return options as unknown as NexusRuntimeOptions;
};

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('NexusRuntime automatic initial full index', () => {
  it('does not start startup work when shutdown occurs while index stats are pending', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'nexus-runtime-shutdown-'));
    let releaseStats: (stats: IndexStatsRow | null) => void = () => {
      throw new Error('stats resolver was not initialized');
    };
    const statsPending = new Promise<IndexStatsRow | null>((resolve) => {
      releaseStats = resolve;
    });
    let markStatsStarted: () => void = () => {
      throw new Error('stats start signal was not initialized');
    };
    const statsStarted = new Promise<void>((resolve) => {
      markStatsStarted = resolve;
    });
    const options = makeOptions();
    options.metricsCollectorRegistry = new Registry();
    options.storageDir = storageDir;
    options.metadataStore.getIndexStats = vi.fn(() => {
      markStatsStarted();
      return statsPending;
    });
    const runtime = buildNexusRuntime(options);
    const initialization = runtime.initialize();

    await statsStarted;
    runtime.terminate?.();
    releaseStats(null);
    await initialization;
    await runtime.initialize();

    expect(options.metadataStore.getIndexStats).toHaveBeenCalledOnce();
    expect(options.pipeline.start).not.toHaveBeenCalled();
    expect(options.pipeline.reindex).not.toHaveBeenCalled();
    expect(options.watcher.start).not.toHaveBeenCalled();
    expect(await readdir(storageDir)).not.toContain('metrics.port');
    await runtime.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('starts an unindexed full reindex without blocking initialization', async () => {
    let releaseReindex: (() => void) | undefined;
    const reindexDone = new Promise<void>((resolve) => {
      releaseReindex = resolve;
    });
    const options = makeOptions();
    const eventQueue = options.eventQueue!;
    const reindex = vi.fn(async () => {
      await reindexDone;
      return reindexResult;
    });
    options.pipeline.reindex = reindex;
    const runtime = await initializeNexusRuntime(options);

    expect(reindex).toHaveBeenCalledWith(
      options.runReindex,
      options.loadFileContent,
      true,
      'startup-reconciliation',
    );
    expect(eventQueue.isPostScanActive()).toBe(true);

    releaseReindex?.();
    await tick();
    expect(eventQueue.isPostScanActive()).toBe(false);
    await runtime.close();
  });

  it('waits for the startup auto-index before completing a manual reindex request', async () => {
    let releaseAutoReindex: (() => void) | undefined;
    const autoReindexDone = new Promise<void>((resolve) => {
      releaseAutoReindex = resolve;
    });
    let isStartupReindex = true;
    const options = makeOptions();
    const reindex = vi.fn(async () => {
      if (isStartupReindex) {
        isStartupReindex = false;
        await autoReindexDone;
        return reindexResult;
      }
      return { status: 'already_running' as const };
    });
    options.pipeline.reindex = reindex;
    const runtime = await initializeNexusRuntime(options);

    let manualReindexSettled = false;
    const manualReindex = runtime.reindex().finally(() => {
      manualReindexSettled = true;
    });
    await tick();
    expect(reindex).toHaveBeenCalledTimes(2);
    expect(manualReindexSettled).toBe(false);

    releaseAutoReindex?.();
    await expect(manualReindex).resolves.toBeUndefined();
    await runtime.close();
  });

  it('rejects a manual reindex when startup completes as incomplete without a progress error', async () => {
    let releaseAutoReindex: (() => void) | undefined;
    const autoReindexDone = new Promise<void>((resolve) => {
      releaseAutoReindex = resolve;
    });
    let isStartupReindex = true;
    const options = makeOptions();
    const reindex = vi.fn(async () => {
      if (isStartupReindex) {
        isStartupReindex = false;
        await autoReindexDone;
        return { status: 'incomplete' as const };
      }
      return { status: 'already_running' as const };
    });
    options.pipeline.reindex = reindex;
    const runtime = await initializeNexusRuntime(options);

    const manualReindex = runtime.reindex();
    await tick();
    expect(reindex).toHaveBeenCalledTimes(2);

    releaseAutoReindex?.();
    await expect(manualReindex).rejects.toThrow('Reindex incomplete: dead-letter queue entries remain');
    await runtime.close();
  });

  it('keeps later unrelated already-running reindexes rejected after startup completes', async () => {
    const options = makeOptions();
    let reindexCallCount = 0;
    options.pipeline.reindex = vi.fn(() => {
      reindexCallCount += 1;
      if (reindexCallCount === 1) {
        return Promise.resolve(reindexResult);
      }
      return Promise.resolve({ status: 'already_running' as const });
    });
    const runtime = await initializeNexusRuntime(options);

    await tick();
    await expect(runtime.reindex()).rejects.toThrow(
      'Reindex already running: already_running',
    );
    await runtime.close();
  });

  it('does not auto-index an already indexed project', async () => {
    const options = makeOptions();
    options.metadataStore.getIndexStats = vi.fn(async () => indexedStats);
    const runtime = await initializeNexusRuntime(options);

    expect(options.pipeline.reindex).not.toHaveBeenCalled();
    expect(options.eventQueue?.isPostScanActive()).toBe(false);
    await runtime.close();
  });

  it('auto-indexes an indexed project with a persisted failure', async () => {
    const options = makeOptions();
    options.metadataStore.getIndexStats = vi.fn(async () => ({
      ...indexedStats,
      lastError: 'previous startup failure',
    }));

    const runtime = await initializeNexusRuntime(options);

    expect(options.pipeline.reindex).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('auto-indexes when the stats row exists but lastIndexedAt is null', async () => {
    const options = makeOptions();
    options.metadataStore.getIndexStats = vi.fn(async () => ({
      ...indexedStats,
      lastIndexedAt: null,
    }));
    const runtime = await initializeNexusRuntime(options);

    expect(options.pipeline.reindex).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('waits for the background reindex before stopping the pipeline', async () => {
    let releaseReindex: (() => void) | undefined;
    const reindexDone = new Promise<void>((resolve) => {
      releaseReindex = resolve;
    });
    const shutdownOrder: string[] = [];
    const options = makeOptions();
    const reindex = vi.fn(async () => {
      shutdownOrder.push('reindex-started');
      await reindexDone;
      shutdownOrder.push('reindex-finished');
      return reindexResult;
    });
    options.pipeline.reindex = reindex;
    options.pipeline.stop = vi.fn(async () => {
      shutdownOrder.push('pipeline-stopped');
    });
    const runtime = await initializeNexusRuntime(options);

    const closePromise = runtime.close();
    await tick();
    expect(shutdownOrder).toEqual(['reindex-started']);
    expect(options.pipeline.stop).not.toHaveBeenCalled();

    releaseReindex?.();
    await closePromise;
    expect(shutdownOrder).toEqual([
      'reindex-started',
      'reindex-finished',
      'pipeline-stopped',
    ]);
    expect(options.pipeline.stop).toHaveBeenCalledOnce();
  });

  it('keeps shared runtime resources open until the background reindex settles', async () => {
    let releaseReindex: (() => void) | undefined;
    const reindexDone = new Promise<void>((resolve) => {
      releaseReindex = resolve;
    });
    const options = makeOptions();
    const onClose = vi.fn(async () => undefined);
    options.onClose = onClose;
    options.pipeline.reindex = vi.fn(async () => {
      await reindexDone;
      return reindexResult;
    });
    const runtime = await initializeNexusRuntime(options);

    const closePromise = runtime.close();
    await tick();

    expect(options.watcher.stop).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();

    releaseReindex?.();
    await closePromise;

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('drains buffered events after a failed auto-index', async () => {
    const options = makeOptions();
    const eventQueue = options.eventQueue!;
    const reindex = vi.fn(async () => {
      throw new Error('startup index failed');
    });
    options.pipeline.reindex = reindex;
    const runtime = await initializeNexusRuntime(options);

    eventQueue.enqueue({ type: 'added', filePath: 'during.ts', detectedAt: new Date().toISOString() });
    await tick();
    expect(eventQueue.isPostScanActive()).toBe(false);
    expect(eventQueue.getPostScanQueueSize()).toBe(0);
    await runtime.close();
  });

  it('drains buffered events after an incomplete auto-index', async () => {
    const options = makeOptions();
    const eventQueue = options.eventQueue!;
    let releaseReindex: (() => void) | undefined;
    const reindexDone = new Promise<void>((resolve) => {
      releaseReindex = resolve;
    });
    options.pipeline.reindex = vi.fn(async () => {
      await reindexDone;
      return { status: 'incomplete' as const };
    });
    const runtime = await initializeNexusRuntime(options);

    eventQueue.enqueue({ type: 'added', filePath: 'during.ts', detectedAt: new Date().toISOString() });
    expect(eventQueue.getPostScanQueueSize()).toBe(1);
    releaseReindex?.();
    await tick();
    expect(eventQueue.isPostScanActive()).toBe(false);
    expect(eventQueue.getPostScanQueueSize()).toBe(0);
    expect(eventQueue.size()).toBe(1);
    await runtime.close();
  });

  it('waits for an active reindex before draining the post-scan queue', async () => {
    const options = makeOptions();
    const eventQueue = options.eventQueue!;
    let releaseActiveReindex: (() => void) | undefined;
    const activeReindexDone = new Promise<void>((resolve) => {
      releaseActiveReindex = resolve;
    });
    options.pipeline.reindex = vi.fn(async () => ({ status: 'already_running' as const }));
    options.pipeline.waitForActiveReindex = vi.fn(() => activeReindexDone);
    const runtime = await initializeNexusRuntime(options);

    eventQueue.enqueue({ type: 'added', filePath: 'during.ts', detectedAt: new Date().toISOString() });
    await tick();
    expect(eventQueue.isPostScanActive()).toBe(true);
    expect(eventQueue.getPostScanQueueSize()).toBe(1);

    releaseActiveReindex?.();
    await tick();
    expect(eventQueue.isPostScanActive()).toBe(false);
    expect(eventQueue.getPostScanQueueSize()).toBe(0);
    expect(eventQueue.size()).toBe(1);
    await runtime.close();
  });

  it('does not start the automatic reindex twice in one runtime', async () => {
    const options = makeOptions();
    const runtime = await initializeNexusRuntime(options);

    await runtime.initialize();
    expect(options.pipeline.reindex).toHaveBeenCalledOnce();
    await runtime.close();
  });
});
