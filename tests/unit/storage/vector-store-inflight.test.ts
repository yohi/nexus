import { describe, it, expect, beforeEach } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

describe('LanceVectorStore close() behavior', () => {
  let store: LanceVectorStore;

  beforeEach(() => {
    store = new LanceVectorStore({ dimensions: 64 });
  });

  it('close() — インフライト操作なしの場合は即座にリソースが解放される', async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('close() — 二重呼び出しで冪等（2回目は即座に return）', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});