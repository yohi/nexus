import * as lancedb from '@lancedb/lancedb';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
    });

    afterEach(async () => {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('initialize() — isClosed が true の場合にエラーを送出', async () => {
      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
      await store.close();
      await expect(store.initialize()).rejects.toThrow('VectorStore is closed');
    });

    it('stageLegacyShadowChunks() — 非有限ベクトルを拒否する', async () => {
      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
      const shadow = await store.beginLegacyShadowTable();
      const vector = new Array(64).fill(0);
      vector[0] = Number.NaN;

      await expect(store.stageLegacyShadowChunks(shadow, [{ chunk: makeChunk(), vector }])).rejects.toThrow(
        'VectorStore.stageLegacyShadowChunks: vector contains non-finite values for chunk chunk-1',
      );
      await store.abortLegacyShadowTable(shadow);
      await store.close();
    });

    it('compactAfterReindex() — optimize() が呼ばれた場合に compacted を true にする', async () => {
      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
      // チャンクを追加してテーブルを作成させる
      await store.upsertChunks([makeChunk()], [Array(64).fill(0)]);
      const result = await store.compactAfterReindex();
      expect(result.compacted).toBe(true);
      await store.close();
    });

    it('次元不一致の検出 — metadata.json から既存の次元を検証', async () => {
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
    });

    it('次元不一致の検出 — 空のテーブルでメタデータがない場合に再初期化を要求', async () => {
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
      await rm(join(tmpDir, 'metadata.json'));

      const store2 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await expect(store2.initialize()).rejects.toThrow(
        /VectorStore dimension mismatch: empty table without sidecar metadata/
      );
    });

    it('永続化 — initialize 後にデータが再読み込み可能', async () => {
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
    });

    it('recoverInterruptedFullRebuild() — 復元後にカウンタとサイドカーを整合させる', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      const store1 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64, deferRebuildCleanup: true });
      await store1.initialize();
      await store1.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b', filePath: 'src/b.ts' }),
        ],
        [embedding, embedding],
      );
      await store1.upsertChunks([makeChunk({ id: 'a-new', filePath: 'src/a.ts' })], [embedding]);

      const shadow = await store1.beginLegacyShadowTable();
      await store1.stageLegacyShadowDeletions(shadow, { filePaths: ['src/b.ts'] });
      await store1.swapLegacyShadowTable(shadow);

      const store2 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64, deferRebuildCleanup: true });
      await store2.initialize();
      await store2.recoverInterruptedFullRebuild('rollback');

      await expect(store2.getStats()).resolves.toMatchObject({
        totalChunks: 2,
        totalFiles: 2,
        fragmentationRatio: 0,
      });
      await expect(readFile(join(tmpDir, 'metadata.json'), 'utf8').then((content) => JSON.parse(content))).resolves.toMatchObject({
        staleCount: '0',
        totalFiles: '2',
      });

      await store2.close();
      await store1.close();
    });

    it('検索結果 — 保存済み generationid を generationId として復元', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      const db = await lancedb.connect(tmpDir);
      await db.createTable('chunks', [{
        vector: embedding,
        id: 'generation-test',
        filepath: 'src/generation.ts',
        content: 'export const value = 1;',
        language: 'typescript',
        symbolname: 'value',
        symbolkind: 'constant',
        startline: 1,
        endline: 1,
        hash: 'generation-hash',
        generationid: 'generation-1',
      }]);
      await writeFile(
        join(tmpDir, 'metadata.json'),
        JSON.stringify({ dimensions: '64', totalFiles: '1' }),
        'utf8',
      );

      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();
      const results = await store.search(embedding, 10);

      expect(results[0]?.generationId).toBe('generation-1');
      await store.close();
    });

    it('upsertChunks() — generationId を保存して検索結果へ復元', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store.initialize();

      const chunk = {
        ...makeChunk({ id: 'generation-upsert' }),
        generationId: 'generation-upsert-1',
      };

      try {
        await store.upsertChunks([chunk], [embedding]);
        const results = await store.search(embedding, 10);

        expect(results[0]?.generationId).toBe('generation-upsert-1');
      } finally {
        await store.close();
      }
    });
  });
});
