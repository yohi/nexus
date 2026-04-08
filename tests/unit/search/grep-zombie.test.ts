import { afterEach, describe, expect, it, vi } from 'vitest';

import { RipgrepEngine } from '../../../src/search/grep.js';
import type { GrepParams } from '../../../src/types/index.js';

describe('RipgrepEngine zombie prevention', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM on timeout and SIGKILL after the grace period if zombie (resolves after timeout)', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const grepTimeoutMs = 50;
    const killGraceMs = 1000;

    const spawnImpl = vi.fn(async () => {
      // Delay resolution until after timeout
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      return [];
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs,
      killGraceMs,
      spawn: spawnImpl,
      createProcessController: () => ({ kill }),
    });

    const promise = engine.search({ query: 'alpha', cwd: process.cwd() });

    await vi.advanceTimersByTimeAsync(grepTimeoutMs);
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    // Resolves at 500ms. Since it resolved after timeout without throwing,
    // it's a "zombie" case where escalationId is preserved.
    await vi.advanceTimersByTimeAsync(450);
    await expect(promise).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('cancels SIGKILL if resolving before timeout', async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    const spawnImpl = vi.fn(async () => {
      // Delay resolution but shorter than timeout
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      return [];
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs: 50,
      spawn: spawnImpl,
      createProcessController: () => ({ kill }),
    });

    const searchPromise = engine.search({ query: 'alpha', cwd: process.cwd() });

    await vi.advanceTimersByTimeAsync(20);
    await expect(searchPromise).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).not.toHaveBeenCalled();
  });

  it('propagates client abort signals to the spawned search', async () => {
    const observedSignals: AbortSignal[] = [];
    const spawnImpl = vi.fn(async (_params, signal: AbortSignal) => {
      observedSignals.push(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs: 1000,
      spawn: spawnImpl,
    });

    const controller = new AbortController();
    const params: GrepParams = {
      query: 'alpha',
      cwd: process.cwd(),
      abortSignal: controller.signal,
    };
    const promise = engine.search(params);

    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(promise).resolves.toEqual([]);
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);
  });

  it('uses a fresh process controller for each concurrent search', async () => {
    vi.useFakeTimers();
    const firstKill = vi.fn();
    const secondKill = vi.fn();
    const controllers = [firstKill, secondKill];
    const spawnImpl = vi.fn(async (_params, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepMaxConcurrency: 2,
      grepTimeoutMs: 50,
      killGraceMs: 1000,
      spawn: spawnImpl,
      createProcessController: () => {
        const kill = controllers.shift();
        if (!kill) {
          throw new Error('missing controller');
        }
        return { kill };
      },
    });

    const first = engine.search({ query: 'alpha', cwd: process.cwd() });
    const second = engine.search({ query: 'beta', cwd: process.cwd() });

    await vi.advanceTimersByTimeAsync(50);

    expect(firstKill).toHaveBeenCalledWith('SIGTERM');
    expect(secondKill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(1000);

    expect(firstKill).toHaveBeenCalledTimes(1);
    expect(secondKill).toHaveBeenCalledTimes(1);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });
});
