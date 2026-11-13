import { describe, expect, it, vi } from 'vitest';

import { EventQueue } from '../../../src/indexer/event-queue.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import type {
  CompactionResult,
  DeadLetterEntry,
  EmbeddingConfig,
  IndexEvent,
  ReindexOptions,
} from '../../../src/types/index.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

class CompactionFailingVectorStore extends InMemoryVectorStore {
  override async compactAfterReindex(): Promise<CompactionResult> {
    throw new Error('compact failed');
  }
}

const makePipeline = async (
  onProgress?: (message: string) => void,
  embeddingConfig?: EmbeddingConfig,
) => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
    onProgress,
    ...(embeddingConfig === undefined ? {} : { embeddingConfig }),
  });
  return { pipeline, metadataStore, vectorStore };
};

const makeDlqEntry = (overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry => ({
  id: overrides.id ?? 'dlq-1',
  filePath: overrides.filePath ?? 'failed.ts',
  contentHash: overrides.contentHash ?? 'hash',
  errorMessage: overrides.errorMessage ?? 'embed failed',
  attempts: overrides.attempts ?? 1,
  recoveryAttempts: overrides.recoveryAttempts ?? 0,
  createdAt: overrides.createdAt ?? '2026-08-20T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? overrides.createdAt ?? '2026-08-20T00:00:00.000Z',
  lastRetryAt: overrides.lastRetryAt ?? null,
});

const scanNoFiles = async (_options?: { fullScan?: boolean; reason?: ReindexOptions['reason'] }): Promise<IndexEvent[]> => [];
const loadContent = async (_filePath: string): Promise<string> => '';

describe('IndexPipeline completion recording', () => {
  it('initializes an empty structured catalog as idle before auditing a reindex', async () => {
    const { metadataStore } = await makePipeline();

    await metadataStore.bootstrapStructuredSchema();

    await expect(metadataStore.getStructuredIndexState()).resolves.toMatchObject({
      schemaVersion: 1,
      rebuildState: 'idle',
      reindexRequired: false,
    });
  });

  it('records both index timestamps after a successful full reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats).not.toBeNull();
    expect(stats?.lastIndexedAt).not.toBeNull();
    expect(stats?.lastFullScanAt).not.toBeNull();
  });

  it('preserves lastFullScanAt during a successful normal reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');
    const fullScanAt = (await metadataStore.getIndexStats())?.lastFullScanAt;
    await pipeline.reindex(scanNoFiles, loadContent, false, 'manual');

    expect((await metadataStore.getIndexStats())?.lastFullScanAt).toBe(fullScanAt);
  });

  it('leaves lastFullScanAt null for a first normal reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await pipeline.reindex(scanNoFiles, loadContent, false, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats?.lastIndexedAt).not.toBeNull();
    expect(stats?.lastFullScanAt).toBeNull();
  });

  it('returns incomplete and skips completion recording when DLQ entries remain', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    await metadataStore.upsertDeadLetterEntries([
      makeDlqEntry({ id: 'dlq-1', errorMessage: 'embed failed', createdAt: '2026-08-20T00:00:00.000Z' }),
    ]);

    const result = await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect(result).toEqual({ status: 'incomplete' });
    await expect(metadataStore.getIndexStats()).resolves.toMatchObject({
      lastIndexedAt: null,
      lastError: 'Full reindex incomplete: 1 dead-letter queue item(s) remain',
    });
    expect(pipeline.getProgress().lastError).toBe(
      'Full reindex incomplete: 1 dead-letter queue item(s) remain',
    );
    expect(pipeline.getSkippedFiles().get('failed.ts')).toBe('embed failed');
  });

  it('does not record completion when scanning throws', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await expect(
      pipeline.reindex(async () => {
        throw new Error('scan failed');
      }, loadContent, true, 'manual'),
    ).rejects.toThrow('scan failed');

    await expect(metadataStore.getIndexStats()).resolves.toMatchObject({
      lastIndexedAt: null,
      lastError: 'scan failed',
    });
  });

  it('persists a failure state when scanning throws', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await expect(
      pipeline.reindex(async () => {
        throw new Error('scan failed');
      }, loadContent, true, 'startup-reconciliation'),
    ).rejects.toThrow('scan failed');

    await expect(metadataStore.getIndexStats()).resolves.toMatchObject({
      lastIndexedAt: null,
      lastError: 'scan failed',
    });
  });

  it('keeps the full-scan queue gated when clearing a persisted error fails', async () => {
    const { pipeline, metadataStore } = await makePipeline(undefined, {
      provider: 'test', model: 'test-model', dimensions: 64, maxConcurrency: 1,
      batchSize: 1, retryCount: 0, retryBaseDelayMs: 0,
    });
    await metadataStore.bootstrapStructuredSchema();
    await metadataStore.setIndexStats({
      id: 'primary',
      totalFiles: 0,
      totalChunks: 0,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      lastFullScanAt: null,
      overflowCount: 0,
      lastError: 'previous failure',
    });
    const eventQueue = new EventQueue({
      debounceMs: 0,
      maxQueueSize: 10,
      fullScanThreshold: 10,
      concurrency: 1,
    });
    pipeline.setEventQueue(eventQueue);
    const markFullScanComplete = vi.spyOn(eventQueue, 'markFullScanComplete');
    vi.spyOn(metadataStore, 'setIndexStats').mockRejectedValueOnce(new Error('clear failed'));

    await expect(pipeline.reindex(scanNoFiles, loadContent, true, 'manual')).rejects.toThrow('clear failed');

    expect(pipeline.getProgress().status).toBe('idle');
    expect(markFullScanComplete).not.toHaveBeenCalled();
  });

  it('clears a persisted failure state when a retry starts', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    await metadataStore.setIndexStats({
      id: 'primary',
      totalFiles: 0,
      totalChunks: 0,
      lastIndexedAt: null,
      lastFullScanAt: null,
      overflowCount: 0,
      lastError: 'previous failure',
    });

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    await expect(metadataStore.getIndexStats()).resolves.toMatchObject({ lastError: null });
  });

  it('logs the reindex reason when scanning throws', async () => {
    const logs: string[] = [];
    const { pipeline } = await makePipeline((message) => logs.push(message));

    await expect(
      pipeline.reindex(async () => {
        throw new Error('scan failed');
      }, loadContent, true, 'startup-reconciliation'),
    ).rejects.toThrow('scan failed');

    expect(logs).toContain('Reindex failed (startup-reconciliation): scan failed');
  });

  it('records completion when compaction fails', async () => {
    const { metadataStore, chunker, registry } = await createPipeline();
    const vectorStore = new CompactionFailingVectorStore({ dimensions: 64 });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect((await metadataStore.getIndexStats())?.lastIndexedAt).not.toBeNull();
  });

  it('uses the newest DLQ error for duplicate file paths', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    await metadataStore.upsertDeadLetterEntries([
      makeDlqEntry({
        id: 'dlq-old',
        filePath: 'shared.ts',
        errorMessage: 'old error',
        createdAt: '2026-08-20T00:00:00.000Z',
      }),
      makeDlqEntry({
        id: 'dlq-new',
        filePath: 'shared.ts',
        errorMessage: 'new error',
        createdAt: '2026-08-20T00:00:01.000Z',
      }),
    ]);

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect(pipeline.getSkippedFiles().get('shared.ts')).toBe('new error');
  });

  it('passes the reindex reason to the scan callback', async () => {
    const { pipeline } = await makePipeline();
    let receivedReason: ReindexOptions['reason'];

    await pipeline.reindex(async (options) => {
      receivedReason = options?.reason;
      return [];
    }, loadContent, true, 'startup-reconciliation');

    expect(receivedReason).toBe('startup-reconciliation');
  });
});
