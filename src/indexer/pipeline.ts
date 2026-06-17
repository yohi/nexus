import { readFile, stat as fsStat } from 'node:fs/promises';
import { Mutex, E_ALREADY_LOCKED, tryAcquire } from 'async-mutex';
import pLimit from 'p-limit';

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
  type CodeChunk,
  type IndexEvent,
  type RuntimeInitializationResult,
  type ReindexResult,
  type DeadLetterEntry,
  type IIndexPipeline,
  type PipelineProgress,
  type RetryExhaustedError,
} from '../types/index.js';

interface IndexPipelineOptions {
  metadataStore: IMetadataStore;
  vectorStore: IVectorStore;
  chunker: Chunker;
  embeddingProvider: EmbeddingProvider;
  pluginRegistry: PluginRegistry;
  eventQueue?: EventQueue;
  maxFileBytes?: number;
  chunkConcurrency?: number;
  embedBatchWindowSize?: number;
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

interface FileWork {
  event: IndexEvent;
  chunks: CodeChunk[];
  skipped: boolean;
  skipReason?: string;
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
  private readonly chunkConcurrency: number;
  private readonly embedBatchWindowSize: number;

  private progress: PipelineProgress = {
    totalFiles: 0,
    processedFiles: 0,
    status: 'idle',
  };

  constructor(private readonly options: IndexPipelineOptions) {
    this.merkleTree = new MerkleTree(options.metadataStore);
    this.chunkConcurrency = options.chunkConcurrency ?? 2;
    this.embedBatchWindowSize = Math.max(1, options.embedBatchWindowSize ?? 16);
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

    const pending: IndexEvent[] = [];
    for (const event of events) {
      if (consumedEvents.has(event)) {
        continue;
      }

      if (event.type === 'deleted') {
        this.progress.currentFile = event.filePath;
        await this.handleDeleteEvent(event.filePath);
        this.progress.processedFiles++;
        continue;
      }

      pending.push(event);
    }

    if (pending.length > 0 && loadContent === undefined) {
      throw new Error('loadContent is required for added/modified events');
    }

    for (let windowStart = 0; windowStart < pending.length; windowStart += this.embedBatchWindowSize) {
      if (this.abortController.signal.aborted) {
        break;
      }
      const window = pending.slice(windowStart, windowStart + this.embedBatchWindowSize);
      chunksIndexed += await this.processEventWindow(window, loadContent as ContentLoader);
    }

    this.progress.currentFile = undefined;
    this.safeNotifyMetrics((h) => { h.onChunksIndexed(chunksIndexed); });
    return { chunksIndexed };
  }

  private async readAndChunkFile(
    event: IndexEvent,
    loadContent: ContentLoader,
  ): Promise<FileWork> {
    let fileSize: number | undefined;
    try {
      const fileStat = await fsStat(event.filePath);
      fileSize = fileStat.size;
    } catch {
      // File might not exist on disk, or we are in a test environment with a custom loadContent.
    }

    if (fileSize !== undefined && this.options.maxFileBytes !== undefined && fileSize > this.options.maxFileBytes) {
      return { event, chunks: [], skipped: true, skipReason: `file too large: ${fileSize} bytes` };
    }

    const content = await loadContent(event.filePath);
    const bytes = fileSize ?? Buffer.byteLength(content, 'utf8');
    if (this.options.maxFileBytes !== undefined && bytes > this.options.maxFileBytes) {
      return { event, chunks: [], skipped: true, skipReason: `file too large: ${bytes} bytes` };
    }

    const chunks = await this.options.chunker.chunkFiles([
      {
        filePath: event.filePath,
        language: this.detectLanguage(event.filePath),
        content,
      },
    ]);
    return { event, chunks, skipped: false };
  }

