import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CodeChunk, IVectorStore } from '../../src/types/index.js';

const makeChunk = (overrides: Partial<CodeChunk> = {}): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/index.ts',
  content: overrides.content ?? 'export const value = 1;',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
  symbolId: overrides.symbolId,
});

const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

const upsertChunks = async (store: IVectorStore, chunks: CodeChunk[]): Promise<void> => {
  await store.upsertChunks(chunks, chunks.map(() => embedding));
};

interface StructuredFixture {
  readonly filePath: string;
  readonly generationId: string;
  readonly chunkId: string;
  readonly symbolId: string;
}

const stageGeneration = async (store: IVectorStore, fixture: StructuredFixture): Promise<void> => {
  await store.stageGenerationChunks({
    filePath: fixture.filePath,
    generationId: fixture.generationId,
    chunks: [makeChunk({ id: fixture.chunkId, filePath: fixture.filePath, symbolId: fixture.symbolId })],
    vectors: [embedding],
  });
};

interface SearchExpectation {
  readonly count: number;
  readonly chunkId?: string;
  readonly filePath?: string;
  readonly generationId?: string;
  readonly language?: string;
}

const expectSearchResults = async (
  store: IVectorStore,
  expectation: SearchExpectation,
): Promise<void> => {
  const results = await store.search(embedding, 10);
  expect(results).toHaveLength(expectation.count);
  if (expectation.chunkId !== undefined) {
    expect(results[0]?.chunk.id).toBe(expectation.chunkId);
  }
  if (expectation.filePath !== undefined) {
    expect(results[0]?.chunk.filePath).toBe(expectation.filePath);
  }
  if (expectation.generationId !== undefined) {
    expect(results[0]?.generationId).toBe(expectation.generationId);
  }
  if (expectation.language !== undefined) {
    expect(results[0]?.chunk.language).toBe(expectation.language);
  }
};

