import { describe, expect, it } from 'vitest';

import { executeSemanticSearch } from '../../../../src/server/tools/semantic-search.js';
import type { SearchResult } from '../../../../src/types/index.js';
import type { SemanticSearchParams } from '../../../../src/search/semantic.js';
import { PathTraversalError } from '../../../../src/types/index.js';

class StubSemanticSearch {
  public lastSearchArgs?: SemanticSearchParams;

  constructor(private readonly results: SearchResult[]) {}

  async search(params: SemanticSearchParams): Promise<SearchResult[]> {
    this.lastSearchArgs = params;
    return this.results;
  }
}

describe('executeSemanticSearch', () => {
  it('returns semantic search results as structured content and captures args', async () => {
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

    const stub = new StubSemanticSearch(results);
    const args = { query: 'authenticate', topK: 5 };
    const searchResult = await executeSemanticSearch(stub, args);

    expect(searchResult).toEqual({ results });
    expect(stub.lastSearchArgs).toEqual(args);
  });

  it('rejects filePattern with parent traversal', async () => {
    const stub = new StubSemanticSearch([]);

    await expect(
      executeSemanticSearch(stub, {
        query: 'authenticate',
        filePattern: '../*.ts',
      }),
    ).rejects.toBeInstanceOf(PathTraversalError);
    expect(stub.lastSearchArgs).toBeUndefined();
  });
});
