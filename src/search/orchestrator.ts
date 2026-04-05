import type { SearchResponse } from '../types/index.js';
import type { IGrepEngine } from './grep-interface.js';
import type { SemanticSearch, SemanticSearchParams } from './semantic.js';
import { fuseResults } from './rrf.js';

export interface HybridSearchParams extends SemanticSearchParams {
  grepPattern?: string;
}

interface SearchOrchestratorOptions {
  semanticSearch: SemanticSearch;
  grepEngine: IGrepEngine;
  rrfK?: number;
}

export class SearchOrchestrator {
  private readonly rrfK: number;

  constructor(private readonly options: SearchOrchestratorOptions) {
    this.rrfK = options.rrfK ?? 60;
  }

  async search(params: HybridSearchParams): Promise<SearchResponse> {
    const startedAt = Date.now();
    const topK = params.topK ?? 20;
    const grepQuery = params.grepPattern ?? params.query;

    const [semanticResults, grepMatches] = await Promise.all([
      this.options.semanticSearch.search(params),
      this.options.grepEngine.search({
        query: grepQuery,
        cwd: process.cwd(),
        glob: params.filePattern ? [params.filePattern] : undefined,
        maxResults: topK,
      }),
    ]);

    const grepResults = grepMatches.map((match) => ({
      chunk: {
        id: `${match.filePath}:${match.lineNumber}`,
        filePath: match.filePath,
        content: match.lineText,
        language: inferLanguage(match.filePath),
        symbolName: `line_${match.lineNumber}`,
        symbolKind: 'unknown' as const,
        startLine: match.lineNumber,
        endLine: match.lineNumber,
        hash: `${match.filePath}:${match.lineNumber}:${match.lineText}`,
      },
      score: 1,
      source: 'grep' as const,
    }));

    return {
      query: params.query,
      results: fuseResults(semanticResults, grepResults, { k: this.rrfK, topK }),
      tookMs: Date.now() - startedAt,
    };
  }
}

const inferLanguage = (filePath: string): string => {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'typescript';
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
    return 'javascript';
  }
  if (filePath.endsWith('.py')) {
    return 'python';
  }
  return 'unknown';
};
