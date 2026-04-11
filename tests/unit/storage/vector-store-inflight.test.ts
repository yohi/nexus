import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('LanceVectorStore close() behavior', () => {
  let store: LanceVectorStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-test-close-'));
    store = new LanceVectorStore({ dimensions: 64, dbPath: tmpDir });
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('close() — インフライト操作なしの場合は即座にリソースが解放される', async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('close() — 二重呼び出しで冪等（2回目は即座に return）', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('close() — 初期化済みインスタンスでも正常にクローズされ冪等である', async () => {
    await store.initialize();
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
