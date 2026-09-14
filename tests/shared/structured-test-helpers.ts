import { Chunker } from '../../src/indexer/chunker.js';
import { ProjectWriteCoordinator } from '../../src/indexer/project-write-coordinator.js';
import { StructuredIndexCoordinator } from '../../src/indexer/structured-index-coordinator.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { decodeUtf8, sha256Hex } from '../../src/structured/hash.js';
import { createGenerationId, createSymbolId } from '../../src/structured/identity.js';
import type { StructuredDeclaration, StructuredSource } from '../../src/structured/contracts.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';

export interface StructuredCoordinatorDependencies {
  readonly metadataStore: InMemoryMetadataStore;
  readonly vectorStore: InMemoryVectorStore;
  readonly pluginRegistry: PluginRegistry;
}

export interface StructuredCoordinatorFixture extends StructuredCoordinatorDependencies {
  readonly coordinator: StructuredIndexCoordinator;
}

export interface StructuredStageOptions {
  readonly startByte?: number;
  readonly endByte?: number;
  readonly signatureDiscriminator?: string;
  readonly endColumn?: number;
}

export interface StructuredStageFixture {
  readonly source: StructuredSource;
  readonly symbolId: string;
  readonly qualifiedName: string;
  readonly generationId: string;
  readonly contentHash: string;
  readonly symbol: StructuredDeclaration;
}

export const createStructuredSource = (filePath: string, text: string): StructuredSource => {
  const bytes = Buffer.from(text, 'utf8');
  return { filePath, language: 'typescript', bytes, text: decodeUtf8(bytes) };
};

export const createStructuredCoordinator = ({
  metadataStore,
  vectorStore,
  pluginRegistry,
}: StructuredCoordinatorDependencies): StructuredIndexCoordinator =>
  new StructuredIndexCoordinator({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    projectWriteCoordinator: new ProjectWriteCoordinator(),
    config: { embedding: { dimensions: 64 } },
  });

export const createStructuredCoordinatorFixture = async (
  options: { readonly bootstrapStructuredSchema?: boolean } = {},
): Promise<StructuredCoordinatorFixture> => {
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  await metadataStore.initialize();
  await vectorStore.initialize();
  if (options.bootstrapStructuredSchema) {
    await metadataStore.bootstrapStructuredSchema();
  }

  const pluginRegistry = new PluginRegistry();
  pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
  const dependencies = { metadataStore, vectorStore, pluginRegistry };
  return { ...dependencies, coordinator: createStructuredCoordinator(dependencies) };
};

export const createStructuredStage = (
  filePath: string,
  text: string,
  qualifiedName: string,
  options: StructuredStageOptions = {},
): StructuredStageFixture => {
  const source = createStructuredSource(filePath, text);
  const contentHash = sha256Hex(source.bytes);
  const signatureDiscriminator = options.signatureDiscriminator ?? 'fn';
  const symbolId = createSymbolId({
    filePath,
    qualifiedName,
    kind: 'function',
    signatureDiscriminator,
    occurrence: 0,
  });
  const generationId = createGenerationId({
    schemaVersion: 1,
    parserId: 'test',
    parserVersion: '1',
    contentHash,
  });
  const symbol: StructuredDeclaration = {
    name: qualifiedName,
    symbolId,
    qualifiedName,
    kind: 'function',
    signatureDiscriminator,
    position: {
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      endColumn: options.endColumn ?? 30,
    },
    startByte: options.startByte ?? 0,
    endByte: options.endByte ?? source.bytes.length,
    sourceHash: contentHash,
    languageId: 'typescript',
    isExact: true,
  };

  return { source, symbolId, qualifiedName, generationId, contentHash, symbol };
};

export const stageStructuredFile = async (
  coordinator: StructuredIndexCoordinator,
  stage: StructuredStageFixture,
): Promise<void> => {
  await coordinator.stageFile({
    source: stage.source,
    generationId: stage.generationId,
    contentHash: stage.contentHash,
    fileCompleteness: 'complete',
    declarations: [stage.symbol],
    imports: [],
  });
};

export const runStructuredFullRebuild = async (
  coordinator: StructuredIndexCoordinator,
  stage: StructuredStageFixture,
): Promise<void> => {
  await coordinator.runFullRebuild({
    files: [{
      source: stage.source,
      generationId: stage.generationId,
      contentHash: stage.contentHash,
      fileCompleteness: 'complete',
      declarations: [stage.symbol],
      imports: [],
    }],
    merkleSnapshot: [],
  });
};
