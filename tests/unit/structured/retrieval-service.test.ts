import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymbolRetrievalService } from '../../../src/structured/retrieval-service.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { createGenerationId, createSymbolId } from '../../../src/structured/identity.js';
import { sha256Hex } from '../../../src/structured/hash.js';
import type { StructuredDeclaration, StructuredImport } from '../../../src/structured/contracts.js';
import {
  createStructuredCoordinatorFixture,
  createStructuredSource,
  createStructuredStage,
  runStructuredFullRebuild,
  stageStructuredFile,
} from '../../shared/structured-test-helpers.js';
import type { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import type { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import type { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

interface ImportFixture {
  readonly importText: string;
  readonly symbolText: string;
  readonly text: string;
  readonly source: ReturnType<typeof createStructuredSource>;
  readonly generationId: string;
  readonly contentHash: string;
  readonly symbolId: string;
  readonly declaration: StructuredDeclaration;
  readonly importRecord: StructuredImport;
}

const makeImportFixture = (): ImportFixture => {
  const importText = 'import { café } from "./dep.js";';
  const symbolText = 'export function a() { return 1; }';
  const text = `${importText}\n${symbolText}`;
  const source = createStructuredSource('src/a.ts', text);
  const contentHash = sha256Hex(source.bytes);
  const generationId = createGenerationId({
    schemaVersion: 1,
    parserId: 'test',
    parserVersion: '1',
    contentHash,
  });
  const symbolId = createSymbolId({
    filePath: 'src/a.ts',
    qualifiedName: 'a',
    kind: 'function',
    signatureDiscriminator: 'fn',
    occurrence: 0,
  });
  const importStart = 0;
  const importEnd = Buffer.byteLength(importText, 'utf8');
  const symbolStart = importEnd + 1;
  const declaration: StructuredDeclaration = {
    name: 'a',
    symbolId,
    qualifiedName: 'a',
    kind: 'function',
    signatureDiscriminator: 'fn',
    position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: symbolText.length },
    startByte: symbolStart,
    endByte: source.bytes.length,
    sourceHash: sha256Hex(source.bytes.subarray(symbolStart, source.bytes.length)),
    languageId: 'typescript',
    isExact: true,
    importBindingIds: ['import-1'],
  };
  const importRecord: StructuredImport = {
    id: 'import-1',
    moduleSpecifier: './dep.js',
    bindingName: 'café',
    startByte: importStart,
    endByte: importEnd,
    sourceHash: sha256Hex(source.bytes.subarray(importStart, importEnd)),
    completeness: 'complete',
    position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: importText.length },
  };

  return { importText, symbolText, text, source, generationId, contentHash, symbolId, declaration, importRecord };
};

const runImportFixture = async (coordinator: StructuredIndexCoordinator, fixture: ImportFixture): Promise<void> => {
  await coordinator.runFullRebuild({
    files: [{
      source: fixture.source,
      generationId: fixture.generationId,
      contentHash: fixture.contentHash,
      fileCompleteness: 'complete',
      declarations: [fixture.declaration],
      imports: [fixture.importRecord],
    }],
    merkleSnapshot: [],
  });
};

describe('SymbolRetrievalService', () => {
  let projectRoot: string;
  let catalog: InMemoryMetadataStore;
  let vectorStore: InMemoryVectorStore;
  let sanitizer: PathSanitizer;
  let service: SymbolRetrievalService;
  let coordinator: StructuredIndexCoordinator;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'nexus-retrieval-test-'));
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
    catalog = fixture.metadataStore;
    vectorStore = fixture.vectorStore;
    coordinator = fixture.coordinator;
    sanitizer = await PathSanitizer.create(projectRoot);
    service = new SymbolRetrievalService({ catalog, sanitizer });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('does not read or return source when an ID is pending', async () => {
    const text = 'export function a() { return 1; }';
    const stage = createStructuredStage('src/a.ts', text, 'a');
    await stageStructuredFile(coordinator, stage);

    const result = await service.getSymbolSource({ symbolId: stage.symbolId });
    expect(result).toEqual({
      status: 'index_incomplete',
      reasonCode: 'INDEX_PENDING_GENERATION',
      request: { symbolId: stage.symbolId },
    });
  });

  it('reads one buffer, rejects a changed file, and omits source', async () => {
    const text = 'export function a() { return 1; }';
    const stage = createStructuredStage('src/a.ts', text, 'a');
    await runStructuredFullRebuild(coordinator, stage);

    await writeFile(join(projectRoot, 'src/a.ts'), 'changed');
    const result = await service.getSymbolSource({ symbolId: stage.symbolId });
    expect(result).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('source');
  });

  it('returns the old active source after failed stage cleanup when its bytes are current', async () => {
    const firstText = 'export function a() { return 1; }';
    const first = createStructuredStage('src/a.ts', firstText, 'a');

    await stageStructuredFile(coordinator, first);
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: first.generationId });

    // Force the next staging to fail after catalog metadata is written but vectors are not.
    // Note: InMemoryVectorStore begins a shadow only for runFullRebuild; stageFile writes
    // directly to structuredRecords, so failOnBatch applies to the second stageFile call.
    vectorStore.failOnBatch(2);
    const secondText = 'export function a() { return 2; }';
    const second = createStructuredStage('src/a.ts', secondText, 'a');
    await expect(stageStructuredFile(coordinator, second)).rejects.toThrow();

    await writeFile(join(projectRoot, 'src/a.ts'), firstText);
    const result = await service.getSymbolSource({ symbolId: first.symbolId });
    expect(result).toMatchObject({
      status: 'ok',
      freshness: 'fresh',
      reindexRequired: false,
      source: firstText,
    });
  });

  it('rejects a changed file with stale before checking imports', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);

    await writeFile(join(projectRoot, 'src/a.ts'), `${fixture.importText.replace('café', 'cafe2')}\n${fixture.symbolText}`);
    const result = await service.getSymbolContext({ symbolId: fixture.symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('context');
  });

  it('fails closed before packing when one candidate import no longer matches its indexed hash', async () => {
    const fixture = makeImportFixture();
    const corrupted = {
      ...fixture,
      importRecord: { ...fixture.importRecord, sourceHash: '0'.repeat(64) },
    };
    await runImportFixture(coordinator, corrupted);

    await writeFile(join(projectRoot, 'src/a.ts'), fixture.text);
    const result = await service.getSymbolContext({ symbolId: fixture.symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('context');
  });

  it('returns index_incomplete when the symbol slice hash does not match the catalog', async () => {
    const fixture = makeImportFixture();
    const corrupted = {
      ...fixture,
      declaration: { ...fixture.declaration, sourceHash: '0'.repeat(64) },
    };
    await runImportFixture(coordinator, corrupted);

    await writeFile(join(projectRoot, 'src/a.ts'), fixture.text);
    const result = await service.getSymbolSource({ symbolId: fixture.symbolId });
    expect(result).toMatchObject({ status: 'index_incomplete', reasonCode: 'INDEX_SYMBOL_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('source');
  });

  it('derives an import rawSource from its verified UTF-8 byte slice', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);

    await writeFile(join(projectRoot, 'src/a.ts'), fixture.text);
    const result = await service.getSymbolContext({ symbolId: fixture.symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({
      status: 'ok',
      freshness: 'fresh',
      reindexRequired: false,
    });
    expect((result as { context: string }).context).toContain(fixture.importText);
  });

  it('does not duplicate import source in the imports array', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);

    await writeFile(join(projectRoot, 'src/a.ts'), fixture.text);
    const result = await service.getSymbolContext({ symbolId: fixture.symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'ok' });
    const imports = (result as { imports: Array<{ rawSource?: string }> }).imports;
    expect(imports[0]).not.toHaveProperty('rawSource');
  });

  it('keeps source order and later small imports after a too-large earlier import', async () => {
    const largeImport = 'import '.repeat(50);
    const smallImport = 'import { x } from "./small.js";';
    const symbolText = 'export function a() { return 1; }';
    const text = `${largeImport}\n${smallImport}\n${symbolText}`;
    const source = createStructuredSource('src/a.ts', text);
    const generationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(source.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });
    const largeEnd = Buffer.byteLength(largeImport, 'utf8');
    const smallStart = largeEnd + 1;
    const smallEnd = smallStart + Buffer.byteLength(smallImport, 'utf8');
    await coordinator.runFullRebuild({
      files: [{
        source,
        generationId,
        contentHash: sha256Hex(source.bytes),
        fileCompleteness: 'complete',
        declarations: [{
          name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
          position: { startLine: 3, startColumn: 0, endLine: 3, endColumn: symbolText.length },
          startByte: smallEnd + 1, endByte: source.bytes.length, sourceHash: sha256Hex(source.bytes.subarray(smallEnd + 1, source.bytes.length)),
          languageId: 'typescript', isExact: true, importBindingIds: ['large', 'small'],
        }],
        imports: [
          {
            id: 'large', moduleSpecifier: './large.js', bindingName: 'a',
            startByte: 0, endByte: largeEnd,
            sourceHash: sha256Hex(source.bytes.subarray(0, largeEnd)),
            completeness: 'complete',
            position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: largeImport.length },
          },
          {
            id: 'small', moduleSpecifier: './small.js', bindingName: 'x',
            startByte: smallStart, endByte: smallEnd,
            sourceHash: sha256Hex(source.bytes.subarray(smallStart, smallEnd)),
            completeness: 'complete',
            position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: smallImport.length },
          },
        ],
      }],
      merkleSnapshot: [],
    });

    await writeFile(join(projectRoot, 'src/a.ts'), text);
    const result = await service.getSymbolContext({ symbolId, tokenBudget: 20 });
    expect((result as { imports: Array<{ moduleSpecifier?: string }> }).imports.map((item) => item.moduleSpecifier)).toEqual(['./small.js']);
    expect((result as { budget: { omittedForBudget: number } }).budget.omittedForBudget).toBe(1);
  });

  it('returns unsupported_language before reading the file for unsupported languages', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);
    await writeFile(join(projectRoot, 'src/a.ts'), fixture.text);

    const restrictedService = new SymbolRetrievalService({
      catalog,
      sanitizer,
      isSupportedLanguage: (language) => language === 'typescript',
    });

    const unsupportedDeclaration: StructuredDeclaration = { ...fixture.declaration, languageId: 'binary' };
    const unsupportedSource = { ...fixture.source, language: 'binary' };
    await coordinator.runFullRebuild({
      files: [{
        source: unsupportedSource,
        generationId: createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '2', contentHash: fixture.contentHash }),
        contentHash: fixture.contentHash,
        fileCompleteness: 'complete',
        declarations: [unsupportedDeclaration],
        imports: [fixture.importRecord],
      }],
      merkleSnapshot: [],
    });

    const result = await restrictedService.getSymbolSource({ symbolId: fixture.symbolId });
    expect(result).toEqual({
      status: 'unsupported',
      reasonCode: 'unsupported_language',
      request: { symbolId: fixture.symbolId },
    });
  });

  it('returns PATH_EXCLUDED when the file matches the ignore matcher', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);

    const excludedService = new SymbolRetrievalService({
      catalog,
      sanitizer,
      isExcluded: (filePath) => filePath === 'src/a.ts',
    });

    const result = await excludedService.getSymbolSource({ symbolId: fixture.symbolId });
    expect(result).toEqual({
      status: 'excluded',
      freshness: 'unknown',
      reindexRequired: false,
      reasonCode: 'PATH_EXCLUDED',
      request: { symbolId: fixture.symbolId },
    });

    const contextResult = await excludedService.getSymbolContext({
      symbolId: fixture.symbolId,
      tokenBudget: 500,
    });
    expect(contextResult).toEqual({
      status: 'excluded',
      freshness: 'unknown',
      reindexRequired: false,
      reasonCode: 'PATH_EXCLUDED',
      request: { symbolId: fixture.symbolId, tokenBudget: 500 },
    });
  });

  it('propagates an AbortSignal to the file read', async () => {
    const text = 'export function a() { return 1; }';
    const stage = createStructuredStage('src/a.ts', text, 'a');
    await runStructuredFullRebuild(coordinator, stage);

    const controller = new AbortController();
    controller.abort();
    await expect(service.getSymbolSource({ symbolId: stage.symbolId, signal: controller.signal })).rejects.toThrow();
  });

  describe('getFileOutline', () => {
    it('returns complete metadata when the structured schema is missing globally', async () => {
      Object.defineProperty(catalog, 'schemaVersion', { value: null, writable: true });

      await expect(service.getFileOutline({ filePath: 'src/a.ts' })).resolves.toEqual({
        status: 'not_indexed',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'STRUCTURED_INDEX_MISSING',
        request: { filePath: 'src/a.ts' },
      });
    });

    it('returns unsupported metadata for a future structured schema', async () => {
      Object.defineProperty(catalog, 'schemaVersion', { value: 2, writable: true });

      await expect(service.getFileOutline({ filePath: 'src/a.ts' })).resolves.toEqual({
        status: 'unsupported',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED',
        request: { filePath: 'src/a.ts' },
      });
    });

    it('returns unsupported_language for an unsupported outline parser', async () => {
      const text = 'export function a() { return 1; }';
      const stage = createStructuredStage('src/a.ts', text, 'a');
      await coordinator.runFullRebuild({
        files: [{
          source: { ...stage.source, language: 'binary' },
          generationId: stage.generationId,
          contentHash: stage.contentHash,
          fileCompleteness: 'complete',
          declarations: [stage.symbol],
          imports: [],
          parserId: 'binary',
          parserVersion: '1',
        }],
        merkleSnapshot: [],
      });
      await writeFile(join(projectRoot, 'src/a.ts'), text);

      const restrictedService = new SymbolRetrievalService({
        catalog,
        sanitizer,
        isSupportedLanguage: (language) => language === 'typescript',
      });

      await expect(restrictedService.getFileOutline({ filePath: 'src/a.ts' })).resolves.toMatchObject({
        status: 'unsupported',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'unsupported_language',
      });
    });

    it('returns freshness metadata for an active indexed file', async () => {
      const text = 'export function a() { return 1; }';
      const stage = createStructuredStage('src/a.ts', text, 'a');
      await runStructuredFullRebuild(coordinator, stage);
      await writeFile(join(projectRoot, 'src/a.ts'), text);

      const result = await service.getFileOutline({ filePath: 'src/a.ts' });
      expect(result).toMatchObject({
        status: 'ok',
        freshness: 'fresh',
        reindexRequired: false,
        file: {
          filePath: 'src/a.ts',
          language: 'typescript',
          parserId: 'typescript',
          parserVersion: '1',
        },
      });
      expect((result as { symbols: unknown[] }).symbols).toHaveLength(1);
    });

    it('returns degraded metadata for an active partial generation', async () => {
      const text = 'export function partial(): number { return 1; }';
      const stage = createStructuredStage('src/partial.ts', text, 'partial');
      await coordinator.stageFile({
        source: stage.source,
        generationId: stage.generationId,
        contentHash: stage.contentHash,
        fileCompleteness: 'partial',
        declarations: [stage.symbol],
        imports: [],
        parserId: 'typescript',
        parserVersion: '1',
      });
      await coordinator.activateFile({ filePath: stage.source.filePath, generationId: stage.generationId });
      await writeFile(join(projectRoot, stage.source.filePath), text);

      const result = await service.getFileOutline({ filePath: stage.source.filePath });
      expect(result).toMatchObject({
        status: 'degraded',
        freshness: 'fresh',
        reindexRequired: false,
        retrievability: 'partial',
        reasonCode: 'PARSER_COVERAGE_PARTIAL',
        file: {
          filePath: stage.source.filePath,
          language: 'typescript',
          parserId: 'typescript',
          parserVersion: '1',
        },
      });
      expect((result as { symbols: unknown[] }).symbols).toHaveLength(1);
    });

    it('rejects a mixed outline when the active generation changes while declarations are read', async () => {
      const firstText = 'export function first(): number { return 1; }';
      const first = createStructuredStage('src/race.ts', firstText, 'first');
      await runStructuredFullRebuild(coordinator, first);
      await writeFile(join(projectRoot, first.source.filePath), firstText);

      const second = createStructuredStage('src/race.ts', 'export function second(): number { return 2; }', 'second');
      await stageStructuredFile(coordinator, second);

      const originalGetFileDeclarations = catalog.getFileDeclarations.bind(catalog);
      let raced = false;
      catalog.getFileDeclarations = async (filePath) => {
        if (!raced) {
          raced = true;
          await coordinator.activateFile({ filePath, generationId: second.generationId });
        }
        return originalGetFileDeclarations(filePath);
      };

      const result = await service.getFileOutline({ filePath: first.source.filePath });
      expect(result).toMatchObject({
        status: 'stale',
        reasonCode: 'INDEX_FILE_HASH_MISMATCH',
      });
      expect(result).not.toHaveProperty('symbols');
    });

    it('returns stale when the active file hash mismatches', async () => {
      const text = 'export function a() { return 1; }';
      const stage = createStructuredStage('src/a.ts', text, 'a');
      await runStructuredFullRebuild(coordinator, stage);
      await writeFile(join(projectRoot, 'src/a.ts'), 'export function a() { return 2; }');

      const result = await service.getFileOutline({ filePath: 'src/a.ts' });
      expect(result).toMatchObject({
        status: 'stale',
        freshness: 'stale',
        reindexRequired: true,
        reasonCode: 'INDEX_FILE_HASH_MISMATCH',
      });
    });

    it('returns stale when the active file is deleted from disk', async () => {
      const text = 'export function a() { return 1; }';
      const stage = createStructuredStage('src/a.ts', text, 'a');
      await runStructuredFullRebuild(coordinator, stage);
      await writeFile(join(projectRoot, 'src/a.ts'), text);
      await rm(join(projectRoot, 'src/a.ts'));

      const result = await service.getFileOutline({ filePath: 'src/a.ts' });
      expect(result).toMatchObject({
        status: 'stale',
        freshness: 'stale',
        reasonCode: 'INDEX_FILE_MISSING',
      });
    });

    it('returns not_found when the file is neither indexed nor on disk', async () => {
      const result = await service.getFileOutline({ filePath: 'src/missing.ts' });
      expect(result).toMatchObject({
        status: 'not_found',
        freshness: 'unknown',
        reasonCode: 'FILE_NOT_FOUND',
      });
    });

    it('returns not_indexed when the file exists but has no active catalog', async () => {
      await writeFile(join(projectRoot, 'src/exists.ts'), 'export function b() {}');

      const result = await service.getFileOutline({ filePath: 'src/exists.ts' });
      expect(result).toMatchObject({
        status: 'not_indexed',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'STRUCTURED_INDEX_MISSING',
      });
    });

    it('returns excluded for files matching the ignore matcher', async () => {
      const excludedService = new SymbolRetrievalService({
        catalog,
        sanitizer,
        isExcluded: (filePath) => filePath === 'src/a.ts',
      });

      const result = await excludedService.getFileOutline({ filePath: 'src/a.ts' });
      expect(result).toMatchObject({
        status: 'excluded',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'PATH_EXCLUDED',
      });
    });

    it('returns index_incomplete when a full rebuild is actively building', async () => {
      await catalog.setStructuredRebuildState({ rebuildState: 'building' });

      await expect(service.getFileOutline({ filePath: 'src/a.ts' })).resolves.toEqual({
        status: 'index_incomplete',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'INDEX_PENDING_GENERATION',
        request: { filePath: 'src/a.ts' },
      });
    });

    it('returns not_indexed when a full rebuild has failed', async () => {
      await catalog.setStructuredRebuildState({ rebuildState: 'failed' });

      await expect(service.getFileOutline({ filePath: 'src/a.ts' })).resolves.toEqual({
        status: 'not_indexed',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'STRUCTURED_INDEX_MISSING',
        request: { filePath: 'src/a.ts' },
      });
    });

    it('includes parentSymbolId in file outline symbol metadata', async () => {
      const text = 'export class Parent { child() { return 1; } }';
      const stage = createStructuredStage('src/parent.ts', text, 'Parent');
      const childDeclaration: StructuredDeclaration = {
        name: 'child',
        symbolId: 'symbol_v1_child_00000000000000000000000000000000000',
        qualifiedName: 'Parent.child',
        kind: 'method',
        signatureDiscriminator: 'method',
        position: { startLine: 1, startColumn: 22, endLine: 1, endColumn: 44 },
        startByte: 22,
        endByte: 44,
        sourceHash: sha256Hex(Buffer.from('child() { return 1; }', 'utf8')),
        languageId: 'typescript',
        isExact: true,
        parentSymbolId: stage.symbol.symbolId,
      };
      await coordinator.runFullRebuild({
        files: [{
          source: stage.source,
          generationId: stage.generationId,
          contentHash: stage.contentHash,
          fileCompleteness: 'complete',
          declarations: [stage.symbol, childDeclaration],
          imports: [],
          parserId: 'typescript',
          parserVersion: '1',
        }],
        merkleSnapshot: [],
      });
      await writeFile(join(projectRoot, 'src/parent.ts'), text);

      const result = await service.getFileOutline({ filePath: 'src/parent.ts' });
      expect(result).toMatchObject({ status: 'ok' });
      const symbols = (result as { symbols: Array<{ symbolId: string; parentSymbolId?: string | null }> }).symbols;
      expect(symbols).toHaveLength(2);
      expect(symbols[0]?.parentSymbolId).toBeNull();
      expect(symbols[1]?.parentSymbolId).toBe(stage.symbol.symbolId);
    });
  });

  describe('symbol resolution states', () => {
    it('returns not_found with SYMBOL_NOT_FOUND when symbol is missing', async () => {
      const result = await service.getSymbolSource({ symbolId: 'symbol_v1_missing_0000000000000000000000000000000000' });
      expect(result).toEqual({
        status: 'not_found',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'SYMBOL_NOT_FOUND',
        request: { symbolId: 'symbol_v1_missing_0000000000000000000000000000000000' },
      });
    });

    it('returns stale_identity with SYMBOL_RETIRED for a tombstoned symbol', async () => {
      const text1 = 'export function oldFn() { return 1; }';
      const stage1 = createStructuredStage('src/a.ts', text1, 'oldFn');
      await coordinator.runFullRebuild({
        files: [{
          source: stage1.source,
          generationId: stage1.generationId,
          contentHash: stage1.contentHash,
          fileCompleteness: 'complete',
          declarations: [stage1.symbol],
          imports: [],
        }],
        merkleSnapshot: [],
      });

      // Now stage and activate a new generation without oldFn to create a tombstone
      const text2 = 'export function newFn() { return 2; }';
      const stage2 = createStructuredStage('src/a.ts', text2, 'newFn');
      await stageStructuredFile(coordinator, stage2);
      await coordinator.activateFile({ filePath: 'src/a.ts', generationId: stage2.generationId });

      const result = await service.getSymbolSource({ symbolId: stage1.symbol.symbolId });
      expect(result).toEqual({
        status: 'stale_identity',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'SYMBOL_RETIRED',
        request: { symbolId: stage1.symbol.symbolId },
      });
    });

    it('returns index_incomplete when building during symbol source request', async () => {
      await catalog.setStructuredRebuildState({ rebuildState: 'building' });

      const result = await service.getSymbolSource({ symbolId: 'symbol_v1_any_000000000000000000000000000000000000' });
      expect(result).toEqual({
        status: 'index_incomplete',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'INDEX_PENDING_GENERATION',
        request: { symbolId: 'symbol_v1_any_000000000000000000000000000000000000' },
      });
    });
  });
});
