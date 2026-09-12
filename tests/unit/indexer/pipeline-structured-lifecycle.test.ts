import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Chunker } from '../../../src/indexer/chunker.js';
import { computeFileHashStreaming } from '../../../src/indexer/hash.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { sha256Hex } from '../../../src/structured/hash.js';
import type { StructuredParseResult, StructuredSource } from '../../../src/structured/contracts.js';
import type { IndexEvent } from '../../../src/types/index.js';
import { createStructuredCoordinatorFixture } from '../../shared/structured-test-helpers.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';

const createEvent = (type: IndexEvent['type'], filePath: string, content: string): IndexEvent => ({
  type,
  filePath,
  contentHash: sha256Hex(new TextEncoder().encode(content)),
  detectedAt: new Date().toISOString(),
});

const createStructuredPipeline = async () => {
  const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
  const pipeline = new IndexPipeline({
    metadataStore: fixture.metadataStore,
    vectorStore: fixture.vectorStore,
    chunker: new Chunker(fixture.pluginRegistry),
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: fixture.pluginRegistry,
    structuredIndexCoordinator: fixture.coordinator,
  });
  return { ...fixture, pipeline };
};

const indexContent = async (
  pipeline: IndexPipeline,
  type: IndexEvent['type'],
  filePath: string,
  content: string,
): Promise<void> => {
  await pipeline.processEvents(
    [createEvent(type, filePath, content)],
    async () => content,
  );
};

