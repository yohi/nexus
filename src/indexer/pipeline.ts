import { readFile } from 'node:fs/promises';
import { Mutex, E_ALREADY_LOCKED, tryAcquire } from 'async-mutex';

import { DeadLetterQueue } from './dead-letter-queue.js';
import { MerkleTree } from './merkle-tree.js';
import { computeFileHashStreaming } from './hash.js';
import type { Chunker } from './chunker.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { EventQueue } from './event-queue.js';
import type { MetricsHooks } from '../observability/types.js';
import {
  type EmbeddingProvider,
  type IMetadataStore,
  type IVectorStore,
  type IndexEvent,
  type RuntimeInitializationResult,
  type ReindexResult,
  type DeadLetterEntry,
  type IIndexPipeline,
  type PipelineProgress,
  RetryExhaustedError,
} from '../types/index.js';

interface IndexPipelineOptions {
  metadataStore: IMetadataStore;
  vectorStore: IVectorStore;
  chunker: Chunker;
  embeddingProvider: EmbeddingProvider;
  pluginRegistry: PluginRegistry;
  eventQueue?: EventQueue;
  onProgress?: (msg: string) => void;
  metricsHooks?: Pick<
    MetricsHooks,
    | 'onChunksIndexed'
    | 'onReindexComplete'
    | 'onDlqSnapshot'
    | 'onRecoverySweepComplete'
  >;
}

interface ProcessEventsResult {
  chunksIndexed: number;
}

type ContentLoader = (filePath: string) => Promise<string>;

export class IndexPipeline implements IIndexPipeline {
  private readonly merkleTree: MerkleTree;

  private readonly mutex = new Mutex();

  private readonly skippedFiles = new Map<string, string>();

  private readonly deadLetterQueue: DeadLetterQueue;

  private dlqStopper: (() => Promise<void>) | undefined;

  private isTreeLoaded = false;

  private abortController = new AbortController();
  private idleCompactionTimer: NodeJS.Timeout | undefined;

  private progress: PipelineProgress = {
    totalFiles: 0,
    processedFiles: 0,
    status: 'idle',
  };

  constructor(private readonly options: IndexPipelineOptions) {
    this.merkleTree = new MerkleTree(options.metadataStore);
    this.deadLetterQueue = new DeadLetterQueue({
      metadataStore: options.metadataStore,
      embeddingHealthy: () => this.embeddingHealthy(),
      computeFileHash: (path) => this.computeFileHash(path),
      reprocess: (entry) => this.reprocess(entry),
      metricsHooks: options.metricsHooks,
    });
  }

  private safeNotifyMetrics(fn: (hooks: NonNullable<IndexPipelineOptions['metricsHooks']>) => void): void {
    const { metricsHooks } = this.options;
    if (!metricsHooks) return;
    try {
      fn(metricsHooks);
    } catch (err) {
      console.warn('[Nexus Pipeline] Metrics hook failed:', err);
    }
  }

  start(): void {
    if (this.dlqStopper === undefined) {
      this.dlqStopper = this.deadLetterQueue.startRecoveryLoop();
    }

    if (this.idleCompactionTimer !== undefined) {
      clearTimeout(this.idleCompactionTimer);
    }

    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }

