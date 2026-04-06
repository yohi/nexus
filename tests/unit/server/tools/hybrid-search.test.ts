import { describe, expect, it } from 'vitest';

import { executeHybridSearch } from '../../../../src/server/tools/hybrid-search.js';
import type { SearchResponse } from '../../../../src/types/index.js';
import { PathTraversalError } from '../../../../src/server/path-sanitizer.js';

class StubOrchestrator {
  public lastSearchArgs?: Record<string, unknown>;

  constructor(private readonly response: SearchResponse) {}

  async search(args: Record<string, unknown>): Promise<SearchResponse> {
    this.lastSearchArgs = args;
    return this.response;
  }
}

describe('executeHybridSearch', () => {
  const response: SearchResponse = {
    query: 'authenticate',
    tookMs: 3,
    results: [],
  };

  const sanitizer = {
    validateGlob: (pattern: string) => {
      if (pattern.includes('..')) {
        throw new PathTraversalError(pattern);
      }
      return pattern;
    },
  };

  it('delegates to the orchestrator and validates filePattern', async () => {
    const orchestrator = new StubOrchestrator(response);

    await expect(
      executeHybridSearch(orchestrator as never, sanitizer as never, {
        query: 'authenticate',
        filePattern: 'src/*.ts',
      }),
    ).resolves.toEqual(response);

    expect(orchestrator.lastSearchArgs).toMatchObject({
      query: 'authenticate',
      filePattern: 'src/*.ts',
    });
  });

  it('forwards abortSignal to the orchestrator', async () => {
    const controller = new AbortController();
    const orchestrator = new StubOrchestrator(response);

    await executeHybridSearch(
      orchestrator as never,
      sanitizer as never,
      { query: 'authenticate' },
      controller.signal,
    );

    expect(orchestrator.lastSearchArgs).toEqual({
      query: 'authenticate',
      abortSignal: controller.signal,
    });
  });

  it('rejects directory traversal in filePattern before calling the orchestrator', async () => {
    const orchestrator = new StubOrchestrator(response);

    await expect(
      executeHybridSearch(orchestrator as never, sanitizer as never, {
        query: 'authenticate',
        filePattern: '../outside',
      }),
    ).rejects.toThrow(PathTraversalError);

    expect(orchestrator.lastSearchArgs).toBeUndefined();
  });
});
