import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanceVectorStore } from '../../src/storage/vector-store.js';
import type { CodeChunk } from '../../src/types/index.js';

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

describe('LanceVectorStore (LanceDB integration)', () => {
  describe('Contract: IVectorStore', () => {
    let store: LanceVectorStore;
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
      store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
    });

    afterEach(async () => {
      try {
        await store.close();
      } catch {}
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('upsertChunks() → search() で取得可能', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks([makeChunk({ id: 'a', filePath: 'src/a.ts' })], [embedding]);
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.id).toBe('a');
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

    it('close() — 二重呼び出しで冪等', async () => {
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
    });
  });

  describe('LanceDB-specific', () => {
    it('永続化 — initialize 後にデータが再読み込み可能', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

      const store1 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store1.initialize();
      await store1.upsertChunks(
        [{
          id: 'persist-test',
          filePath: 'src/test.ts',
          content: 'test',
          language: 'typescript',
          symbolKind: 'function',
          startLine: 1,
          endLine: 1,
          hash: 'hash',
        } as CodeChunk],
        [embedding],
      );
      await store1.close();

      const store2 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store2.initialize();
      const results = await store2.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.id).toBe('persist-test');
      await store2.close();

      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});