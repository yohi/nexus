import { describe, expect, it } from 'vitest';

import { SearchOrchestrator } from '../../../src/search/orchestrator.js';
import type { RankedResult, SearchResult } from '../../../src/types/index.js';
import { TestGrepEngine } from './test-grep-engine.js';

class TestSemanticSearch {
  constructor(private readonly results: SearchResult[]) {}

  async search(): Promise<SearchResult[]> {
    return this.results;
  }
}

describe('SearchOrchestrator', () => {
  it('fuses semantic and grep results through RRF', async () => {
    const grepEngine = new TestGrepEngine();
    grepEngine.addFile('src/utils.ts', 'export function parseConfig() {}\n');

    const semanticResults: SearchResult[] = [
      {
        chunk: {
          id: 'src/utils.ts:1',
          filePath: 'src/utils.ts',
          content: 'export function parseConfig() {}',
          language: 'typescript',
          symbolName: 'parseConfig',
          symbolKind: 'function',
          startLine: 1,
          endLine: 1,
          hash: 'hash-1',
        },
        score: 0.9,
        source: 'semantic',
      },
    ];

    const orchestrator = new SearchOrchestrator({
      semanticSearch: new TestSemanticSearch(semanticResults) as never,
      grepEngine,
      rrfK: 60,
    });

    const response = await orchestrator.search({ query: 'parseConfig', topK: 5 });
    const ranked = response.results as RankedResult[];

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({
      source: 'hybrid',
      chunk: expect.objectContaining({ filePath: 'src/utils.ts' }),
    });
    expect(ranked[0]?.reciprocalRankScore).toBeCloseTo(2 / 61, 6);
  });
});
