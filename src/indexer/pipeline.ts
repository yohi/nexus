import { Mutex } from 'async-mutex';

import { MerkleTree } from './merkle-tree.js';
import type { Chunker } from './chunker.js';
import type {
  EmbeddingProvider,
  IMetadataStore,
  IVectorStore,
  IndexEvent,
} from '../types/index.js';

interface IndexPipelineOptions {
  metadataStore: IMetadataStore;
  vectorStore: IVectorStore;
  chunker: Chunker;
  embeddingProvider: EmbeddingProvider;
}

interface ReindexResult {
  status: 'completed' | 'already_running';
}

type ContentLoader = (filePath: string) => Promise<string>;

export class IndexPipeline {
  private readonly merkleTree: MerkleTree;

  private readonly mutex = new Mutex();

  private readonly skippedFiles = new Map<string, string>();

  constructor(private readonly options: IndexPipelineOptions) {
    this.merkleTree = new MerkleTree(options.metadataStore);
  }

  async processEvents(events: IndexEvent[], loadContent?: ContentLoader): Promise<void> {
    await this.merkleTree.load();

    for (const event of events) {
      if (event.type === 'deleted') {
        await this.options.vectorStore.deleteByFilePath(event.filePath);
        await this.merkleTree.remove(event.filePath);
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

        await this.embedWithRetry(chunks.map((chunk) => chunk.content));
        await this.options.vectorStore.deleteByFilePath(event.filePath);
        await this.options.vectorStore.upsertChunks(chunks);
        await this.merkleTree.update(event.filePath, event.contentHash ?? '');
        this.skippedFiles.delete(event.filePath);
      } catch (error) {
        if (error instanceof Error && error.name === 'RetryExhaustedError') {
          this.skippedFiles.set(event.filePath, error.message);
          continue;
        }

        throw error;
      }
    }
  }

  async reindex(run: () => Promise<IndexEvent[]>): Promise<ReindexResult> {
    if (this.mutex.isLocked()) {
      return { status: 'already_running' };
    }

    const release = await this.mutex.acquire();
    try {
      await run();
      return { status: 'completed' };
    } finally {
      release();
    }
  }

  getSkippedFiles(): ReadonlyMap<string, string> {
    return this.skippedFiles;
  }

  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    return this.options.embeddingProvider.embed(texts);
  }

  private detectLanguage(filePath: string): string {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      return 'typescript';
    }

    return 'text';
  }
}
