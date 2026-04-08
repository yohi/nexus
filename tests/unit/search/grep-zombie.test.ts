import { afterEach, describe, expect, it, vi } from 'vitest';

import { RipgrepEngine } from '../../../src/search/grep.js';
import type { GrepParams } from '../../../src/types/index.js';

describe('RipgrepEngine zombie prevention', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM on timeout and SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const spawnImpl = vi.fn(async (_params, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepMaxConcurrency: 1,
      grepTimeoutMs: 50,
      killGraceMs: 1000,
      spawn: spawnImpl,
      processController: { kill },
    });

    const promise = engine.search({ query: 'alpha', cwd: process.cwd() });

    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    await expect(promise).resolves.toEqual([]);
  });

  it('sends SIGTERM on timeout but cancels SIGKILL if resolving within grace period', async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    let resolveSearch: (() => void) | undefined;
    const spawnImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSearch = resolve;
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

    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith('SIGTERM');

    resolveSearch?.();
    await expect(searchPromise).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).not.toHaveBeenCalledWith('SIGKILL');
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

  it('cancels pending SIGKILL escalation when the search completes cleanly', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const spawnImpl = vi.fn(async () => []);

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepMaxConcurrency: 1,
      grepTimeoutMs: 50,
      killGraceMs: 1000,
      spawn: spawnImpl,
      processController: { kill },
    });

    await expect(engine.search({ query: 'alpha', cwd: process.cwd() })).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(kill).not.toHaveBeenCalled();
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
    expect(firstKill).toHaveBeenCalledTimes(1);
    expect(secondKill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(firstKill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(secondKill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });
});
