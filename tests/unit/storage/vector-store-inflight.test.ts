import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('LanceVectorStore close() and trackOp() behavior', () => {
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
    vi.restoreAllMocks();
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
    const result = await (store as any).trackOp(async () => {
      internalCount = (store as any).inflightOps;
      return 'success';
    });
    expect(result).toBe('success');
    expect(internalCount).toBe(1);
    expect((store as any).inflightOps).toBe(0);
  });

  it('trackOp — 操作が例外をスローしてもカウンタがデクリメントされること（finally 保証）', async () => {
    let internalCount = 0;
    const promise = (store as any).trackOp(async () => {
      internalCount = (store as any).inflightOps;
      throw new Error('test error');
    });
    await expect(promise).rejects.toThrow('test error');
    expect(internalCount).toBe(1);
    expect((store as any).inflightOps).toBe(0);
  });

  it('close() — インフライト操作中に close() を呼び出すと、操作完了まで待機してから解放されること', async () => {
    let opResolved = false;
    let opStarted = false;
    
    // Start a long-running operation
    const opPromise = (store as any).trackOp(async () => {
      opStarted = true;
      await new Promise(resolve => setTimeout(resolve, 50));
      opResolved = true;
    });

    // Wait until it actually starts
    while (!opStarted) {
      await new Promise(resolve => setImmediate(resolve));
    }

    // Now call close
    const closePromise = store.close();
    
    // close() shouldn't be done yet
    let closeResolved = false;
    closePromise.then(() => { closeResolved = true; });

    // Wait briefly to confirm close is blocked
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closeResolved).toBe(false);

    // Wait for everything
    await opPromise;
    await closePromise;
    expect(opResolved).toBe(true);
    expect(closeResolved).toBe(true);
  });

  it('close() — closing 状態で trackOp を呼び出すと Error がスローされること', async () => {
    // Start closing
    const closePromise = store.close();
    
    // Try to start a new operation
    const opPromise = (store as any).trackOp(async () => {});
    await expect(opPromise).rejects.toThrow('VectorStore is closed');
    
    await closePromise;
  });

  it('close() — インフライト操作が CLOSE_TIMEOUT_MS 以内に完了しない場合、タイムアウトでリソースが強制解放されること', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Start a hanging operation
    let opStarted = false;
    const hangingOp = (store as any).trackOp(async () => {
      opStarted = true;
      // Never resolves
      return new Promise(() => {});
    });

    while (!opStarted) {
      // Need real timers to wait for the promise to start
      // But we are in fake timers, so we just await Promise.resolve
      await Promise.resolve();
    }

    const closePromise = store.close();

    // Advance timers by CLOSE_TIMEOUT_MS (5000ms)
    await vi.advanceTimersByTimeAsync(5000);

    // close() should resolve due to timeout
    await expect(closePromise).resolves.toBeUndefined();
    
    vi.useRealTimers();
  });

  it('close() — タイムアウト発生時に console.error でエラーログが出力されること', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Start a hanging operation
    let opStarted = false;
    const hangingOp = (store as any).trackOp(async () => {
      opStarted = true;
      return new Promise(() => {});
    });

    while (!opStarted) {
      await Promise.resolve();
    }

    const closePromise = store.close();

    await vi.advanceTimersByTimeAsync(5000);
    await closePromise;
    
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toMatch(/close\(\) timed out after \d+ms/);
    
    vi.useRealTimers();
  });
});
