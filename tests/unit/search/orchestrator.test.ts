import { describe, expect, it } from 'vitest';

import { SearchOrchestrator } from '../../../src/search/orchestrator.js';
import type { SemanticSearchParams } from '../../../src/search/semantic.js';
import type { SearchResult } from '../../../src/types/index.js';
import { TestGrepEngine } from './test-grep-engine.js';

class TestSemanticSearch {
  constructor(private readonly results: SearchResult[]) {}

  async search(_params?: SemanticSearchParams): Promise<SearchResult[]> {
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
      semanticSearch: new TestSemanticSearch(semanticResults) as any,
      grepEngine,
      projectRoot: process.cwd(),
      rrfK: 60,
    });

    const response = await orchestrator.search({ query: 'parseConfig', topK: 5 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      source: 'hybrid',
      chunk: expect.objectContaining({ filePath: 'src/utils.ts' }),
    });
    expect(response.results[0]?.reciprocalRankScore).toBeCloseTo(2 / 61, 6);
  });

  it('preserves source for results appearing only in one list', async () => {
    const grepEngine = new TestGrepEngine();
    grepEngine.addFile('src/grep-only.ts', 'grep only content\n');

    const semanticResults: SearchResult[] = [
      {
        chunk: {
          id: 'src/semantic-only.ts:1',
          filePath: 'src/semantic-only.ts',
          content: 'semantic only content',
          language: 'typescript',
          symbolKind: 'unknown',
          startLine: 1,
          endLine: 1,
          hash: 'hash-semantic',
        },
        score: 0.8,
        source: 'semantic',
      },
    ];

    const orchestrator = new SearchOrchestrator({
      semanticSearch: new TestSemanticSearch(semanticResults) as never,
      grepEngine,
      projectRoot: process.cwd(),
    });

    const response = await orchestrator.search({ query: 'content', topK: 10 });

    const semanticResult = response.results.find((r) => r.chunk.filePath === 'src/semantic-only.ts');
    const grepResult = response.results.find((r) => r.chunk.filePath === 'src/grep-only.ts');

    expect(semanticResult?.source).toBe('semantic');
    expect(grepResult?.source).toBe('grep');
  });
});
