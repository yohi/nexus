import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { SqliteMetadataStore } from '../../src/storage/metadata-store.js';
import { LanceVectorStore } from '../../src/storage/vector-store.js';
import { StructuredIndexCoordinator } from '../../src/indexer/structured-index-coordinator.js';
import { ProjectWriteCoordinator } from '../../src/indexer/project-write-coordinator.js';
import { createStructuredStage } from '../shared/structured-test-helpers.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

describe('IndexPipeline integration', () => {
  let tempDir: string;
  let metadataStore: SqliteMetadataStore;
  let vectorStore: LanceVectorStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-pipeline-integration-'));
  });

  afterEach(async () => {
    await metadataStore?.close();
    await vectorStore?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('indexes fixture files with SQLite metadata and vector storage implementations', async () => {
    metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'metadata.db'),
    });
    vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const chunker = new Chunker(registry);
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });
    const original = await readFile(fixturePath, 'utf8');
    const modified = `${original}\nexport function integrationMarker() {\n}\n`;

    await metadataStore.initialize();
    await vectorStore.initialize();

    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-added',
          detectedAt: new Date().toISOString(),
        },
      ],
      async (path) => {
        expect(path).toBe(fixturePath);
        return original;
      },
    );

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-added', isDirectory: false }),
    );

    // auth.ts currently yields some declarations depending on chunking heuristics.
    const initialStats = await vectorStore.getStats();
    expect(initialStats).toEqual(
      expect.objectContaining({ totalFiles: 1, dimensions: 64 }),
    );
    expect(initialStats.totalChunks).toBeGreaterThan(0);
    const initialChunks = initialStats.totalChunks;

    await pipeline.processEvents(
      [
        {
          type: 'modified',
          filePath: fixturePath,
          contentHash: 'hash-modified',
          detectedAt: new Date().toISOString(),
        },
      ],
      async (path) => {
        expect(path).toBe(fixturePath);
        return modified;
      },
    );

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toEqual(
      expect.objectContaining({ hash: 'hash-modified' }),
    );

    // After modification with integrationMarker function, chunk count should increase.
    const modifiedStats = await vectorStore.getStats();
    expect(modifiedStats).toEqual(
      expect.objectContaining({ totalFiles: 1, dimensions: 64 }),
    );
    expect(modifiedStats.totalChunks).toBeGreaterThan(initialChunks);
    const searchResults = await vectorStore.search(Array(64).fill(0).map((_, index) => (index === 1 ? 1 : 0)), 20);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.every((result) => result.chunk.filePath === fixturePath)).toBe(true);

    await pipeline.processEvents([
      {
        type: 'deleted',
        filePath: fixturePath,
        contentHash: 'hash-modified',
        detectedAt: new Date().toISOString(),
      },
    ]);

    await expect(metadataStore.getMerkleNode(fixturePath)).resolves.toBeNull();
    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 0, totalFiles: 0 }),
    );
  });

  it('stages and activates structured generations through the coordinator', async () => {
    metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'structured-pipeline-metadata.db'),
    });
    vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    await metadataStore.initialize();
    await vectorStore.initialize();
    await metadataStore.bootstrapStructuredSchema();

    const coordinator = new StructuredIndexCoordinator({
      metadataStore,
      vectorStore,
      chunker: new Chunker(registry),
      projectWriteCoordinator: new ProjectWriteCoordinator(),
      config: { embedding: { dimensions: 64 } },
    });

    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(registry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      structuredIndexCoordinator: coordinator,
    });

    const original = await readFile(fixturePath, 'utf8');
    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-1',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => original,
    );

    const resolution = await metadataStore.resolveFile(fixturePath);
    expect(resolution.kind).toBe('active');

    const state = await metadataStore.getStructuredIndexState();
    expect(state.counts.activeFiles).toBe(1);
    expect(state.counts.activeSymbols).toBeGreaterThan(0);

    const declarations = await metadataStore.getFileDeclarations(fixturePath);
    expect(declarations.length).toBeGreaterThan(0);
  });

  it('handles manual reindex with observable side-effects', async () => {
    metadataStore = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'reindex-metadata.db'),
    });
    vectorStore = new LanceVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(registry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    await metadataStore.initialize();
    await vectorStore.initialize();

    const original = await readFile(fixturePath, 'utf8');

    // 1. Initial indexing
    await pipeline.processEvents(
      [
        {
          type: 'added',
          filePath: fixturePath,
          contentHash: 'hash-1',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => original,
    );

    // 2. Perform reindex with empty events (Verify ReindexResult per contract)
    const emptyResult = await pipeline.reindex(async () => [], async () => '');
    expect(emptyResult).toMatchObject({
      chunksIndexed: 0,
    });

    // 3. Perform reindex that deletes the file
    const result = await pipeline.reindex(
      async () => [
        {
          type: 'deleted',
          filePath: fixturePath,
          contentHash: 'hash-1',
          detectedAt: new Date().toISOString(),
        },
      ],
      async () => '',
    );

    // 4. Verify ReindexResult structure and side-effects
    expect(result).toMatchObject({
      reconciliation: { added: 0, modified: 0, deleted: 1 },
      chunksIndexed: 0,
    });

    await expect(vectorStore.getStats()).resolves.toEqual(
      expect.objectContaining({ totalChunks: 0, totalFiles: 0 }),
    );

    // 5. Test lock/already-running case
    let startedResolve: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const runReindex = (shouldSignal = false) =>
      pipeline.reindex(
        async () => {
          if (shouldSignal) startedResolve();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return [];
        },
        async () => '',
      );

    const firstPromise = runReindex(true);
    await startedPromise;
    const second = await runReindex(false);
    const first = await firstPromise;

    expect(first).not.toEqual({ status: 'already_running' });
    expect(second).toEqual({ status: 'already_running' });
  });

  it('rolls back a mixed full-rebuild state after reopening all stores', async () => {
    const databasePath = path.join(tempDir, 'recovery-metadata.db');
    const vectorPath = path.join(tempDir, 'recovery-vectors');
    const oldStage = createStructuredStage(
      'src/recovery.ts',
      'export function oldGeneration(): number { return 1; }\n',
      'oldGeneration',
    );
    const newStage = createStructuredStage(
      'src/recovery.ts',
      'export function newGeneration(): number { return 2; }\n',
      'newGeneration',
    );
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    const chunker = new Chunker(registry);

    metadataStore = new SqliteMetadataStore({
      databasePath,
      deferFullRebuildRecovery: true,
    });
    vectorStore = new LanceVectorStore({
      dbPath: vectorPath,
      dimensions: 64,
      deferRebuildCleanup: true,
    });
    await metadataStore.initialize();
    await metadataStore.bootstrapStructuredSchema();
    await vectorStore.initialize();

    const initialEpoch = await metadataStore.incrementRebuildEpoch();
    await metadataStore.stageGeneration({
      filePath: oldStage.source.filePath,
      generation: {
        generationId: oldStage.generationId,
        schemaVersion: 1,
        parserId: 'test',
        parserVersion: '1',
        fileHash: oldStage.contentHash,
        fileCompleteness: 'complete',
      },
      declarations: [oldStage.symbol],
      imports: [],
      rebuildEpoch: initialEpoch,
      bytes: oldStage.source.bytes,
      fileHash: oldStage.contentHash,
      fileCompleteness: 'complete',
    });
    await metadataStore.activateGeneration({
      filePath: oldStage.source.filePath,
      generationId: oldStage.generationId,
      expectedActiveGeneration: null,
      expectedRebuildEpoch: initialEpoch,
    });

    const oldLegacyChunks = await chunker.chunkFiles([{
      filePath: oldStage.source.filePath,
      language: 'typescript',
      content: oldStage.source.text,
    }]);
    await vectorStore.upsertChunks(oldLegacyChunks, oldLegacyChunks.map(() => new Array<number>(64).fill(0)));
    const oldStructuredChunks = await chunker.chunkStructuredFile(
      {
        filePath: oldStage.source.filePath,
        language: oldStage.source.language,
        content: oldStage.source.text,
        bytes: oldStage.source.bytes,
      },
      { declarations: [oldStage.symbol], imports: [] },
    );
    const oldStructuredShadow = await vectorStore.beginStructuredShadowTable();
    await vectorStore.stageGenerationChunks({
      filePath: oldStage.source.filePath,
      generationId: oldStage.generationId,
      chunks: oldStructuredChunks,
      vectors: oldStructuredChunks.map(() => new Array<number>(64).fill(0)),
    });
    await vectorStore.swapStructuredShadowTable(oldStructuredShadow, initialEpoch);
    await metadataStore.bulkUpsertMerkleNodes([{
      path: oldStage.source.filePath,
      hash: oldStage.contentHash,
      parentPath: null,
      isDirectory: false,
    }]);
    const merkleSnapshot = await metadataStore.getAllNodes();

    await vectorStore.close();
    vectorStore = new LanceVectorStore({
      dbPath: vectorPath,
      dimensions: 64,
      deferRebuildCleanup: true,
      rebuildJournal: metadataStore,
    });
    await vectorStore.initialize();

    const rebuildEpoch = await metadataStore.incrementRebuildEpoch();
    const activation = {
      rebuildEpoch,
      files: [{
        filePath: newStage.source.filePath,
        generationId: newStage.generationId,
        expectedActiveGeneration: oldStage.generationId,
      }],
      retiredFiles: [],
    } as const;
    await metadataStore.prepareFullRebuild(activation, merkleSnapshot);
    await metadataStore.stageGeneration({
      filePath: newStage.source.filePath,
      generation: {
        generationId: newStage.generationId,
        schemaVersion: 1,
        parserId: 'test',
        parserVersion: '1',
        fileHash: newStage.contentHash,
        fileCompleteness: 'complete',
      },
      declarations: [newStage.symbol],
      imports: [],
      rebuildEpoch,
      bytes: newStage.source.bytes,
      fileHash: newStage.contentHash,
      fileCompleteness: 'complete',
    });

    const legacyShadow = await vectorStore.beginLegacyShadowTable();
    const newLegacyChunks = await chunker.chunkFiles([{
      filePath: newStage.source.filePath,
      language: 'typescript',
      content: newStage.source.text,
    }]);
    await vectorStore.stageLegacyShadowChunks(legacyShadow, newLegacyChunks.map((chunk) => ({
      chunk,
      vector: new Array<number>(64).fill(0),
    })));
    await vectorStore.swapLegacyShadowTable(legacyShadow, rebuildEpoch);
    await metadataStore.setStructuredRebuildState({ rebuildState: 'legacy-swapped' });

    const structuredShadow = await vectorStore.beginStructuredShadowTable();
    const newStructuredChunks = await chunker.chunkStructuredFile(
      {
        filePath: newStage.source.filePath,
        language: newStage.source.language,
        content: newStage.source.text,
        bytes: newStage.source.bytes,
      },
      { declarations: [newStage.symbol], imports: [] },
    );
    await vectorStore.stageGenerationChunks({
      filePath: newStage.source.filePath,
      generationId: newStage.generationId,
      chunks: newStructuredChunks,
      vectors: newStructuredChunks.map(() => new Array<number>(64).fill(0)),
    });
    await vectorStore.swapStructuredShadowTable(structuredShadow, rebuildEpoch);
    await metadataStore.setStructuredRebuildState({ rebuildState: 'structured-swapped' });
    await metadataStore.activateFullRebuild(activation);
    await metadataStore.setStructuredRebuildState({ rebuildState: 'catalog-activated' });
    await vectorStore.close();
    await metadataStore.close();

    metadataStore = new SqliteMetadataStore({ databasePath, deferFullRebuildRecovery: true });
    vectorStore = new LanceVectorStore({
      dbPath: vectorPath,
      dimensions: 64,
      deferRebuildCleanup: true,
      rebuildJournal: metadataStore,
    });
    await metadataStore.initialize();
    await vectorStore.initialize();
    const recoveredCoordinator = new StructuredIndexCoordinator({
      metadataStore,
      vectorStore,
      chunker,
      projectWriteCoordinator: new ProjectWriteCoordinator(),
      config: { embedding: { dimensions: 64 } },
    });
    const recoveredPipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
      structuredIndexCoordinator: recoveredCoordinator,
    });
    const reconcileSpy = vi.spyOn(recoveredCoordinator, 'reconcile');

    await expect(recoveredPipeline.reconcileOnStartup()).resolves.toMatchObject({ chunksIndexed: 0 });
    expect(reconcileSpy).toHaveBeenCalledOnce();
    await expect(metadataStore.resolveFile(oldStage.source.filePath)).resolves.toEqual({
      kind: 'active',
      generationId: oldStage.generationId,
    });
    await expect(metadataStore.getGeneration(newStage.source.filePath, newStage.generationId)).resolves.toBeNull();
    await expect(metadataStore.getAllNodes()).resolves.toEqual(merkleSnapshot);
    await expect(metadataStore.getFullRebuildRecovery?.()).resolves.toBeNull();

    const results = await vectorStore.search(new Array<number>(64).fill(0), 100);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.chunk.content.includes('return 1'))).toBe(true);
    await expect(vectorStore.getStats()).resolves.toMatchObject({ totalFiles: 1 });
    expect((await metadataStore.getStructuredIndexState()).rebuildState).toBe('failed');
  });
});
