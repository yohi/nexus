import * as path from 'node:path';

import type { SearchResponse } from '../types/index.js';
import type { IGrepEngine } from './grep-interface.js';
import type { SemanticSearch, SemanticSearchParams } from './semantic.js';
import { fuseResults } from './rrf.js';
import type { RuntimeObserver } from '../observability/runtime-observer.js';
import { captureObservedGrep, observeRuntimeWork } from '../observability/runtime-work.js';

export interface HybridSearchParams extends SemanticSearchParams {
  grepPattern?: string;
}

export interface ILogger {
  error(message: string, ...args: unknown[]): void;
}

export interface SearchOrchestratorOptions {
  observer?: RuntimeObserver;
  semanticSearch: SemanticSearch;
  grepEngine: IGrepEngine;
  projectRoot: string;
  rrfK?: number;
  logger?: ILogger;
}

export class SearchOrchestrator {
  private readonly rrfK: number;
  private readonly logger: ILogger;

  constructor(private readonly options: SearchOrchestratorOptions) {
    this.rrfK = options.rrfK ?? 60;
    this.logger = options.logger ?? console;
  }

  async search(params: HybridSearchParams): Promise<SearchResponse> {
    return observeRuntimeWork(this.options.observer, 'hybrid', () => this.searchUnobserved(params), params.abortSignal);
  }

  private async searchUnobserved(params: HybridSearchParams): Promise<SearchResponse> {
    const startedAt = Date.now();
    const topK = params.topK ?? 20;
    const grepQuery = params.grepPattern ?? params.query;

    const [semanticResult, grepResult] = await Promise.allSettled([
      observeRuntimeWork(this.options.observer, 'semantic_branch', () => this.options.semanticSearch.search(params), params.abortSignal),
      observeRuntimeWork(this.options.observer, 'grep_branch', () => this.options.grepEngine.search({
        query: grepQuery,
        cwd: this.options.projectRoot,
        glob: params.filePatterns,
        maxResults: topK,
        abortSignal: params.abortSignal,
      }), params.abortSignal),
    ]);

    const semanticResults = semanticResult.status === 'fulfilled' ? semanticResult.value : [];
    if (semanticResult.status === 'rejected') {
      this.logger.error('Semantic search failed:', semanticResult.reason);
    }

    const grepMatches = grepResult.status === 'fulfilled' ? grepResult.value : [];
    if (grepResult.status === 'fulfilled') captureObservedGrep(this.options.observer, grepResult.value, 'hybrid');
    if (grepResult.status === 'rejected') {
      this.logger.error('Grep search failed:', grepResult.reason);
    }

    if (semanticResult.status === 'rejected' && grepResult.status === 'rejected') {
      throw new Error('Both semantic and grep searches failed');
    }

    const grepResults = grepMatches.map((match) => {
      const matchingSemantic = semanticResults.find(
        (s) =>
          s.chunk.filePath === match.filePath &&
          match.lineNumber >= s.chunk.startLine &&
          match.lineNumber <= s.chunk.endLine,
      );

      return {
        chunk: matchingSemantic
          ? matchingSemantic.chunk
          : {
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
      };
    });

    return {
      query: params.query,
      results: fuseResults(semanticResults, grepResults, { k: this.rrfK, topK }),
      tookMs: Date.now() - startedAt,
    };
  }
}

const extensionToLang: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.sh': 'shell',
  '.md': 'markdown',
};

const inferLanguage = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return extensionToLang[ext] || 'unknown';
};
