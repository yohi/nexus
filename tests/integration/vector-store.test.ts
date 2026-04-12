import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanceVectorStore } from '../../src/storage/vector-store.js';
import type { CodeChunk } from '../../src/types/index.js';
import { vectorStoreContractTests } from '../shared/vector-store-contract.js';

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
  vectorStoreContractTests(async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
    await store.initialize();
    return {
      store,
      cleanup: async () => {
        try {
          await store.close();
        } catch {}
        try {
          await rm(tmpDir, { recursive: true, force: true });
        } catch {}
      },
    };
  });

  describe('LanceDB-specific (Persistence & Validation)', () => {
    it('initialize() — isClosed が true の場合にエラーを送出', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-close-'));
      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
      await store.close();
      await expect(store.initialize()).rejects.toThrow('VectorStore is closed');
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('compactAfterReindex() — optimize() が呼ばれた場合に compacted を true にする', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-compact-'));
      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
      // チャンクを追加してテーブルを作成させる
      await store.upsertChunks([makeChunk()], [Array(64).fill(0)]);
      const result = await store.compactAfterReindex();
      expect(result.compacted).toBe(true);
      await store.close();
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('次元不一致の検出 — metadata.json から既存の次元を検証', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-v-'));
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

      const store1 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store1.initialize();
      await store1.upsertChunks([makeChunk({ id: 'a' })], [embedding]);
      await store1.close();

      // 異なる次元 (128) で開こうとする
      const store2 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 128 });
      await expect(store2.initialize()).rejects.toThrow(
        /VectorStore dimension mismatch: existing storage has 64, but expected 128/
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

    it('次元不一致の検出 — 空のテーブルでメタデータがない場合に再初期化を要求', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-v-empty-'));
      
      const store1 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store1.initialize();
      // テーブルは chunks という名前で作成される必要がある。
      // upsertChunks を呼ばないとテーブルは作成されないが、
      // 指摘にある「empty table without sidecar metadata」を再現するため
      // 直接 LanceDB でテーブルを作るか、メタデータだけ消す
      await store1.upsertChunks([makeChunk({ id: 'a' })], [Array(64).fill(0)]);
      // 全削除して空にする
      await store1.deleteByFilePath('src/index.ts');
      await store1.close();

      // metadata.json を削除して「空テーブル＋メタデータなし」をシミュレート
      const { rm: remove } = await import('node:fs/promises');
      await remove(join(tmpDir, 'metadata.json'));

      const store2 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await expect(store2.initialize()).rejects.toThrow(
        /VectorStore dimension mismatch: empty table without sidecar metadata/
      );

      await rm(tmpDir, { recursive: true, force: true });
    });

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