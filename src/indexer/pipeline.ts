import { Mutex, E_ALREADY_LOCKED, tryAcquire } from 'async-mutex';

import { DeadLetterQueue } from './dead-letter-queue.js';
import { MerkleTree } from './merkle-tree.js';
import type { Chunker } from './chunker.js';
import type {
  EmbeddingProvider,
  IMetadataStore,
  IVectorStore,
  IndexEvent,
  RuntimeInitializationResult,
  ReindexResult,
} from '../types/index.js';
import { RetryExhaustedError } from '../types/index.js';
import type { PluginRegistry } from '../plugins/registry.js';

interface IndexPipelineOptions {
  metadataStore: IMetadataStore;
  vectorStore: IVectorStore;
  chunker: Chunker;
  embeddingProvider: EmbeddingProvider;
  pluginRegistry: PluginRegistry;
}

interface ProcessEventsResult {
  chunksIndexed: number;
}

type ContentLoader = (filePath: string) => Promise<string>;

export interface IIndexPipeline {
  reindex(
    run: (options?: { fullScan?: boolean; reason?: 'manual' }) => Promise<IndexEvent[]>,
    loadContent: ContentLoader,
    fullRebuild?: boolean,
  ): Promise<ReindexResult | { status: 'already_running' }>;
  getSkippedFiles(): ReadonlyMap<string, string>;
  reconcileOnStartup(): Promise<RuntimeInitializationResult>;
}

export class IndexPipeline implements IIndexPipeline {
  private readonly merkleTree: MerkleTree;

  private readonly mutex = new Mutex();

  private readonly skippedFiles = new Map<string, string>();

  private readonly deadLetterQueue: DeadLetterQueue;

  private isTreeLoaded = false;

  constructor(private readonly options: IndexPipelineOptions) {
    this.merkleTree = new MerkleTree(options.metadataStore);
    this.deadLetterQueue = new DeadLetterQueue({ metadataStore: options.metadataStore });
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
    const renamedOldPaths = new Set(renameCandidates.map((candidate) => candidate.oldPath));
    const renamedNewPaths = new Set(renameCandidates.map((candidate) => candidate.newPath));

    for (const candidate of renameCandidates) {
      await this.options.vectorStore.renameFilePath(candidate.oldPath, candidate.newPath);
      await this.merkleTree.move(candidate.oldPath, candidate.newPath, candidate.hash);
    }

    if (renameCandidates.length > 0) {
      await this.merkleTree.load();
    }

    for (const event of events) {
      if (renamedOldPaths.has(event.filePath) || renamedNewPaths.has(event.filePath)) {
        continue;
      }

      if (event.type === 'deleted') {
        const existingNode = this.merkleTree.getNode(event.filePath);

        if (existingNode?.isDirectory) {
          await this.options.vectorStore.deleteByPathPrefix(event.filePath);
          await this.options.metadataStore.deleteSubtree(event.filePath);
          await this.merkleTree.load();
        } else {
          await this.options.vectorStore.deleteByFilePath(event.filePath);
          await this.merkleTree.remove(event.filePath);
        }

        continue;
      }

      if (loadContent === undefined) {
        throw new Error('loadContent is required for added/modified events');
      }

      const content = await loadContent(event.filePath);

      try {
        const chunks = await this.options.chunker.chunkFiles([
          {
            filePath: event.filePath,
            language: this.detectLanguage(event.filePath),
            content,
          },
        ]);

        const embeddings = await this.embedWithRetry(chunks.map((chunk) => chunk.content));
        await this.options.vectorStore.deleteByFilePath(event.filePath);
        await this.options.vectorStore.upsertChunks(chunks, embeddings);
        await this.merkleTree.update(event.filePath, event.contentHash ?? '');
        this.skippedFiles.delete(event.filePath);
        chunksIndexed += chunks.length;
      } catch (error) {
        if (error instanceof Error && error.name === 'RetryExhaustedError') {
          this.skippedFiles.set(event.filePath, error.message);
          await this.deadLetterQueue.enqueue({
            filePath: event.filePath,
            contentHash: event.contentHash ?? '',
            errorMessage: error.message,
            attempts: error instanceof RetryExhaustedError ? error.attempts : 0,
          });
          continue;
        }

        throw error;
      }
    }

    return { chunksIndexed };
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
        const events = await run({ fullScan: fullRebuild, reason: 'manual' });
        const { chunksIndexed } = await this.processEvents(events, loadContent);

        const finishedAt = new Date().toISOString();
        const durationMs = Date.now() - startTime;

        // 計算ロジックを簡略化（必要に応じて詳細な集計を実装可能）
        const reconciliation = {
          added: events.filter((e) => e.type === 'added').length,
          modified: events.filter((e) => e.type === 'modified').length,
          deleted: events.filter((e) => e.type === 'deleted').length,
          unchanged: 0, // フルスキャン時に判明するが、ここではeventsに含まれないものとする
        };

        return {
          startedAt,
          finishedAt,
          durationMs,
          reconciliation,
          chunksIndexed,
        };
      });
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        return { status: 'already_running' as const };
      }
      throw e;
    }
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
