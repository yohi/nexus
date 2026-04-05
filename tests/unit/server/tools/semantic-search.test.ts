import { describe, expect, it } from 'vitest';

import { executeSemanticSearch } from '../../../../src/server/tools/semantic-search.js';
import type { SearchResult } from '../../../../src/types/index.js';

class StubSemanticSearch {
  constructor(private readonly results: SearchResult[]) {}

  async search(): Promise<SearchResult[]> {
    return this.results;
  }
}

describe('executeSemanticSearch', () => {
  it('returns semantic search results as structured content', async () => {
    const results: SearchResult[] = [
      {
        chunk: {
          id: 'c1',
          filePath: 'src/auth.ts',
          content: 'export function authenticate() {}',
          language: 'typescript',
          symbolName: 'authenticate',
          symbolKind: 'function',
          startLine: 1,
          endLine: 1,
          hash: 'hash-1',
        },
        score: 0.9,
        source: 'semantic',
      },
    ];

    await expect(executeSemanticSearch(new StubSemanticSearch(results) as never, { query: 'authenticate' })).resolves.toEqual({
      results,
    });
  });
});
