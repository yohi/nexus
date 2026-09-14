import type { StructuredDeclaration, StructuredImport, StructuredSource } from '../structured/contracts.js';
import type { CodeChunk, IVectorStore } from '../types/index.js';
import type { Chunker } from './chunker.js';
import type {
  IStructuredCatalog,
  StructuredGenerationStage,
  StructuredGenerationActivation,
  StructuredFileRetirement,
  StructuredFullRebuildActivation,
} from '../storage/interfaces/structured-catalog.js';
import type { StructuredShadowTable } from '../storage/interfaces/vector-store.js';
import type { ProjectWriteCoordinator } from './project-write-coordinator.js';

export interface FullRebuildFile {
  source: StructuredSource;
  generationId: string;
  contentHash: string;
  fileCompleteness: 'complete' | 'partial';
  declarations: StructuredDeclaration[];
  imports: StructuredImport[];
  parserId?: string;
  parserVersion?: string;
  chunks?: CodeChunk[];
  embeddings?: number[][];
}

export interface FullRebuildCommitHooks {
  readonly beforeCommit?: () => Promise<void>;
  readonly afterCommit?: () => Promise<void>;
}

export interface StructuredIndexCoordinatorOptions {
  metadataStore: IStructuredCatalog;
  vectorStore: IVectorStore;
  chunker: Chunker;
  projectWriteCoordinator: ProjectWriteCoordinator;
  config: { embedding: { dimensions: number } };
}

export class StructuredIndexCoordinator {
  constructor(private readonly options: StructuredIndexCoordinatorOptions) {}

