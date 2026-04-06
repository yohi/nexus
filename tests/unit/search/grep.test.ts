import { afterEach, describe, expect, it, vi } from 'vitest';

import { RipgrepEngine } from '../../../src/search/grep.js';
import { TestGrepEngine } from './test-grep-engine.js';

describe('TestGrepEngine', () => {
  it('returns deterministic in-memory matches without spawning processes', async () => {
    const engine = new TestGrepEngine();
    engine.addFile('src/auth.ts', 'export function authenticate() {}\nconst token = 1;\n');
    engine.addFile('src/config.ts', 'export const config = true;\n');

    const results = await engine.search({
      query: 'authenticate',
      cwd: process.cwd(),
      maxResults: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      filePath: 'src/auth.ts',
      lineNumber: 1,
      lineText: 'export function authenticate() {}',
    });
  });
});

describe('RipgrepEngine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks requests above maxConcurrency until a slot is released', async () => {
    let releaseFirst: (() => void) | undefined;
    const spawnImpl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve([]);
          }),
      )
      .mockResolvedValueOnce([]);

    const engine = new RipgrepEngine({
      projectRoot: process.cwd(),
      grepMaxConcurrency: 1,
      grepTimeoutMs: 100,
      spawn: spawnImpl,
    });

    const first = engine.search({ query: 'alpha', cwd: process.cwd() });
    const second = engine.search({ query: 'beta', cwd: process.cwd() });

    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('returns an empty result when the request times out', async () => {
    vi.useFakeTimers();
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
    });

    const searchPromise = engine.search({ query: 'alpha', cwd: process.cwd() } as any);
    await vi.advanceTimersByTimeAsync(50);

    await expect(searchPromise).resolves.toEqual([]);
  });
});
