import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 内部メソッドやプロパティを安全にテストするために公開するサブクラス
 */
class TestLanceVectorStore extends LanceVectorStore {
  /**
   * 基底クラス of private な inflightOps を取得
   */
  public get internalInflightOps(): number {
    return (this as any).inflightOps;
  }

  /**
   * 基底クラス of private な trackOp を外部公開
   * 再帰を避けるためメソッド名を変える
   */
  public async callTrackOp<T>(op: () => Promise<T>): Promise<T> {
    return (this as any).trackOp(op);
  }
}

describe('LanceVectorStore close() and trackOp() behavior', () => {
  let store: TestLanceVectorStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-test-close-'));
    store = new TestLanceVectorStore({ dimensions: 64, dbPath: tmpDir });
  });

  afterEach(async () => {
    // 指摘事項: 常にリアルタイマーに戻し、モックをリストアすることでテストの独立性を保つ
    vi.useRealTimers();
    vi.restoreAllMocks();
    await store?.close();
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

  it('trackOp — 正常完了後にカウンタが 0 に戻ること', async () => {
    let internalCount = 0;
    const result = await store.callTrackOp(async () => {
      internalCount = store.internalInflightOps;
      return 'success';
    });
    expect(result).toBe('success');
    expect(internalCount).toBe(1);
    expect(store.internalInflightOps).toBe(0);
  });

  it('trackOp — 操作が例外をスローしてもカウンタがデクリメントされること（finally 保証）', async () => {
    let internalCount = 0;
    const promise = store.callTrackOp(async () => {
      internalCount = store.internalInflightOps;
      throw new Error('test error');
    });
    await expect(promise).rejects.toThrow('test error');
    expect(internalCount).toBe(1);
    expect(store.internalInflightOps).toBe(0);
  });

  it('close() — インフライト操作中に close() を呼び出すと、操作完了まで待機してから解放されること', async () => {
    let opResolved = false;
    let opStarted = false;
    
    const opPromise = store.callTrackOp(async () => {
      opStarted = true;
      await new Promise(resolve => setTimeout(resolve, 50));
      opResolved = true;
    });

    // 操作が開始されるまで待機
    await vi.waitFor(() => {
      if (!opStarted) throw new Error('Operation not started');
    });

    const closePromise = store.close();
    
    let closeResolved = false;
    closePromise.then(() => { closeResolved = true; });

    // クローズがブロックされていることを確認
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closeResolved).toBe(false);

    await opPromise;
    await closePromise;
    expect(opResolved).toBe(true);
    expect(closeResolved).toBe(true);
  });

  it('close() — closing 状態で trackOp を呼び出すと Error がスローされること', async () => {
    const closePromise = store.close();
    
    const opPromise = store.callTrackOp(async () => {});
    await expect(opPromise).rejects.toThrow('VectorStore is closed');
    
    await closePromise;
  });

  it('close() — インフライト操作が CLOSE_TIMEOUT_MS 以内に完了しない場合、タイムアウトでリソースが強制解放されること', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      
      let opStarted = false;
      store.callTrackOp(async () => {
        opStarted = true;
        return new Promise(() => {});
      });

      await vi.runAllTicks();
      expect(opStarted).toBe(true);

      const closePromise = store.close(1000);
      await vi.runAllTicks();

      vi.advanceTimersByTime(1000);
      await vi.runAllTicks();

      await expect(closePromise).resolves.toBeUndefined();
    } finally {
      // 指摘事項: 各テストパスで確実にリアルタイマーに戻す
      vi.useRealTimers();
    }
  }, 10000);

  it('close() — タイムアウト発生時に console.error でエラーログが出力されること', async () => {
    vi.useFakeTimers();
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      let opStarted = false;
      store.callTrackOp(async () => {
        opStarted = true;
        return new Promise(() => {});
      });

      await vi.runAllTicks();
      expect(opStarted).toBe(true);

      const closePromise = store.close(1000);
      await vi.runAllTicks();

      vi.advanceTimersByTime(1000);
      await vi.runAllTicks();

      await closePromise;
      
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls[0][0]).toMatch(/close\(\) timed out after 1000ms/);
    } finally {
      vi.useRealTimers();
    }
  }, 10000);
});