describe('IndexPipeline structured lifecycle', () => {
  it('routes a structured full rebuild through the coordinator full-rebuild API', async () => {
    const { coordinator, pipeline } = await createStructuredPipeline();
    const content = 'export function rebuilt(): number { return 1; }\n';
    const filePath = 'src/rebuilt.ts';
    const runFullRebuildSpy = vi.spyOn(coordinator, 'runFullRebuild');
    const stageFileSpy = vi.spyOn(coordinator, 'stageFile');
    const activateFileSpy = vi.spyOn(coordinator, 'activateFile');

    await pipeline.reindex(
      async () => [createEvent('added', filePath, content)],
      async () => content,
      true,
    );

    expect(runFullRebuildSpy).toHaveBeenCalledOnce();
    expect(runFullRebuildSpy.mock.calls[0]?.[0].files).toHaveLength(1);
    expect(runFullRebuildSpy.mock.calls[0]?.[0].files[0]).toMatchObject({
      source: { filePath, text: content },
      fileCompleteness: 'complete',
      parserId: 'typescript',
      parserVersion: expect.any(String),
    });
    expect(runFullRebuildSpy.mock.calls[0]?.[0].files[0]?.chunks).toHaveLength(1);
    expect(runFullRebuildSpy.mock.calls[0]?.[0].files[0]?.embeddings).toHaveLength(1);
    expect(stageFileSpy).not.toHaveBeenCalled();
    expect(activateFileSpy).not.toHaveBeenCalled();
  });

  it('retires structured state when a file produces no legacy or structured chunks', async () => {
    const { metadataStore, pipeline } = await createStructuredPipeline();
    const filePath = 'src/empty.ts';
    const initialContent = 'export function staleSymbol(): number { return 1; }\n';

    await indexContent(pipeline, 'added', filePath, initialContent);
    const [oldDeclaration] = await metadataStore.getFileDeclarations(filePath);
    expect(oldDeclaration).toBeDefined();

    await indexContent(pipeline, 'modified', filePath, '');

    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual({ kind: 'missing' });
    await expect(metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toEqual(
      expect.objectContaining({ kind: 'tombstone' }),
    );
  });

  it('retires structured state but keeps legacy chunks when parsing yields no declarations', async () => {
    const { metadataStore, vectorStore, pipeline } = await createStructuredPipeline();
    const filePath = 'src/comment-only.ts';
    const initialContent = 'export function staleSymbol(): number { return 1; }\n';
    const legacyContent = '// this file intentionally has no declarations\n';

    await indexContent(pipeline, 'added', filePath, initialContent);
    const [oldDeclaration] = await metadataStore.getFileDeclarations(filePath);
    expect(oldDeclaration).toBeDefined();

    await indexContent(pipeline, 'modified', filePath, legacyContent);

    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual({ kind: 'missing' });
    await expect(metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toEqual(
      expect.objectContaining({ kind: 'tombstone' }),
    );
    const results = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.symbolId).toBeUndefined();
    expect(results[0]?.chunk.content).toContain('intentionally has no declarations');
  });

  it('preserves the active generation when parsing fails before producing declarations', async () => {
    const { metadataStore, pipeline } = await createStructuredPipeline();
    const filePath = 'src/parse-failure.ts';
    const initialContent = 'export function stableSymbol(): number { return 1; }\n';
    const brokenContent = 'export function stableSymbol(): number { return (1; }\n';

    await indexContent(pipeline, 'added', filePath, initialContent);
    const [oldDeclaration] = await metadataStore.getFileDeclarations(filePath);
    const oldResolution = await metadataStore.resolveFile(filePath);
    expect(oldDeclaration).toBeDefined();
    expect(oldResolution.kind).toBe('active');

    await indexContent(pipeline, 'modified', filePath, brokenContent);

    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual(oldResolution);
    await expect(metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toEqual(
      expect.objectContaining({ kind: 'active' }),
    );
  });

  it('reprocesses a structured parse failure through staging and activation', async () => {
    const filePath = resolve('tests/fixtures/structured/typescript/malformed.ts');
    const content = await readFile(filePath, 'utf8');
    const { metadataStore, pipeline, pluginRegistry } = await createStructuredPipeline();
    const plugin = pluginRegistry.getLanguagePlugin(filePath);
    if (plugin?.createStructuredParser === undefined) {
      throw new Error('TypeScript structured parser is unavailable');
    }

    const contentHash = sha256Hex(new TextEncoder().encode(content));
    const eventContentHash = await computeFileHashStreaming(filePath);
    let parseCalls = 0;
    plugin.createStructuredParser = async () => ({
      parseStructured: async (source: StructuredSource): Promise<StructuredParseResult> => {
        parseCalls += 1;
        if (parseCalls === 2) {
          return {
            status: 'failed',
            retrievability: 'none',
            failure: { reasonCode: 'parse_error', message: 'temporary parser failure' },
            declarations: [],
            imports: [],
          };
        }

        const name = parseCalls === 1 ? 'Initial' : 'Recovered';
        return {
          status: 'ok',
          retrievability: 'exact',
          declarations: [{
            symbolId: `${name.toLowerCase()}-symbol`,
            qualifiedName: name,
            kind: 'class',
            signatureDiscriminator: 'class',
            position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: source.text.length },
            name,
            startByte: 0,
            endByte: source.bytes.length,
            sourceHash: contentHash,
            languageId: 'typescript',
            isExact: true,
            rawSource: source.text,
          }],
          imports: [],
          generation: {
            generationId: `${name.toLowerCase()}-generation`,
            schemaVersion: 1,
            parserId: 'typescript',
            parserVersion: 'test',
            fileHash: contentHash,
            fileCompleteness: 'complete',
          },
        };
      },
    });

    await pipeline.processEvents([createEvent('added', filePath, content)], async () => content);
    await pipeline.processEvents([{
      type: 'modified',
      filePath,
      contentHash: eventContentHash,
      detectedAt: new Date().toISOString(),
    }], async () => content);

    await expect(metadataStore.getDeadLetterEntries()).resolves.toHaveLength(1);

    const recoveryResult = await pipeline['deadLetterQueue'].recoverySweep();

    expect(recoveryResult).toEqual({ retried: 1, purged: 0, skipped: 0, abandoned: 0 });
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
    await expect(metadataStore.getFileDeclarations(filePath)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Recovered' })]),
    );
  });

  it('fails a structured full rebuild without retiring the active generation when parsing fails', async () => {
    const { metadataStore, vectorStore, pipeline, coordinator } = await createStructuredPipeline();
    const filePath = 'src/full-rebuild-parse-failure.ts';
    const initialContent = 'export function stableSymbol(): number { return 1; }\n';
    const brokenContent = 'export function stableSymbol(): number { return (1; }\n';

    await indexContent(pipeline, 'added', filePath, initialContent);
    const [oldDeclaration] = await metadataStore.getFileDeclarations(filePath);
    const oldResolution = await metadataStore.resolveFile(filePath);
    expect(oldDeclaration).toBeDefined();
    expect(oldResolution.kind).toBe('active');

    const runFullRebuildSpy = vi.spyOn(coordinator, 'runFullRebuild');
    await expect(
      pipeline.reindex(
        async () => [createEvent('modified', filePath, brokenContent)],
        async () => brokenContent,
        true,
      ),
    ).rejects.toThrow(`Structured full rebuild aborted: parsing failed for ${filePath}`);

    expect(runFullRebuildSpy).not.toHaveBeenCalled();
    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual(oldResolution);
    await expect(metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toEqual(
      expect.objectContaining({ kind: 'active' }),
    );
    await expect(metadataStore.getStructuredCounts()).resolves.toMatchObject({
      activeFiles: 1,
      activeSymbols: 1,
    });
    const results = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    expect(results.some((result) => result.chunk.symbolId === oldDeclaration!.symbolId)).toBe(true);
    await expect(metadataStore.getIndexStats()).resolves.toMatchObject({
      lastError: `Structured full rebuild aborted: parsing failed for ${filePath}`,
    });
  });

  it('preserves legacy vectors, counters, Merkle state, and generations when a later full-rebuild window fails', async () => {
    const { metadataStore, vectorStore, pipeline, coordinator } = await createStructuredPipeline();
    const stablePath = 'src/stable.ts';
    const deletedPath = 'src/deleted.ts';
    const brokenPath = 'src/broken.ts';
    const initialContent = 'export function stable(): number { return 1; }\n';
    const updatedContent = 'export function stable(): number { return 2; }\n';
    const deletedContent = 'export function deleted(): number { return 3; }\n';
    const brokenContent = 'export function broken(): number { return (4; }\n';

    await indexContent(pipeline, 'added', stablePath, initialContent);
    await indexContent(pipeline, 'added', deletedPath, deletedContent);
    await indexContent(pipeline, 'added', brokenPath, initialContent);

    const vectorIdsBefore = (await vectorStore.search(new Array(64).fill(0), 100))
      .map((result) => result.chunk.id)
      .sort();
    const statsBefore = await vectorStore.getStats();
    const merkleBefore = await metadataStore.getAllNodes();
    const generationsBefore = [...(await metadataStore.getStructuredIndexState()).activeGenerations.entries()];
    const runFullRebuildSpy = vi.spyOn(coordinator, 'runFullRebuild');
    const atomicPipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker((pipeline as unknown as { options: { pluginRegistry: ReturnType<typeof createStructuredPipeline> extends Promise<infer T> ? T extends { pluginRegistry: infer P } ? P : never : never } }).options.pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: (pipeline as unknown as { options: { pluginRegistry: ReturnType<typeof createStructuredPipeline> extends Promise<infer T> ? T extends { pluginRegistry: infer P } ? P : never : never } }).options.pluginRegistry,
      structuredIndexCoordinator: coordinator,
      embedBatchWindowSize: 1,
    });

    await expect(atomicPipeline.reindex(
      async () => [
        createEvent('deleted', deletedPath, deletedContent),
        createEvent('modified', stablePath, updatedContent),
        createEvent('modified', brokenPath, brokenContent),
      ],
      async (filePath) => filePath === stablePath ? updatedContent : brokenContent,
      true,
    )).rejects.toThrow(`Structured full rebuild aborted: parsing failed for ${brokenPath}`);

    expect(runFullRebuildSpy).not.toHaveBeenCalled();
    expect((await vectorStore.search(new Array(64).fill(0), 100)).map((result) => result.chunk.id).sort()).toEqual(vectorIdsBefore);
    await expect(vectorStore.getStats()).resolves.toEqual(statsBefore);
    await expect(metadataStore.getAllNodes()).resolves.toEqual(merkleBefore);
    expect([...(await metadataStore.getStructuredIndexState()).activeGenerations.entries()]).toEqual(generationsBefore);
  });

  it('retires structured state when incremental indexing skips an oversized file', async () => {
    const { metadataStore, vectorStore, pluginRegistry, coordinator, pipeline } = await createStructuredPipeline();
    const filePath = 'src/oversized-incremental.ts';
    const content = 'export function staleSymbol(): number { return 1; }\n';

    await indexContent(pipeline, 'added', filePath, content);
    const [oldDeclaration] = await metadataStore.getFileDeclarations(filePath);
    expect(oldDeclaration).toBeDefined();

    const limitedPipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry,
      structuredIndexCoordinator: coordinator,
      maxFileBytes: 16,
    });
    const deleteFileSpy = vi.spyOn(coordinator, 'deleteFile');

    await limitedPipeline.processEvents(
      [createEvent('modified', filePath, content)],
      async () => content,
    );

    expect(deleteFileSpy).toHaveBeenCalledWith({ filePath });
    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual({ kind: 'missing' });
    await expect(metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toEqual(
      expect.objectContaining({ kind: 'tombstone' }),
    );
    await expect(metadataStore.getStructuredCounts()).resolves.toMatchObject({
      activeFiles: 0,
      activeSymbols: 0,
    });
  });

  it('uses one raw-byte load for legacy and structured indexing', async () => {
    const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
    const content = 'export function rawSource(): number { return 1; }\n';
    const filePath = 'src/raw-source.ts';
    let rawByteLoads = 0;
    const rawBytes = new TextEncoder().encode(content);
    const stringLoader = vi.fn(async () => {
      throw new Error('the string loader should not be called when raw bytes are configured');
    });
    const pipeline = new IndexPipeline({
      metadataStore: fixture.metadataStore,
      vectorStore: fixture.vectorStore,
      chunker: new Chunker(fixture.pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: fixture.pluginRegistry,
      structuredIndexCoordinator: fixture.coordinator,
      loadFileBytes: async () => {
        rawByteLoads += 1;
        return rawBytes;
      },
    });

    await pipeline.processEvents([createEvent('added', filePath, content)], stringLoader);

    expect(rawByteLoads).toBe(1);
    expect(stringLoader).not.toHaveBeenCalled();
    await expect(fixture.metadataStore.getFileDeclarations(filePath)).resolves.toHaveLength(1);
  });
});

  it('persists .mjs declarations and imports after a structured full rebuild', async () => {
    const { metadataStore, pipeline } = await createStructuredPipeline();
    const filePath = 'src/rebuilt.mjs';
    const content = [
      "import { dependency } from './dependency.js';",
      '',
      'export function rebuilt() {',
      '  return dependency;',
      '}',
    ].join('\n');

    await pipeline.reindex(
      async () => [createEvent('added', filePath, content)],
      async () => content,
      true,
    );

    const resolution = await metadataStore.resolveFile(filePath);
    expect(resolution).toEqual({ kind: 'active', generationId: expect.any(String) });

    const declarations = await metadataStore.getFileDeclarations(filePath);
    expect(declarations).toContainEqual(
      expect.objectContaining({ qualifiedName: 'rebuilt', kind: 'function' }),
    );

    const imports = metadataStore.getActiveImportsForFile(filePath);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      moduleSpecifier: './dependency.js',
      bindingName: 'dependency',
    });
  });
