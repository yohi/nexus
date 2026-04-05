import type { RankedResult, SearchResult } from '../types/index.js';

export interface FuseResultsOptions {
  k?: number;
  topK?: number;
}

export const fuseResults = (
  semanticResults: SearchResult[],
  grepResults: SearchResult[],
  options: FuseResultsOptions = {},
): RankedResult[] => {
  const k = options.k ?? 60;
  const topK = options.topK ?? 20;

  if (Number.isNaN(k) || !Number.isFinite(k) || k <= 0) {
    throw new RangeError(`options.k must be a positive finite number, got ${k}`);
  }
  if (Number.isNaN(topK) || !Number.isFinite(topK) || topK <= 0) {
    throw new RangeError(`options.topK must be a positive finite number, got ${topK}`);
  }

  const scoreMap = new Map<string, RankedResult>();

  for (const [results, source] of [
    [semanticResults, 'semantic'],
    [grepResults, 'grep'],
  ] as const) {
    results.forEach((result, index) => {
      const contribution = 1 / (k + index + 1);
      const existing = scoreMap.get(result.chunk.id);

      if (existing) {
        existing.reciprocalRankScore += contribution;
        existing.score = existing.reciprocalRankScore;
        existing.source = 'hybrid';
        return;
      }

      scoreMap.set(result.chunk.id, {
        ...result,
        rank: 0,
        reciprocalRankScore: contribution,
      });
    });
  }

  return [...scoreMap.values()]
    .sort(
      (left, right) =>
        right.reciprocalRankScore - left.reciprocalRankScore || left.chunk.filePath.localeCompare(right.chunk.filePath),
    )
    .slice(0, topK)
    .map((result, index) => ({
      ...result,
      rank: index + 1,
      score: result.reciprocalRankScore,
    }));
};