    this.idleCompactionTimer = this.options.vectorStore.scheduleIdleCompaction(
      async () => {
        await this.options.vectorStore.compactIfNeeded();
      },
      300_000,
      { waitForUnlock: () => this.mutex.waitForUnlock() },
      this.abortController.signal,
    );
    this.idleCompactionTimer.unref();
  }

  async stop(): Promise<void> {
    this.progress.status = 'stopping';
    this.abortController.abort();

    if (this.idleCompactionTimer !== undefined) {
      clearTimeout(this.idleCompactionTimer);
      this.idleCompactionTimer = undefined;
    }

    if (this.dlqStopper !== undefined) {
      await this.dlqStopper();
      this.dlqStopper = undefined;
    }

    await this.options.vectorStore.close();
    this.progress.status = 'idle';
  }

  private safeLogProgress(msg: string, filePath?: string): void {
    if (!this.options.onProgress) return;
    try {
      this.options.onProgress(msg);
    } catch (error) {
      const context = filePath ? ` for ${filePath}` : '';
      console.error(`[IndexPipeline] Progress logging failed${context}:`, error);
    }
  }

  async processEvents(
    events: IndexEvent[],
    loadContent?: ContentLoader,
  ): Promise<ProcessEventsResult> {
    if (!this.isTreeLoaded) {
      await this.merkleTree.load();
      this.isTreeLoaded = true;
    }

    let chunksIndexed = 0;
    const renameCandidates = MerkleTree.detectRenameCandidates(events);
    const consumedEvents = new Set<IndexEvent>();

    for (const candidate of renameCandidates) {
      const affected = await this.options.vectorStore.renameFilePath(candidate.oldPath, candidate.newPath);
      if (affected > 0) {
        await this.merkleTree.move(candidate.oldPath, candidate.newPath, candidate.hash);
        consumedEvents.add(candidate.oldEvent);
        consumedEvents.add(candidate.newEvent);
      }
    }

    for (const event of events) {
      if (consumedEvents.has(event)) {
        continue;
      }

      this.progress.currentFile = event.filePath;

      if (event.type === 'deleted') {
        await this.handleDeleteEvent(event.filePath);
        this.progress.processedFiles++;
        continue;
      }

      if (loadContent === undefined) {
        throw new Error('loadContent is required for added/modified events');
      }

      try {
        const content = await loadContent(event.filePath);
        const count = await this.indexFile(event.filePath, content, event.contentHash ?? '');
        chunksIndexed += count;
      } catch (error) {
        if (error instanceof Error && error.name === 'RetryExhaustedError') {
          this.skippedFiles.set(event.filePath, error.message);
          await this.deadLetterQueue.enqueue({
            filePath: event.filePath,
            contentHash: event.contentHash ?? '',
            errorMessage: error.message,
            attempts: (error as RetryExhaustedError).attempts,
          });
          this.progress.processedFiles++;
          continue;
        }

        this.progress.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      this.progress.processedFiles++;
    }

    this.progress.currentFile = undefined;
    this.safeNotifyMetrics((h) => { h.onChunksIndexed(chunksIndexed); });
    return { chunksIndexed };
  }

  private async handleDeleteEvent(filePath: string): Promise<void> {
    const existingNode = await this.options.metadataStore.getMerkleNode(filePath);
    if (existingNode?.isDirectory) {
      const prefix = filePath.endsWith('/') ? filePath : filePath + '/';
      await this.options.vectorStore.deleteByPathPrefix(prefix);
      await this.options.metadataStore.deleteSubtree(filePath);

      // Incremental update of the tree (avoids full reload)
      await this.merkleTree.remove(filePath);

      this.skippedFiles.delete(filePath);
      await this.deadLetterQueue.removeByPathPrefix(filePath);
      for (const path of this.skippedFiles.keys()) {
        if (path.startsWith(prefix)) {
          this.skippedFiles.delete(path);
        }
      }
    } else {
      await this.options.vectorStore.deleteByFilePath(filePath);
      await this.merkleTree.remove(filePath);
      this.skippedFiles.delete(filePath);
      await this.deadLetterQueue.removeByFilePath(filePath);
    }
  }

  async reindex(
    run: (options?: { fullScan?: boolean; reason?: 'manual' }) => Promise<IndexEvent[]>,
    loadContent: ContentLoader,
    fullRebuild?: boolean,
  ): Promise<ReindexResult | { status: 'already_running' }> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    try {
      return await tryAcquire(this.mutex).runExclusive(async () => {
        this.progress.status = 'running';
        this.progress.processedFiles = 0;
        this.progress.totalFiles = 0;
        this.progress.lastError = undefined;

        this.safeLogProgress(`Starting reindex (fullRebuild: ${!!fullRebuild})`);
        try {
          const events = await run({ fullScan: fullRebuild, reason: 'manual' });
          this.progress.totalFiles = events.length;

          const { chunksIndexed } = await this.processEvents(events, loadContent);

          const finishedAt = new Date().toISOString();
          const durationMs = Date.now() - startTime;

          const reconciliation = {
            added: events.filter((e) => e.type === 'added').length,
            modified: events.filter((e) => e.type === 'modified').length,
            deleted: events.filter((e) => e.type === 'deleted').length,
            unchanged: 0,
          };

          try {
            await this.options.vectorStore.compactAfterReindex();
          } catch (compactionError) {
            console.error('Post-reindex compaction failed (non-fatal):', compactionError);
          }

          this.safeNotifyMetrics((h) => { h.onReindexComplete(durationMs, !!fullRebuild); });

          this.progress.status = 'idle';
          return {
            startedAt,
            finishedAt,
            durationMs,
            reconciliation,
            chunksIndexed,
          };
        } catch (error) {
          this.progress.status = 'idle';
          this.progress.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (fullRebuild && this.options.eventQueue) {
            this.options.eventQueue.markFullScanComplete();
          }
        }
      });
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        return { status: 'already_running' as const };
      }
      throw e;
    }
  }

  getProgress(): PipelineProgress {
    return { ...this.progress };
  }

  async reconcileOnStartup(): Promise<RuntimeInitializationResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    if (!this.isTreeLoaded) {
      await this.merkleTree.load();
      this.isTreeLoaded = true;
    }

    const finishedAt = new Date().toISOString();

    return {
      startedAt,
      finishedAt,
      durationMs: Date.now() - startTime,
      reconciliation: {
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 0,
      },
      chunksIndexed: 0,
    };
  }

  getSkippedFiles(): ReadonlyMap<string, string> {
    return this.skippedFiles;
  }

  private async indexFile(filePath: string, content: string, contentHash: string): Promise<number> {
    this.safeLogProgress(`Indexing: ${filePath}`, filePath);
    const chunks = await this.options.chunker.chunkFiles([
      {
        filePath,
        language: this.detectLanguage(filePath),
        content,
      },
    ]);

    const embeddings = await this.embedWithRetry(chunks.map((chunk) => chunk.content));
    await this.options.vectorStore.upsertChunks(chunks, embeddings, [filePath]);
    await this.merkleTree.update(filePath, contentHash);
    this.skippedFiles.delete(filePath);

    this.safeLogProgress(`Finished indexing: ${filePath} (${chunks.length} chunks)`, filePath);

    return chunks.length;
  }

  private async embeddingHealthy(): Promise<boolean> {
    return this.options.embeddingProvider.healthCheck();
  }

  private async computeFileHash(filePath: string): Promise<string> {
    return computeFileHashStreaming(filePath);
  }

  private async reprocess(entry: DeadLetterEntry): Promise<void> {
    const content = await readFile(entry.filePath, 'utf8');
    await this.indexFile(entry.filePath, content, entry.contentHash);
  }

  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    const maxAttempts = 3;
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.options.embeddingProvider.embed(texts);
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new RetryExhaustedError(
            error instanceof Error ? error.message : String(error),
            maxAttempts,
          );
        }
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Unreachable');
  }

  private detectLanguage(filePath: string): string {
    const plugin = this.options.pluginRegistry.getLanguagePlugin(filePath);
    if (plugin) {
      return plugin.languageId;
    }

    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      return 'typescript';
    }

    return 'text';
  }
}
