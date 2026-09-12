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
  type ChunkWithEmbedding,
  type LegacyShadowTable,
  type IndexEvent,
  type RuntimeInitializationResult,
  type ReindexResult,
  type DeadLetterEntry,
  type IIndexPipeline,
  type PipelineProgress,
  type RetryExhaustedError,
  type EmbeddingCacheEntry,
  type IndexStatsRow,
  type ReindexOptions,
} from '../types/index.js';
import type { StructuredSource, StructuredDeclaration, StructuredImport } from '../structured/contracts.js';
import type { FullRebuildFile, StructuredIndexCoordinator } from './structured-index-coordinator.js';
import { decodeUtf8, sha256Hex } from '../structured/hash.js';

type ContentLoader = (filePath: string) => Promise<string>;
type FileBytesLoader = (filePath: string) => Promise<Uint8Array>;

interface IndexPipelineOptions {
  metadataStore: IMetadataStore;
  vectorStore: IVectorStore;
  chunker: Chunker;
  embeddingProvider: EmbeddingProvider;
  pluginRegistry: PluginRegistry;
  structuredIndexCoordinator?: StructuredIndexCoordinator;
  loadFileBytes?: FileBytesLoader;
  eventQueue?: EventQueue;
  maxFileBytes?: number;
  chunkConcurrency?: number;
  embedBatchWindowSize?: number;
  /** Maximum number of chunk embeddings to keep in the in-memory LRU cache. 0 = disabled. Default: 10_000. */
  embeddingCacheSize?: number;
  onProgress?: (msg: string) => void;
  metricsHooks?: Pick<
    MetricsHooks,
    | 'onChunksIndexed'
    | 'onReindexComplete'
    | 'onDlqSnapshot'
    | 'onRecoverySweepComplete'
    | 'onIndexingProgress'
  >;
  completionLock?: Mutex;
}

interface ProcessEventsResult {
  chunksIndexed: number;
  structuredParseFailures: readonly string[];
  embeddingFailures: readonly string[];
}

interface ProcessEventWindowResult {
  chunksIndexed: number;
  embeddingFailures: readonly string[];
}

interface StructuredFileWork {
  source: StructuredSource;
  generationId: string;
  contentHash: string;
  fileCompleteness: 'complete' | 'partial';
  declarations: StructuredDeclaration[];
  imports: StructuredImport[];
  parserId: string;
  parserVersion: string;
  chunks: CodeChunk[];
}

type StructuredReadResult =
  | { kind: 'work'; work: StructuredFileWork }
  | { kind: 'retire' }
  | { kind: 'parse-failed' };

/** A Merkle mutation deferred until the full-rebuild commit boundary. */
type DeferredMerkleOp =
  | { kind: 'update'; filePath: string; contentHash: string }
  | { kind: 'remove'; filePath: string }
  | { kind: 'subtree-delete'; filePath: string };

interface FileWork {
  event: IndexEvent;
  chunks: CodeChunk[];
  structured?: StructuredFileWork;
  structuredRetirement: boolean;
  structuredParseFailed: boolean;
  skipped: boolean;
  skipReason?: string;
}

export class IndexPipeline implements IIndexPipeline {
  private readonly merkleTree: MerkleTree;

  private readonly mutex = new Mutex();

  private readonly skippedFiles = new Map<string, string>();

  private readonly deadLetterQueue: DeadLetterQueue;

  private readonly completionLock: Mutex;

  private eventQueue: EventQueue | undefined;

  private dlqStopper: (() => Promise<void>) | undefined;

  private isTreeLoaded = false;

  private abortController = new AbortController();
  private idleCompactionTimer: NodeJS.Timeout | undefined;
  private readonly chunkConcurrency: number;
  private readonly embedBatchWindowSize: number;
  /** chunk content-hash → embedding vector (LRU eviction when at capacity) */
  private readonly embeddingCache: Map<string, number[]>;
  private readonly embeddingCacheSize: number;

  private progress: PipelineProgress = {
    totalFiles: 0,
    processedFiles: 0,
    status: 'idle',
  };

