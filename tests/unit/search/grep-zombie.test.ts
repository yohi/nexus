import { afterEach, describe, expect, it, vi } from 'vitest';

import { RipgrepEngine } from '../../../src/search/grep.js';

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
    const promise = engine.search({
      query: 'alpha',
      cwd: process.cwd(),
      abortSignal: controller.signal,
    } as any);

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
      grepTimeoutMs: 50,
      killGraceMs: 1000,
      spawn: spawnImpl,
      processController: { kill },
    });

    await expect(engine.search({ query: 'alpha', cwd: process.cwd() })).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);

    expect(kill).not.toHaveBeenCalled();
  });
});
