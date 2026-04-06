import { afterEach, describe, expect, it, vi } from 'vitest';

import { RipgrepEngine } from '../../../src/search/grep.js';

describe('RipgrepEngine zombie prevention', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM on timeout and SIGKILL after the grace period', async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    let release: (() => void) | undefined;
    const spawn = vi.fn(async (_params, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          release = resolve;
        }, { once: true });
      });

      return [];
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs: 50,
      spawn,
      createProcessController: () => ({ kill }),
    });

    const searchPromise = engine.search({ query: 'alpha', cwd: process.cwd() });

    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    release?.();

    await expect(searchPromise).resolves.toEqual([]);
  });

  it('sends SIGTERM on timeout but cancels SIGKILL if resolving within grace period', async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    let resolveSearch: (() => void) | undefined;
    const spawn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSearch = resolve;
      });
      return [];
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs: 50,
      spawn,
      createProcessController: () => ({ kill }),
    });

    const searchPromise = engine.search({ query: 'alpha', cwd: process.cwd() });

    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith('SIGTERM');

    // Resolve search during the 100ms grace period
    resolveSearch?.();
    await expect(searchPromise).resolves.toEqual([]);

    // Advance time further to check that SIGKILL was cancelled
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('propagates client abort to the spawned process without forcing a timeout kill', async () => {
    const kill = vi.fn();
    const spawn = vi.fn(async (_params, signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      return [];
    });

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs: 1_000,
      spawn,
      createProcessController: () => ({ kill }),
    });

    const controller = new AbortController();
    const searchPromise = engine.search({
      query: 'alpha',
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();

    await expect(searchPromise).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0]?.[1].aborted).toBe(true);
  });

  it('cancels the forced kill timer after successful completion', async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    const spawn = vi.fn(async () => []);

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepTimeoutMs: 50,
      spawn,
      createProcessController: () => ({ kill }),
    });

    await expect(engine.search({ query: 'alpha', cwd: process.cwd() })).resolves.toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).not.toHaveBeenCalled();
  });
});
