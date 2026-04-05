import { describe, expect, it } from 'vitest';

import { fuseResults } from '../../../src/search/rrf.js';
import type { CodeChunk, SearchResult } from '../../../src/types/index.js';

const makeChunk = (id: string, filePath: string): CodeChunk => ({
  id,
  filePath,
  content: id,
  language: 'typescript',
  symbolKind: 'function',
  startLine: 1,
  endLine: 1,
  hash: id,
});

const makeResult = (chunk: CodeChunk, source: 'semantic' | 'grep'): SearchResult => ({
  chunk,
  score: 1,
  source,
});

describe('fuseResults', () => {
  it('adds reciprocal rank scores when the same chunk appears in both sources', () => {
    const shared = makeChunk('shared', 'src/shared.ts');
    const results = fuseResults(
      [makeResult(shared, 'semantic')],
      [makeResult(shared, 'grep')],
      { topK: 5, k: 60 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe('hybrid');
    expect(results[0]?.reciprocalRankScore).toBeCloseTo(2 / 61, 6);
  });

  it('respects topK after sorting fused results', () => {
    const results = fuseResults(
      [
        makeResult(makeChunk('a', 'src/a.ts'), 'semantic'),
        makeResult(makeChunk('b', 'src/b.ts'), 'semantic'),
      ],
      [makeResult(makeChunk('c', 'src/c.ts'), 'grep')],
      { topK: 2, k: 60 },
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.rank)).toEqual([1, 2]);
  });
});
