import { describe, expect, it } from 'vitest';

import { executeSemanticSearch } from '../../../../src/server/tools/semantic-search.js';
import type { SearchResult } from '../../../../src/types/index.js';
import type { SemanticSearchParams } from '../../../../src/search/semantic.js';
import { PathTraversalError } from '../../../../src/server/path-sanitizer.js';

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

    const mockSanitizer = {
      validateGlob: (p: string) => p,
    };

    const stub = new StubSemanticSearch(results);
    const args = { query: 'authenticate', topK: 5 };
    const searchResult = await executeSemanticSearch(stub as any, mockSanitizer as any, args);

    expect(searchResult).toEqual({ results });
    expect(stub.lastSearchArgs).toEqual({ ...args, abortSignal: undefined });
  });

  it('forwards abortSignal to semantic search', async () => {
    const mockSanitizer = {
      validateGlob: (p: string) => p,
    };

    const stub = new StubSemanticSearch([]);
    const controller = new AbortController();

    await executeSemanticSearch(stub as any, mockSanitizer as any, { query: 'authenticate' }, controller.signal);

    expect(stub.lastSearchArgs).toEqual({
      query: 'authenticate',
      abortSignal: controller.signal,
    });
  });

  it('rejects invalid filePattern before calling semantic search', async () => {
    const mockSanitizer = {
      validateGlob: () => {
        throw new PathTraversalError('invalid');
      },
    };

    const stub = new StubSemanticSearch([]);

    await expect(
      executeSemanticSearch(
        stub as any,
        mockSanitizer as any,
        { query: 'authenticate', filePattern: '../outside' },
      ),
    ).rejects.toThrow(PathTraversalError);

    expect(stub.lastSearchArgs).toBeUndefined();
  });
});
