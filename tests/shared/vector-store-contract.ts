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
});

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
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [makeChunk({ id: 'a', filePath: 'src/a.ts' })],
        [embedding],
      );
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.id).toBe('a');
    });

    it('deleteByFilePath() — 該当ファイルのチャンクが全削除', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b1', filePath: 'src/b.ts' }),
        ],
        [embedding, embedding],
      );
      const deleted = await store.deleteByFilePath('src/a.ts');
      expect(deleted).toBe(1);
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.filePath).toBe('src/b.ts');
    });

    it('deleteByPathPrefix() — プレフィックス配下の全チャンク削除', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b1', filePath: 'src/nested/b.ts' }),
          makeChunk({ id: 'c1', filePath: 'tests/test.ts' }),
        ],
        [embedding, embedding, embedding],
      );
      const deleted = await store.deleteByPathPrefix('src');
      expect(deleted).toBe(2);
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.filePath).toBe('tests/test.ts');
    });

    it('renameFilePath() — 新パスで検索可能、旧パスでは 0 件、更新行数が正確', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'src/file.ts:1-10', filePath: 'src/file.ts' }),
          makeChunk({ id: 'src/file.ts:11-20', filePath: 'src/file.ts' }),
        ],
        [embedding, embedding],
      );

      const count = await store.renameFilePath('src/file.ts', 'src/moved.ts');
      expect(count).toBe(2);

      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.chunk.filePath === 'src/moved.ts')).toBe(true);
    });

    it('search() — topK 制限', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b', filePath: 'src/b.ts' }),
          makeChunk({ id: 'c', filePath: 'src/c.ts' }),
        ],
        [embedding, embedding, embedding],
      );
      const results = await store.search(embedding, 2);
      expect(results).toHaveLength(2);
    });

    it('search() — filter 適用', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts', language: 'typescript' }),
          makeChunk({ id: 'b', filePath: 'src/b.py', language: 'python' }),
        ],
        [embedding, embedding],
      );
      const results = await store.search(embedding, 10, { language: 'typescript' });
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.language).toBe('typescript');
    });

    it('getStats() — レコード数が正確', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b', filePath: 'src/b.ts' }),
        ],
        [embedding, embedding],
      );
      const stats = await store.getStats();
      expect(stats.totalChunks).toBe(2);
    });

    it('close() — 二重呼び出しで冪等（例外をスローしない）', async () => {
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
    });
  });
}