  /**
   * Processes a window of added/modified events as a 3-stage pipeline:
   *  Stage 1: read + chunk files concurrently (no shared-state writes).
   *  Stage 2: a single cross-file embed() call for all chunks in the window.
   *  Stage 3: serial per-file upsert + merkleTree.update (merkleTree.update is NOT concurrency-safe).
   */
  private async processEventWindow(
    window: IndexEvent[],
    loadContent: ContentLoader,
  ): Promise<number> {
    // Stage 1: bounded-concurrency read + chunk (no Merkle/vector writes here).
    const limit = pLimit(this.chunkConcurrency);
    const works = await Promise.all(
      window.map((event) => limit(async () => this.readAndChunkFile(event, loadContent))),
    );

    // Stage 2: aggregate chunks across files into a single embed() call.
    const toEmbed = works.filter((work) => !work.skipped && work.chunks.length > 0);
    const allChunks = toEmbed.flatMap((work) => work.chunks);

    let allEmbeddings: number[][] = [];
    let embedError: RetryExhaustedError | undefined;
    if (allChunks.length > 0) {
      try {
        allEmbeddings = await this.options.embeddingProvider.embed(allChunks.map((chunk) => chunk.content));
      } catch (error) {
        if (error instanceof Error && error.name === 'RetryExhaustedError') {
          embedError = error as RetryExhaustedError;
        } else {
          // DimensionMismatchError and any other unexpected error abort the pipeline.
          this.progress.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
      if (embedError === undefined && allEmbeddings.length !== allChunks.length) {
        const msg = `Embedding count mismatch: expected ${allChunks.length}, got ${allEmbeddings.length}`;
        this.progress.lastError = msg;
        throw new Error(msg);
      }
    }

    // Stage 3: serial per-file finalization (Merkle + vector writes must not run concurrently).
    let chunksIndexed = 0;
    let embeddingOffset = 0;
    for (const work of works) {
      if (this.abortController.signal.aborted) {
        break;
      }
      this.progress.currentFile = work.event.filePath;

      if (work.skipped) {
        this.safeLogProgress(
          `Skipping (${work.skipReason ?? 'file skipped'}): ${work.event.filePath}`,
          work.event.filePath,
        );
        this.skippedFiles.set(work.event.filePath, work.skipReason ?? 'file skipped');
        await this.options.vectorStore.deleteByFilePath(work.event.filePath);
        await this.merkleTree.update(work.event.filePath, work.event.contentHash ?? '');
        this.progress.processedFiles++;
        continue;
      }

      if (work.chunks.length === 0) {
        // Valid file that produced no chunks (e.g. empty file): drop stale vectors, keep Merkle current.
        await this.options.vectorStore.deleteByFilePath(work.event.filePath);
        await this.merkleTree.update(work.event.filePath, work.event.contentHash ?? '');
        this.skippedFiles.delete(work.event.filePath);
        this.progress.processedFiles++;
        continue;
      }

      if (embedError !== undefined) {
        // The window's shared embed batch failed; route every embedded file to the DLQ.
        this.skippedFiles.set(work.event.filePath, embedError.message);
        await this.deadLetterQueue.enqueue({
          filePath: work.event.filePath,
          contentHash: work.event.contentHash ?? '',
          errorMessage: embedError.message,
          attempts: embedError.attempts,
        });
        this.progress.processedFiles++;
        continue;
      }

      const embeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + work.chunks.length);
      embeddingOffset += work.chunks.length;
      await this.options.vectorStore.upsertChunks(work.chunks, embeddings, [work.event.filePath]);
      await this.merkleTree.update(work.event.filePath, work.event.contentHash ?? '');
      this.skippedFiles.delete(work.event.filePath);
      chunksIndexed += work.chunks.length;
      this.progress.processedFiles++;
    }

    return chunksIndexed;
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

    const embeddings = await this.options.embeddingProvider.embed(chunks.map((chunk) => chunk.content));
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
    let fileSize: number | undefined;
    if (this.options.maxFileBytes !== undefined) {
      try {
        const fileStat = await fsStat(entry.filePath);
        fileSize = fileStat.size;
        if (fileSize > this.options.maxFileBytes) {
          this.safeLogProgress(
            `Skipping reprocess (file too large: ${fileSize} bytes > ${this.options.maxFileBytes} limit): ${entry.filePath}`,
            entry.filePath,
          );
          this.skippedFiles.set(entry.filePath, `file too large: ${fileSize} bytes`);
          await this.options.vectorStore.deleteByFilePath(entry.filePath);
          await this.merkleTree.update(entry.filePath, entry.contentHash);
          return;
        }
      } catch {
        // Fallback to checking size after reading.
      }
    }
    const content = await readFile(entry.filePath, 'utf8');
    const bytes = fileSize ?? Buffer.byteLength(content, 'utf8');
    if (this.options.maxFileBytes !== undefined && bytes > this.options.maxFileBytes) {
      this.safeLogProgress(
        `Skipping reprocess (file too large: ${bytes} bytes > ${this.options.maxFileBytes} limit): ${entry.filePath}`,
        entry.filePath,
      );
      this.skippedFiles.set(entry.filePath, `file too large: ${bytes} bytes`);
      await this.options.vectorStore.deleteByFilePath(entry.filePath);
      await this.merkleTree.update(entry.filePath, entry.contentHash);
      return;
    }
    await this.indexFile(entry.filePath, content, entry.contentHash);
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