  constructor(private readonly options: IndexPipelineOptions) {
    this.merkleTree = new MerkleTree(options.metadataStore);
    this.chunkConcurrency = options.chunkConcurrency ?? 2;
    this.embedBatchWindowSize = Math.max(1, options.embedBatchWindowSize ?? 16);
    this.embeddingCacheSize = options.embeddingCacheSize ?? 10_000;
    this.embeddingCache = new Map<string, number[]>();
    this.completionLock = options.completionLock ?? new Mutex();
    this.eventQueue = options.eventQueue;
    this.deadLetterQueue = new DeadLetterQueue({
      metadataStore: options.metadataStore,
      embeddingHealthy: () => this.embeddingHealthy(),
      computeFileHash: (path) => this.computeFileHash(path),
      reprocess: (entry) => this.reprocess(entry),
      metricsHooks: options.metricsHooks,
      completionLock: this.completionLock,
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

  private getL1Cache(hash: string): number[] | undefined {
    if (this.embeddingCacheSize <= 0) {
      return undefined;
    }
    const cached = this.embeddingCache.get(hash);
    if (cached === undefined) {
      return undefined;
    }
    this.embeddingCache.delete(hash);
    this.embeddingCache.set(hash, cached);
    return cached;
  }

  private setL1Cache(hash: string, vector: number[]): void {
    if (this.embeddingCacheSize <= 0) {
      return;
    }
    if (this.embeddingCache.has(hash)) {
      this.embeddingCache.delete(hash);
      this.embeddingCache.set(hash, vector);
      return;
    }
    if (this.embeddingCache.size >= this.embeddingCacheSize) {
      const oldestKey = this.embeddingCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.embeddingCache.delete(oldestKey);
      }
    }
    this.embeddingCache.set(hash, vector);
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

    await this.waitForActiveReindex();
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
    options: { trackProgress?: boolean; fullRebuild?: boolean } = {},
  ): Promise<ProcessEventsResult> {
    const structuredIndexCoordinator = this.options.structuredIndexCoordinator;
    const useStructuredFullRebuild = options.fullRebuild === true && structuredIndexCoordinator !== undefined;
    const structuredRebuildFiles: FullRebuildFile[] = [];
    const structuredParseFailures: string[] = [];
    if (events.length === 0) {
      if (useStructuredFullRebuild) {
        await structuredIndexCoordinator.runFullRebuild({ files: structuredRebuildFiles });
      }
      return { chunksIndexed: 0, structuredParseFailures: [], embeddingFailures: [] };
    }

    if (!this.isTreeLoaded) {
      await this.merkleTree.load();
      this.isTreeLoaded = true;
    }

    const trackProgress = options.trackProgress ?? true;
    if (trackProgress) {
      this.progress.totalFiles = events.length;
      this.progress.processedFiles = 0;
    }

    let chunksIndexed = 0;
    const embeddingFailures: string[] = [];
    let completedSuccessfully = false;

    let legacyShadow: LegacyShadowTable | undefined;
    const deferredMerkleOps: DeferredMerkleOp[] = [];

    try {
      if (useStructuredFullRebuild) {
        legacyShadow = await this.options.vectorStore.beginLegacyShadowTable();
      }
      const renameCandidates = MerkleTree.detectRenameCandidates(events);
      const consumedEvents = new Set<IndexEvent>();
      let renamedEventCount = 0;

      if (structuredIndexCoordinator === undefined) {
        for (const candidate of renameCandidates) {
          const affected = await this.options.vectorStore.renameFilePath(candidate.oldPath, candidate.newPath);
          if (affected > 0) {
            await this.merkleTree.move(candidate.oldPath, candidate.newPath, candidate.hash);
            consumedEvents.add(candidate.oldEvent);
            consumedEvents.add(candidate.newEvent);
            renamedEventCount += 2;
          }
        }
      }

      if (trackProgress) {
        this.progress.processedFiles += renamedEventCount;
      }

      const pending: IndexEvent[] = [];
      for (const event of events) {
        if (consumedEvents.has(event)) {
          continue;
        }

        if (event.type === 'deleted') {
          if (trackProgress) {
            this.progress.currentFile = event.filePath;
          }
          await this.handleDeleteEvent(event.filePath, useStructuredFullRebuild, legacyShadow, useStructuredFullRebuild ? deferredMerkleOps : undefined);
          if (trackProgress) {
            this.progress.processedFiles++;
            this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, true); });
          }
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
        const windowResult = await this.processEventWindow(
          window,
          loadContent as ContentLoader,
          trackProgress,
          useStructuredFullRebuild ? structuredRebuildFiles : undefined,
          structuredParseFailures,
          useStructuredFullRebuild ? legacyShadow : undefined,
          useStructuredFullRebuild ? deferredMerkleOps : undefined,
        );
        chunksIndexed += windowResult.chunksIndexed;
        embeddingFailures.push(...windowResult.embeddingFailures);
        if (trackProgress) {
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, true); });
        }
        if (trackProgress && this.progress.totalFiles > 1) {
          this.safeLogProgress(`Progress: ${this.progress.processedFiles} / ${this.progress.totalFiles} files`);
        }
      }

      if (useStructuredFullRebuild && !this.abortController.signal.aborted) {
        if (structuredParseFailures.length > 0) {
          if (legacyShadow !== undefined) {
            await this.options.vectorStore.abortLegacyShadowTable(legacyShadow).catch(() => {});
            legacyShadow = undefined;
          }
          const filePaths = [...new Set(structuredParseFailures)].join(', ');
          throw new Error(`Structured full rebuild aborted: parsing failed for ${filePaths}`);
        }
        try {
          await structuredIndexCoordinator.runFullRebuild({ files: structuredRebuildFiles });
          if (legacyShadow !== undefined) {
            await this.options.vectorStore.swapLegacyShadowTable(legacyShadow);
          }
          await this.applyDeferredMerkleOps(deferredMerkleOps);
        } catch (error) {
          if (legacyShadow !== undefined) {
            await this.options.vectorStore.abortLegacyShadowTable(legacyShadow).catch(() => {});
            legacyShadow = undefined;
          }
          throw error;
        }
      }

      completedSuccessfully = !this.abortController.signal.aborted;
      return {
        chunksIndexed,
        structuredParseFailures: [...new Set(structuredParseFailures)],
        embeddingFailures: [...new Set(embeddingFailures)],
      };
    } finally {
      if (legacyShadow !== undefined) {
        await this.options.vectorStore.abortLegacyShadowTable(legacyShadow).catch(() => {});
      }
      if (trackProgress) {
        this.progress.currentFile = undefined;
      }
      this.safeNotifyMetrics((h) => { h.onChunksIndexed(chunksIndexed); });

      if (trackProgress) {
        this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
      }

      if (trackProgress && this.progress.totalFiles > 1) {
        if (completedSuccessfully) {
          this.safeLogProgress(`Completed ${this.progress.processedFiles} / ${this.progress.totalFiles} files`);
        } else if (this.abortController.signal.aborted) {
          this.safeLogProgress(`Cancelled after ${this.progress.processedFiles} / ${this.progress.totalFiles} files`);
        } else {
          this.safeLogProgress(`Failed after ${this.progress.processedFiles} / ${this.progress.totalFiles} files`);
        }
      }
    }
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
      return {
        event,
        chunks: [],
        structuredRetirement: false,
        structuredParseFailed: false,
        skipped: true,
        skipReason: `file too large: ${fileSize} bytes`,
      };
    }

    const sourceBytes = this.options.loadFileBytes === undefined
      ? undefined
      : await this.options.loadFileBytes(event.filePath);
    const content = sourceBytes === undefined
      ? await loadContent(event.filePath)
      : decodeUtf8(sourceBytes);
    const byteLength = sourceBytes?.byteLength ?? Buffer.byteLength(content, 'utf8');
    if (this.options.maxFileBytes !== undefined && byteLength > this.options.maxFileBytes) {
      return {
        event,
        chunks: [],
        structuredRetirement: false,
        structuredParseFailed: false,
        skipped: true,
        skipReason: `file too large: ${byteLength} bytes`,
      };
    }

    const language = this.detectLanguage(event.filePath);
    const chunks = await this.options.chunker.chunkFiles([
      {
        filePath: event.filePath,
        language,
        content,
      },
    ]);

    let structured: StructuredFileWork | undefined;
    let structuredRetirement = false;
    let structuredParseFailed = false;
    if (this.options.structuredIndexCoordinator !== undefined) {
      const structuredResult = await this.readStructuredFile(
        event.filePath,
        language,
        content,
        sourceBytes ?? new Uint8Array(Buffer.from(content, 'utf8')),
      );
      structured = structuredResult?.kind === 'work' ? structuredResult.work : undefined;
      structuredRetirement = structuredResult?.kind === 'retire';
      structuredParseFailed = structuredResult?.kind === 'parse-failed';
    }

    return { event, chunks, structured, structuredRetirement, structuredParseFailed, skipped: false };
  }

  private async readStructuredFile(
    filePath: string,
    language: string,
    content: string,
    bytes: Uint8Array,
  ): Promise<StructuredReadResult | undefined> {
    const plugin = this.options.pluginRegistry.getLanguagePlugin(filePath);
    if (plugin === undefined || plugin.createStructuredParser === undefined) {
      return undefined;
    }

    try {
      const parser = await plugin.createStructuredParser();
      const source: StructuredSource = { filePath, language, bytes, text: content };
      const result = await parser.parseStructured(source);
      if (result.status !== 'ok' && result.status !== 'degraded') {
        return { kind: 'parse-failed' };
      }
      if (result.status === 'degraded' && result.declarations.length === 0) {
        return { kind: 'parse-failed' };
      }
      if (result.status === 'ok' && result.declarations.length === 0 && result.imports.length === 0) {
        return { kind: 'retire' };
      }

      const fileCompleteness = result.retrievability === 'exact' ? 'complete' : 'partial';
      const generation = result.generation ?? {
        generationId: sha256Hex(bytes),
        schemaVersion: 1 as const,
        parserId: plugin.languageId,
        parserVersion: '1',
        fileHash: sha256Hex(bytes),
        fileCompleteness,
      };

      const structuredChunks = await this.options.chunker.chunkStructuredFile(
        { filePath, language, content, bytes },
        { declarations: result.declarations, imports: result.imports },
      );

      return {
        kind: 'work',
        work: {
          source,
          generationId: generation.generationId,
          contentHash: generation.fileHash,
          fileCompleteness: generation.fileCompleteness,
          declarations: [...result.declarations],
          imports: [...result.imports],
          parserId: generation.parserId,
          parserVersion: generation.parserVersion,
          chunks: structuredChunks,
        },
      };
    } catch (error) {
      this.safeLogProgress(
        `Structured parsing failed for ${filePath}: ${error instanceof Error ? error.message : 'unknown'}`,
        filePath,
      );
      return { kind: 'parse-failed' };
    }
  }

  /**
   * Processes a window of added/modified events as a 3-stage pipeline:
   *  Stage 1: read + chunk files concurrently (no shared-state writes).
   *  Stage 2: cache-aware embed — cache hits skip embed(), misses are batched into one embed() call.
   *  Stage 3: serial per-file upsert + merkleTree.update (merkleTree.update is NOT concurrency-safe).
   */
  private async processEventWindow(
    window: IndexEvent[],
    loadContent: ContentLoader,
    trackProgress: boolean,
    structuredRebuildFiles?: FullRebuildFile[],
    structuredParseFailures?: string[],
    legacyShadow?: LegacyShadowTable,
    deferredMerkleOps?: DeferredMerkleOp[],
  ): Promise<ProcessEventWindowResult> {
    // Stage 1: bounded-concurrency read + chunk (no Merkle/vector writes here).
    const limit = pLimit(this.chunkConcurrency);
    const works = await Promise.all(
      window.map((event) => limit(async () => this.readAndChunkFile(event, loadContent))),
    );

    if (structuredParseFailures !== undefined) {
      for (const work of works) {
        if (work.structuredParseFailed) {
          structuredParseFailures.push(work.event.filePath);
        }
      }
    }

    // Stage 2: L1 (memory) + L2 (persistent) cache-aware embed.
    const toEmbed = works.filter((work) => !work.skipped && (work.chunks.length > 0 || (work.structured?.chunks.length ?? 0) > 0));
    const allChunks = toEmbed.flatMap((work) => [
      ...work.chunks,
      ...(work.structured?.chunks ?? []),
    ]);

    // allChunks index → filePath mapping for precise DLQ routing on embed failure.
    const chunkToFilePath = new Map<number, string>();
    let globalChunkIdx = 0;
    for (const work of toEmbed) {
      for (let i = 0; i < work.chunks.length; i++) {
        chunkToFilePath.set(globalChunkIdx, work.event.filePath);
        globalChunkIdx++;
      }
      if (work.structured !== undefined) {
        for (let i = 0; i < work.structured.chunks.length; i++) {
          chunkToFilePath.set(globalChunkIdx, work.event.filePath);
          globalChunkIdx++;
        }
      }
    }
    // L1 cache check.
    const l1Misses: Array<{ index: number; hash: string; text: string }> = [];
    const resolvedEmbeddings: (number[] | undefined)[] = allChunks.map((chunk, i) => {
        const cached = this.getL1Cache(chunk.hash);
        if (cached !== undefined) {
          return cached;
        }
      l1Misses.push({ index: i, hash: chunk.hash, text: chunk.content });
      return undefined;
    });

    // L2 persistent cache check.
    const trueMisses: typeof l1Misses = [];
    if (l1Misses.length > 0) {
      const l2Cached = await this.options.metadataStore.getEmbeddings(l1Misses.map((m) => m.hash));
      for (const miss of l1Misses) {
        const vector = l2Cached.get(miss.hash);
        if (vector !== undefined) {
          resolvedEmbeddings[miss.index] = vector;
          this.setL1Cache(miss.hash, vector);
        } else {
          trueMisses.push(miss);
        }
      }
    }

    let allEmbeddings: number[][] = [];
    let embedError: RetryExhaustedError | undefined;
    const failedFilePaths = new Set<string>();
    if (trueMisses.length > 0) {
      try {
        const missTexts = trueMisses.map((m) => m.text);
        const freshEmbeddings = await this.options.embeddingProvider.embed(missTexts, this.abortController.signal);
        if (freshEmbeddings.length !== missTexts.length) {
          const msg = `Embedding count mismatch: expected ${missTexts.length}, got ${freshEmbeddings.length}`;
          if (trackProgress) {
            this.progress.lastError = msg;
          }
          throw new Error(msg);
        }
        // Write fresh embeddings back into resolvedEmbeddings and both caches.
        const l2Entries: EmbeddingCacheEntry[] = [];
        for (const [k, miss] of trueMisses.entries()) {
          const vec = freshEmbeddings[k];
          if (vec === undefined) {
            continue;
          }
          resolvedEmbeddings[miss.index] = vec;
          this.setL1Cache(miss.hash, vec);
          l2Entries.push({ hash: miss.hash, vector: vec });
        }
        if (l2Entries.length > 0) {
          await this.options.metadataStore.setEmbeddings(l2Entries);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'RetryExhaustedError') {
          embedError = error as RetryExhaustedError;
          for (const miss of trueMisses) {
            const fp = chunkToFilePath.get(miss.index);
            if (fp !== undefined) {
              failedFilePaths.add(fp);
            }
          }
        } else {
          // DimensionMismatchError and any other unexpected error abort the pipeline.
          if (trackProgress) {
            this.progress.lastError = error instanceof Error ? error.message : String(error);
          }
          throw error;
        }
      }
    }

    // Build the flat allEmbeddings array aligned with allChunks (only used in Stage 3).
    allEmbeddings = resolvedEmbeddings as number[][];

    // Stage 3: serial per-file finalization (Merkle + vector writes must not run concurrently).
    let chunksIndexed = 0;
    let embeddingOffset = 0;
    for (const work of works) {
      if (this.abortController.signal.aborted) {
        break;
      }
      if (trackProgress) {
        this.progress.currentFile = work.event.filePath;
      }

      // Extract embeddings and advance offset regardless of skip or DLQ-routing status to keep aligned
      const legacyCount = work.chunks.length;
      const structuredCount = work.structured?.chunks.length ?? 0;
      const workEmbeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + legacyCount + structuredCount);
      embeddingOffset += legacyCount + structuredCount;
      const legacyEmbeddings = workEmbeddings.slice(0, legacyCount);
      const structuredEmbeddings = workEmbeddings.slice(legacyCount);

      if (work.skipped) {
        if (trackProgress) {
          this.safeLogProgress(
            `Skipping (${work.skipReason ?? 'file skipped'}): ${work.event.filePath}`,
            work.event.filePath,
          );
        }
        this.skippedFiles.set(work.event.filePath, work.skipReason ?? 'file skipped');
        if (structuredRebuildFiles === undefined && this.options.structuredIndexCoordinator !== undefined) {
          await this.options.structuredIndexCoordinator.deleteFile({ filePath: work.event.filePath });
        } else if (legacyShadow !== undefined) {
          await this.options.vectorStore.stageLegacyShadowDeletions(legacyShadow, { filePaths: [work.event.filePath] });
        } else {
          await this.options.vectorStore.deleteByFilePath(work.event.filePath);
        }
        await this.commitOrDeferMerkleUpdate(work.event.filePath, work.event.contentHash ?? '', deferredMerkleOps);
        if (trackProgress) {
          this.progress.processedFiles++;
        }
        continue;
      }

      if (failedFilePaths.has(work.event.filePath)) {
        // The window's shared embed batch failed for this file; route to the DLQ.
        this.skippedFiles.set(work.event.filePath, embedError!.message);
        await this.deadLetterQueue.enqueue({
          filePath: work.event.filePath,
          contentHash: work.event.contentHash ?? '',
          errorMessage: embedError!.message,
          attempts: embedError!.attempts,
        });
        if (trackProgress) {
          this.progress.processedFiles++;
        }
        continue;
      }

      if (
        work.structuredParseFailed &&
        this.options.structuredIndexCoordinator !== undefined &&
        structuredRebuildFiles === undefined
      ) {
        const errorMsg = 'Structured parsing failed';
        this.skippedFiles.set(work.event.filePath, errorMsg);
        await this.deadLetterQueue.enqueue({
          filePath: work.event.filePath,
          contentHash: work.event.contentHash ?? '',
          errorMessage: errorMsg,
          attempts: 1,
        });
        if (trackProgress) {
          this.progress.processedFiles++;
        }
        continue;
      }

      if (
        work.structuredRetirement &&
        this.options.structuredIndexCoordinator !== undefined &&
        structuredRebuildFiles === undefined
      ) {
        await this.options.structuredIndexCoordinator.deleteFile({ filePath: work.event.filePath });
      }

      if (legacyCount > 0) {
        if (legacyShadow !== undefined) {
          const stagedChunks: ChunkWithEmbedding[] = work.chunks.map((chunk, i) => ({ chunk, vector: legacyEmbeddings[i] ?? [] }));
          await this.options.vectorStore.stageLegacyShadowChunks(legacyShadow, stagedChunks);
        } else {
          await this.options.vectorStore.upsertChunks(work.chunks, legacyEmbeddings, [work.event.filePath]);
        }
      }

      if (work.structured !== undefined && this.options.structuredIndexCoordinator !== undefined) {
        if (structuredRebuildFiles !== undefined) {
          structuredRebuildFiles.push({
            source: work.structured.source,
            generationId: work.structured.generationId,
            contentHash: work.structured.contentHash,
            fileCompleteness: work.structured.fileCompleteness,
            declarations: work.structured.declarations,
            imports: work.structured.imports,
            parserId: work.structured.parserId,
            parserVersion: work.structured.parserVersion,
            chunks: work.structured.chunks,
            embeddings: structuredEmbeddings,
          });
        } else {
          await this.options.structuredIndexCoordinator.stageFile({
            source: work.structured.source,
            generationId: work.structured.generationId,
            contentHash: work.structured.contentHash,
            fileCompleteness: work.structured.fileCompleteness,
            declarations: work.structured.declarations,
            imports: work.structured.imports,
            parserId: work.structured.parserId,
            parserVersion: work.structured.parserVersion,
            chunks: work.structured.chunks,
            embeddings: structuredEmbeddings,
          });
          await this.options.structuredIndexCoordinator.activateFile({
            filePath: work.event.filePath,
            generationId: work.structured.generationId,
          });
        }
      }

      if (legacyCount === 0 && structuredCount === 0) {
        // Valid file that produced no chunks (e.g. empty file): drop stale vectors, keep Merkle current.
        if (!work.structuredRetirement) {
          if (legacyShadow !== undefined) {
            await this.options.vectorStore.stageLegacyShadowDeletions(legacyShadow, { filePaths: [work.event.filePath] });
          } else {
            await this.options.vectorStore.deleteByFilePath(work.event.filePath);
          }
        }
        await this.commitOrDeferMerkleUpdate(work.event.filePath, work.event.contentHash ?? '', deferredMerkleOps);
        this.skippedFiles.delete(work.event.filePath);
        if (trackProgress) {
          this.progress.processedFiles++;
        }
        continue;
      }

      await this.commitOrDeferMerkleUpdate(work.event.filePath, work.event.contentHash ?? '', deferredMerkleOps);
      this.skippedFiles.delete(work.event.filePath);
      chunksIndexed += legacyCount;
      if (trackProgress) {
        this.progress.processedFiles++;
      }
    }

    return { chunksIndexed, embeddingFailures: [...failedFilePaths] };
  }

  private async handleDeleteEvent(
    filePath: string,
    deferStructuredRetirement = false,
    legacyShadow?: LegacyShadowTable,
    deferredMerkleOps?: DeferredMerkleOp[],
  ): Promise<void> {
    const existingNode = await this.options.metadataStore.getMerkleNode(filePath);
    if (existingNode?.isDirectory) {
      const prefix = filePath.endsWith('/') ? filePath : filePath + '/';
      if (legacyShadow !== undefined) {
        await this.options.vectorStore.stageLegacyShadowDeletions(legacyShadow, { pathPrefixes: [prefix] });
      } else {
        await this.options.vectorStore.deleteByPathPrefix(prefix);
      }
      if (deferredMerkleOps !== undefined) {
        deferredMerkleOps.push({ kind: 'subtree-delete', filePath });
      } else {
        await this.options.metadataStore.deleteSubtree(filePath);

        // Incremental update of the tree (avoids full reload)
        await this.merkleTree.remove(filePath);
      }

      this.skippedFiles.delete(filePath);
      await this.deadLetterQueue.removeByPathPrefix(filePath);
      for (const path of this.skippedFiles.keys()) {
        if (path.startsWith(prefix)) {
          this.skippedFiles.delete(path);
        }
      }
    } else {
      if (legacyShadow !== undefined) {
        await this.options.vectorStore.stageLegacyShadowDeletions(legacyShadow, { filePaths: [filePath] });
      } else {
        await this.options.vectorStore.deleteByFilePath(filePath);
      }
      if (!deferStructuredRetirement) {
        await this.options.structuredIndexCoordinator?.deleteFile({ filePath });
      }
      if (deferredMerkleOps !== undefined) {
        deferredMerkleOps.push({ kind: 'remove', filePath });
      } else {
        await this.merkleTree.remove(filePath);
      }
      this.skippedFiles.delete(filePath);
      await this.deadLetterQueue.removeByFilePath(filePath);
    }
  }

  private async applyDeferredMerkleOps(ops: readonly DeferredMerkleOp[]): Promise<void> {
    for (const op of ops) {
      if (op.kind === 'update') {
        await this.merkleTree.update(op.filePath, op.contentHash);
      } else if (op.kind === 'remove') {
        await this.merkleTree.remove(op.filePath);
      } else {
        await this.options.metadataStore.deleteSubtree(op.filePath);
        await this.merkleTree.remove(op.filePath);
      }
    }
  }

  private async commitOrDeferMerkleUpdate(
    filePath: string,
    contentHash: string,
    deferredMerkleOps?: DeferredMerkleOp[],
  ): Promise<void> {
    if (deferredMerkleOps !== undefined) {
      deferredMerkleOps.push({ kind: 'update', filePath, contentHash });
      return;
    }
    await this.merkleTree.update(filePath, contentHash);
  }

  async reindex(
    run: (options?: { fullScan?: boolean; reason?: ReindexOptions['reason'] }) => Promise<IndexEvent[]>,
    loadContent: ContentLoader,
    fullRebuild?: boolean,
    reason: ReindexOptions['reason'] = 'manual',
  ): Promise<ReindexResult | { status: 'already_running' } | { status: 'incomplete' }> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    try {
      return await tryAcquire(this.mutex).runExclusive(async () => {
        this.progress.status = 'running';
        this.progress.processedFiles = 0;
        this.progress.totalFiles = 0;
        this.progress.lastError = undefined;
        this.safeNotifyMetrics((h) => { h.onIndexingProgress(0, 0, true); });

        try {
          await this.clearPersistedError();
          const events = await run({ fullScan: fullRebuild, reason });
          this.progress.totalFiles = events.length;
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(0, events.length, true); });
          this.safeLogProgress(
            `Starting reindex of ${events.length} files (fullRebuild: ${!!fullRebuild}, reason: ${reason})`,
          );

          const { chunksIndexed } = await this.processEvents(events, loadContent, {
            trackProgress: true,
            fullRebuild,
          });

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

          const completionRecorded = await this.recordCompletion(fullRebuild, reason, finishedAt);

          if (!completionRecorded) {
            this.progress.status = 'idle';
            this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
            return { status: 'incomplete' as const };
          }

          this.safeNotifyMetrics((h) => { h.onReindexComplete(durationMs, !!fullRebuild); });

          this.progress.status = 'idle';
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
          return {
            startedAt,
            finishedAt,
            durationMs,
            reconciliation,
            chunksIndexed,
          };
        } catch (error) {
          this.progress.status = 'idle';
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
          const message = error instanceof Error ? error.message : String(error);
          this.progress.lastError = message;
          await this.persistFailure(message);
          this.safeLogProgress(`Reindex failed (${reason}): ${message}`);
          throw error;
        } finally {
          if (fullRebuild && this.eventQueue) {
            this.eventQueue.markFullScanComplete();
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

  private async recordCompletion(
    fullRebuild: boolean | undefined,
    reason: ReindexOptions['reason'],
    finishedAt: string,
  ): Promise<boolean> {
    const release = await this.completionLock.acquire();
    try {
      const vectorStats = await this.options.vectorStore.getStats();
      const existingStats = await this.options.metadataStore.getIndexStats();
      const nowIso = finishedAt;
      const stats: IndexStatsRow = {
        id: 'primary',
        totalFiles: vectorStats.totalFiles,
        totalChunks: vectorStats.totalChunks,
        lastIndexedAt: nowIso,
        lastFullScanAt: fullRebuild ? nowIso : (existingStats?.lastFullScanAt ?? null),
        overflowCount: existingStats?.overflowCount ?? 0,
        lastError: null,
      };

      const { dlqEmpty, dlqEntries } =
        await this.options.metadataStore.atomicCompletionCheck(stats);

      const reasonLabel = reason ?? 'manual';
      if (!dlqEmpty) {
        const errorMessage = `Full reindex incomplete: ${dlqEntries.length} dead-letter queue item(s) remain`;
        this.progress.lastError = errorMessage;
        await this.options.metadataStore.setIndexStats({
          ...stats,
          lastIndexedAt: existingStats?.lastIndexedAt ?? null,
          lastFullScanAt: existingStats?.lastFullScanAt ?? null,
          lastError: errorMessage,
        });

        const byPath = new Map<string, { createdAt: string; errorMessage: string }>();
        for (const entry of dlqEntries) {
          const existing = byPath.get(entry.filePath);
          if (existing === undefined || entry.createdAt > existing.createdAt) {
            byPath.set(entry.filePath, {
              createdAt: entry.createdAt,
              errorMessage: entry.errorMessage,
            });
          }
        }
        for (const [filePath, info] of byPath) {
          this.skippedFiles.set(filePath, info.errorMessage);
        }

        this.safeLogProgress(
          `Reindex incomplete (${reasonLabel}): ${dlqEntries.length} DLQ item(s) remain. Completion state NOT saved.`,
        );
        return false;
      }

      this.safeLogProgress(`Reindex completed (${reasonLabel}). index_stats updated.`);
      return true;
    } finally {
      release();
    }
  }

  private async clearPersistedError(): Promise<void> {
    const stats = await this.options.metadataStore.getIndexStats();
    if (stats?.lastError !== null && stats?.lastError !== undefined) {
      await this.options.metadataStore.setIndexStats({ ...stats, lastError: null });
    }
  }

  private async persistFailure(message: string): Promise<void> {
    try {
      const existingStats = await this.options.metadataStore.getIndexStats();
      await this.options.metadataStore.setIndexStats({
        id: 'primary',
        totalFiles: existingStats?.totalFiles ?? 0,
        totalChunks: existingStats?.totalChunks ?? 0,
        lastIndexedAt: existingStats?.lastIndexedAt ?? null,
        lastFullScanAt: existingStats?.lastFullScanAt ?? null,
        overflowCount: existingStats?.overflowCount ?? 0,
        lastError: message,
      });
    } catch (persistError) {
      this.safeLogProgress(
        `Failed to persist reindex failure state: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
      );
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

  async waitForActiveReindex(): Promise<void> {
    const release = await this.mutex.acquire();
    release();
  }

  setEventQueue(eventQueue: EventQueue): void {
    this.eventQueue = eventQueue;
  }

  private async embeddingHealthy(): Promise<boolean> {
    return this.options.embeddingProvider.healthCheck();
  }

  private async computeFileHash(filePath: string): Promise<string> {
    return computeFileHashStreaming(filePath);
  }

  private async reprocess(entry: DeadLetterEntry): Promise<void> {
    const result = await this.processEvents(
      [{
        type: 'modified',
        filePath: entry.filePath,
        contentHash: entry.contentHash,
        detectedAt: new Date().toISOString(),
      }],
      (filePath) => readFile(filePath, 'utf8'),
      { trackProgress: false },
    );

    if (result.structuredParseFailures.includes(entry.filePath)) {
      throw new Error(`Structured parsing failed for ${entry.filePath}`);
    }
    if (result.embeddingFailures.includes(entry.filePath)) {
      throw new Error(`Embedding failed for ${entry.filePath}`);
    }
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
