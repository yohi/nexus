import { describe, expect, it } from 'vitest';

import { executeHybridSearch } from '../../../../src/server/tools/hybrid-search.js';
import type { SearchResponse } from '../../../../src/types/index.js';

class StubOrchestrator {
  constructor(private readonly response: SearchResponse) {}

  async search(): Promise<SearchResponse> {
    return this.response;
  }
}

describe('executeHybridSearch', () => {
  it('delegates to the orchestrator and returns the response', async () => {
    const response: SearchResponse = {
      query: 'authenticate',
      tookMs: 3,
      results: [],
    };

    await expect(executeHybridSearch(new StubOrchestrator(response) as never, { query: 'authenticate' })).resolves.toEqual(response);
  });
});