  async stageFile(input: {
    source: StructuredSource;
    generationId: string;
    contentHash: string;
    fileCompleteness: 'complete' | 'partial';
    declarations: StructuredDeclaration[];
    imports: StructuredImport[];
    parserId?: string;
    parserVersion?: string;
    chunks?: CodeChunk[];
    embeddings?: number[][];
  }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const expectedActiveGeneration = state.activeGenerations.get(input.source.filePath) ?? null;
      const rebuildEpoch = state.rebuildEpoch;

      const chunks = input.chunks ?? await this.options.chunker.chunkStructuredFile(
        {
          filePath: input.source.filePath,
          language: input.source.language,
          content: input.source.text,
          bytes: input.source.bytes,
        },
        {
          declarations: input.declarations,
          imports: input.imports,
        },
      );

      const embeddings = input.embeddings ?? chunks.map(() => new Array<number>(this.options.config.embedding.dimensions).fill(0));
      if (embeddings.length !== chunks.length) {
        throw new Error(`StructuredIndexCoordinator.stageFile: embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`);
      }

      const stage: StructuredGenerationStage = {
        filePath: input.source.filePath,
        generation: {
          generationId: input.generationId,
          schemaVersion: 1,
          parserId: input.parserId ?? input.source.language,
          parserVersion: input.parserVersion ?? '1',
          fileHash: input.contentHash,
          fileCompleteness: input.fileCompleteness,
        },
        declarations: input.declarations,
        imports: input.imports,
        rebuildEpoch,
        bytes: input.source.bytes,
        fileHash: input.contentHash,
        fileCompleteness: input.fileCompleteness,
      };

      try {
        await this.options.metadataStore.stageGeneration(stage);
        await this.options.vectorStore.stageGenerationChunks({
          filePath: input.source.filePath,
          generationId: input.generationId,
          chunks,
          vectors: embeddings,
        });
      } catch (error) {
        await this.options.metadataStore.clearPendingGeneration({
          filePath: input.source.filePath,
          expectedActiveGeneration,
          expectedPendingGeneration: input.generationId,
          expectedRebuildEpoch: rebuildEpoch,
        });
        throw error;
      }
    });
  }

  async activateFile(input: { filePath: string; generationId: string }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const activeGenerations = state.activeGenerations;
      const expectedActiveGeneration = activeGenerations.get(input.filePath) ?? null;

      const activation: StructuredGenerationActivation = {
        filePath: input.filePath,
        generationId: input.generationId,
        expectedActiveGeneration,
        expectedRebuildEpoch: state.rebuildEpoch,
      };

      const result = await this.options.metadataStore.activateGeneration(activation);
      if (!result.activated) {
        return;
      }

      await this.options.vectorStore.activateGenerationRows(input.filePath, input.generationId);

      if (expectedActiveGeneration !== null) {
        await this.options.vectorStore.removeGenerationRows(input.filePath, expectedActiveGeneration);
      }
    });
  }

  async deleteFile(input: { filePath: string }): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const activeGenerations = state.activeGenerations;
      const expectedActiveGeneration = activeGenerations.get(input.filePath) ?? null;

      const retirement: StructuredFileRetirement = {
        filePath: input.filePath,
        expectedActiveGeneration,
        rebuildEpoch: state.rebuildEpoch,
      };

      await this.options.metadataStore.retireFile(retirement);

      if (expectedActiveGeneration !== null) {
        await this.options.vectorStore.removeGenerationRows(input.filePath, expectedActiveGeneration);
      }
      await this.options.vectorStore.deleteByFilePath(input.filePath);
    });
  }
  async runFullRebuild(input: { files: FullRebuildFile[] } & FullRebuildCommitHooks): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      await this.options.metadataStore.bootstrapStructuredSchema();
      const epoch = await this.options.metadataStore.incrementRebuildEpoch();
      await this.options.metadataStore.setStructuredRebuildState({ rebuildState: 'building' });

      const stateBefore = await this.options.metadataStore.getStructuredIndexState();
      const previousActiveGenerations = new Map(stateBefore.activeGenerations);
      const inputFilePaths = new Set(input.files.map((file) => file.source.filePath));
      const activation: StructuredFullRebuildActivation = {
        rebuildEpoch: epoch,
        files: input.files.map((file) => ({
          filePath: file.source.filePath,
          generationId: file.generationId,
          expectedActiveGeneration: previousActiveGenerations.get(file.source.filePath) ?? null,
        })),
        retiredFiles: [...previousActiveGenerations.entries()]
          .filter(([filePath]) => !inputFilePaths.has(filePath))
          .map(([filePath, generationId]) => ({ filePath, expectedActiveGeneration: generationId })),
      };

      let shadowTable: StructuredShadowTable | undefined;
      let metadataPrepared = false;
      const stagedFiles = new Set<string>();

      try {
        await this.options.metadataStore.prepareFullRebuild(activation);
        metadataPrepared = true;
        shadowTable = await this.options.vectorStore.beginStructuredShadowTable();

        // Stage new files into metadata and the vector shadow table.
        for (const file of input.files) {
          const chunks = file.chunks ?? await this.options.chunker.chunkStructuredFile(
            {
              filePath: file.source.filePath,
              language: file.source.language,
              content: file.source.text,
              bytes: file.source.bytes,
            },
            { declarations: file.declarations, imports: file.imports },
          );
          const embeddings = file.embeddings ?? chunks.map(() => new Array<number>(this.options.config.embedding.dimensions).fill(0));
          if (embeddings.length !== chunks.length) {
            throw new Error(`StructuredIndexCoordinator.runFullRebuild: embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`);
          }

          const stage: StructuredGenerationStage = {
            filePath: file.source.filePath,
            generation: {
              generationId: file.generationId,
              schemaVersion: 1,
              parserId: file.parserId ?? file.source.language,
              parserVersion: file.parserVersion ?? '1',
              fileHash: file.contentHash,
              fileCompleteness: file.fileCompleteness,
            },
            declarations: file.declarations,
            imports: file.imports,
            rebuildEpoch: epoch,
            bytes: file.source.bytes,
            fileHash: file.contentHash,
            fileCompleteness: file.fileCompleteness,
          };
          await this.options.metadataStore.stageGeneration(stage);
          stagedFiles.add(file.source.filePath);
          await this.options.vectorStore.stageGenerationChunks({
            filePath: file.source.filePath,
            generationId: file.generationId,
            chunks,
            vectors: embeddings,
          });
        }

        await input.beforeCommit?.();
        await this.options.vectorStore.swapStructuredShadowTable(shadowTable);
        await this.options.metadataStore.activateFullRebuild(activation);
        await input.afterCommit?.();
      } catch (error) {
        if (metadataPrepared) {
          try {
            await this.options.metadataStore.rollbackFullRebuild(activation);
          } catch (rollbackError) {
            console.error('[StructuredIndexCoordinator] Failed to roll back catalog activation:', rollbackError);
          }
        } else {
          for (const filePath of stagedFiles) {
            const file = input.files.find((candidate) => candidate.source.filePath === filePath);
            if (file === undefined) continue;
            await this.options.metadataStore.clearPendingGeneration({
              filePath,
              expectedActiveGeneration: previousActiveGenerations.get(filePath) ?? null,
              expectedPendingGeneration: file.generationId,
              expectedRebuildEpoch: epoch,
            });
          }
        }
        if (shadowTable !== undefined) {
          await this.options.vectorStore.abortStructuredShadowTable(shadowTable).catch((abortError) => {
            console.error('[StructuredIndexCoordinator] Failed to roll back structured vectors:', abortError);
          });
        }
        await this.options.metadataStore.setStructuredRebuildState({
          rebuildState: 'failed',
          lastErrorCode: error instanceof Error ? error.message : 'unknown',
        });
        throw error;
      }

      if (shadowTable !== undefined) {
        await this.options.vectorStore.finalizeStructuredShadowTable(shadowTable).catch((cleanupError) => {
          console.error('[StructuredIndexCoordinator] Failed to finalize structured vector backup:', cleanupError);
        });
      }
      await this.options.metadataStore.finalizeFullRebuild(activation).catch((cleanupError) => {
        console.error('[StructuredIndexCoordinator] Failed to finalize structured catalog backup:', cleanupError);
      });
      await this.options.metadataStore.setStructuredRebuildState({ rebuildState: 'idle', lastErrorCode: null });
    });
  }

  async reconcile(): Promise<void> {
    return this.options.projectWriteCoordinator.run(async () => {
      const state = await this.options.metadataStore.getStructuredIndexState();
      const activeGenerations = Array.from(state.activeGenerations.entries()).map(
        ([filePath, generationId]) => ({ filePath, generationId }),
      );
      await this.options.vectorStore.reconcileStructuredRows(activeGenerations);
      await this.options.metadataStore.reconcileStructuredState();
    });
  }
}