export function vectorStoreContractTests(
  factory: () => Promise<{ store: IVectorStore; cleanup: () => Promise<void> }>,
): void {
  let store: IVectorStore;
  let cleanup: () => Promise<void> = async () => {};

  beforeEach(async () => {
    ({ store, cleanup } = await factory());
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('Contract: IVectorStore', () => {
    it('initialize() — 二重呼び出しで冪等', async () => {
      await expect(store.initialize()).resolves.toBeUndefined();
      await expect(store.initialize()).resolves.toBeUndefined();
    });

    it('upsertChunks() → search() で取得可能', async () => {
      await upsertChunks(store, [makeChunk({ id: 'a', filePath: 'src/a.ts' })]);
      await expectSearchResults(store, { count: 1, chunkId: 'a' });
    });

    it('deleteByFilePath() — 該当ファイルのチャンクが全削除', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
        makeChunk({ id: 'b1', filePath: 'src/b.ts' }),
      ]);
      const deleted = await store.deleteByFilePath('src/a.ts');
      expect(deleted).toBe(1);
      await expectSearchResults(store, { count: 1, filePath: 'src/b.ts' });
    });

    it('deleteByPathPrefix() — プレフィックス配下の全チャンク削除', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
        makeChunk({ id: 'b1', filePath: 'src/nested/b.ts' }),
        makeChunk({ id: 'c1', filePath: 'tests/test.ts' }),
      ]);
      const deleted = await store.deleteByPathPrefix('src');
      expect(deleted).toBe(2);
      await expectSearchResults(store, { count: 1, filePath: 'tests/test.ts' });
    });

    it('renameFilePath() — 新パスで検索可能、旧パスでは 0 件、更新行数が正確', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'src/file.ts:1-10', filePath: 'src/file.ts' }),
        makeChunk({ id: 'src/file.ts:11-20', filePath: 'src/file.ts' }),
      ]);

      const count = await store.renameFilePath('src/file.ts', 'src/moved.ts');
      expect(count).toBe(2);

      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.chunk.filePath === 'src/moved.ts')).toBe(true);
    });

    it('search() — topK 制限', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a', filePath: 'src/a.ts' }),
        makeChunk({ id: 'b', filePath: 'src/b.ts' }),
        makeChunk({ id: 'c', filePath: 'src/c.ts' }),
      ]);
      const results = await store.search(embedding, 2);
      expect(results).toHaveLength(2);
    });

    it('search() — filter 適用', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a', filePath: 'src/a.ts', language: 'typescript' }),
        makeChunk({ id: 'b', filePath: 'src/b.py', language: 'python' }),
      ]);
      const results = await store.search(embedding, 10, { language: 'typescript' });
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.language).toBe('typescript');
    });

    it('getStats() — レコード数が正確', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a', filePath: 'src/a.ts' }),
        makeChunk({ id: 'b', filePath: 'src/b.ts' }),
      ]);
      const stats = await store.getStats();
      expect(stats.totalChunks).toBe(2);
    });

    it('close() — 二重呼び出しで冪等（例外をスローしない）', async () => {
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
    });

    it('structured rows are not returned until activated', async () => {
      const fixture = { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a', symbolId: 'symbol-1' };
      await stageGeneration(store, fixture);
      await expectSearchResults(store, { count: 0 });

      await store.activateGenerationRows('src/a.ts', 'gen-1');

      await expectSearchResults(store, { count: 1, chunkId: 'a', generationId: 'gen-1' });
      const activeResults = await store.search(embedding, 10);
      expect(activeResults[0]?.chunk.symbolId).toBe('symbol-1');
    });

    it('structured activation does not affect other generations', async () => {
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a1', symbolId: 'symbol-1' });
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-2', chunkId: 'a2', symbolId: 'symbol-2' });

      await store.activateGenerationRows('src/a.ts', 'gen-1');
      await expectSearchResults(store, { count: 1, generationId: 'gen-1' });
    });

    it('removeGenerationRows deletes only the targeted file+generation', async () => {
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a1', symbolId: 'symbol-1' });
      await stageGeneration(store, { filePath: 'src/b.ts', generationId: 'gen-1', chunkId: 'b1', symbolId: 'symbol-1' });

      await store.activateGenerationRows('src/a.ts', 'gen-1');
      await store.activateGenerationRows('src/b.ts', 'gen-1');
      await store.removeGenerationRows('src/a.ts', 'gen-1');

      await expectSearchResults(store, { count: 1, filePath: 'src/b.ts' });
    });

    it('reconcileStructuredRows keeps only catalog-active generations', async () => {
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a1', symbolId: 'symbol-1' });
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-2', chunkId: 'a2', symbolId: 'symbol-2' });

      await store.activateGenerationRows('src/a.ts', 'gen-1');
      await store.activateGenerationRows('src/a.ts', 'gen-2');
      await store.reconcileStructuredRows([{ filePath: 'src/a.ts', generationId: 'gen-2' }]);

      await expectSearchResults(store, { count: 1, generationId: 'gen-2' });
    });

    it('stages a new generation after reconciling all structured rows', async () => {
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a1', symbolId: 'symbol-1' });
      await store.activateGenerationRows('src/a.ts', 'gen-1');
      await store.reconcileStructuredRows([]);

      await stageGeneration(store, { filePath: 'src/b.ts', generationId: 'gen-2', chunkId: 'b1', symbolId: 'symbol-2' });
      await store.activateGenerationRows('src/b.ts', 'gen-2');

      await expectSearchResults(store, { count: 1, chunkId: 'b1', generationId: 'gen-2' });
    });

    it('shadow table swap replaces structured rows atomically', async () => {
      await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a1', symbolId: 'symbol-1' });
      await store.activateGenerationRows('src/a.ts', 'gen-1');

      const shadowTable = await store.beginStructuredShadowTable();
      await stageGeneration(store, { filePath: 'src/b.ts', generationId: 'gen-2', chunkId: 'b1', symbolId: 'symbol-2' });
      await store.swapStructuredShadowTable(shadowTable);

      await expectSearchResults(store, { count: 1, filePath: 'src/b.ts' });
    });

    it('shadow table swap preserves rows copied across batches', async () => {
      const chunkCount = 501;
      const chunks = Array.from({ length: chunkCount }, (_, index) => makeChunk({
        id: `bulk-${index}`,
        filePath: 'src/bulk.ts',
        symbolName: `symbol-${index}`,
        symbolId: `symbol-${index}`,
        startLine: index + 1,
        endLine: index + 1,
        hash: `hash-${index}`,
      }));
      const shadowTable = await store.beginStructuredShadowTable();

      await store.stageGenerationChunks({
        filePath: 'src/bulk.ts',
        generationId: 'gen-bulk',
        chunks,
        vectors: chunks.map(() => embedding),
      });
      await store.swapStructuredShadowTable(shadowTable);

      const results = await store.search(embedding, chunkCount);
      expect(results).toHaveLength(chunkCount);
      expect(new Set(results.map((result) => result.chunk.id)).size).toBe(chunkCount);
      expect(results.every((result) => result.generationId === 'gen-bulk')).toBe(true);
    });

    it('legacy upsert results do not carry generationId', async () => {
      await upsertChunks(store, [makeChunk({ id: 'legacy', filePath: 'src/legacy.ts' })]);
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.generationId).toBeUndefined();
      expect(results[0]?.chunk.symbolId).toBeUndefined();
    });

    it('deduplicates a chunk ID shared by legacy and structured rows', async () => {
      await upsertChunks(store, [makeChunk({ id: 'duplicate', filePath: 'src/duplicate.ts' })]);
      await stageGeneration(store, {
        filePath: 'src/duplicate.ts',
        generationId: 'gen-1',
        chunkId: 'duplicate',
        symbolId: 'symbol-1',
      });
      await store.activateGenerationRows('src/duplicate.ts', 'gen-1');

      const results = await store.search(embedding, 10);

      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.id).toBe('duplicate');
      expect(results[0]?.generationId).toBe('gen-1');
    });

    it('legacy shadow staging does not affect the live table until swap', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
        makeChunk({ id: 'b1', filePath: 'src/b.ts' }),
      ]);

      const shadow = await store.beginLegacyShadowTable();
      await store.stageLegacyShadowChunks(shadow, [
        { chunk: makeChunk({ id: 'a2', filePath: 'src/a.ts' }), vector: embedding },
      ]);
      await store.stageLegacyShadowDeletions(shadow, { filePaths: ['src/b.ts'] });

      // Live rows stay untouched while the shadow is open.
      await expectSearchResults(store, { count: 2, chunkId: 'a1' });

      await store.swapLegacyShadowTable(shadow);
      await expectSearchResults(store, { count: 1, chunkId: 'a2', filePath: 'src/a.ts' });
    });

    it('legacy shadow abort leaves live rows and counters unchanged', async () => {
      await upsertChunks(store, [makeChunk({ id: 'a1', filePath: 'src/a.ts' })]);
      const statsBefore = await store.getStats();

      const shadow = await store.beginLegacyShadowTable();
      await store.stageLegacyShadowChunks(shadow, [
        { chunk: makeChunk({ id: 'a2', filePath: 'src/a.ts' }), vector: embedding },
      ]);
      await store.stageLegacyShadowDeletions(shadow, { filePaths: ['src/a.ts'] });
      await store.abortLegacyShadowTable(shadow);

      await expectSearchResults(store, { count: 1, chunkId: 'a1' });
      await expect(store.getStats()).resolves.toEqual(statsBefore);
    });

    it('legacy shadow staging replaces rows for the same file and stages prefix deletions', async () => {
      await upsertChunks(store, [
        makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
        makeChunk({ id: 'a2', filePath: 'src/a.ts' }),
        makeChunk({ id: 'nested1', filePath: 'src/nested/b.ts' }),
        makeChunk({ id: 'c1', filePath: 'docs/c.ts' }),
      ]);

      const shadow = await store.beginLegacyShadowTable();
      await store.stageLegacyShadowChunks(shadow, [
        { chunk: makeChunk({ id: 'a1b', filePath: 'src/a.ts' }), vector: embedding },
      ]);
      await store.stageLegacyShadowDeletions(shadow, { pathPrefixes: ['src/nested'] });
      await store.swapLegacyShadowTable(shadow);

      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.chunk.id).sort()).toEqual(['a1b', 'c1']);
      const stats = await store.getStats();
      expect(stats.totalChunks).toBe(2);
      expect(stats.totalFiles).toBe(2);
    });
  });
}
