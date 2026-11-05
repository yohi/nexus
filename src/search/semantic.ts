import type {
  EmbeddingProvider,
  IVectorStore,
  SearchResult,
  VectorFilter,
  VectorSearchResult,
} from '../types/index.js';
import type { RuntimeObserver } from '../observability/runtime-observer.js';
import { observeRuntimeWork } from '../observability/runtime-work.js';
export interface SemanticSearchParams {
  query: string;
  topK?: number;
  filePatterns?: string[];
  language?: string;
  abortSignal?: AbortSignal;
}

export interface ActiveGenerationResolver {
  resolveActiveGenerations(
    filePaths: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export interface SemanticSearchOptions {
  observer?: RuntimeObserver;
  vectorStore: IVectorStore;
  embeddingProvider: EmbeddingProvider;
  activeGenerationResolver?: ActiveGenerationResolver;
}

export interface ISemanticSearch {
  search(params: SemanticSearchParams): Promise<SearchResult[]>;
}

export class SemanticSearch implements ISemanticSearch {
  constructor(private readonly options: SemanticSearchOptions) {}

  async search(params: SemanticSearchParams): Promise<SearchResult[]> {
    return observeRuntimeWork(this.options.observer, 'semantic', () => this.searchUnobserved(params), params.abortSignal);
  }

  private async searchUnobserved(params: SemanticSearchParams): Promise<SearchResult[]> {
    const topK = params.topK ?? 20;

    if (params.abortSignal?.aborted) {
      return [];
    }

    const [queryVector] = await this.options.embeddingProvider.embed([params.query]);

    if (params.abortSignal?.aborted) {
      return [];
    }

    if (queryVector === undefined) {
      return [];
    }

    const filter: VectorFilter = {};
    if (params.language !== undefined) {
      filter.language = params.language;
    }

    const hasFilePatterns = params.filePatterns && params.filePatterns.length > 0;
    const candidateLimit = hasFilePatterns ? topK * 5 : topK;
    const results = await this.options.vectorStore.search(queryVector, candidateLimit, filter);

    if (params.abortSignal?.aborted) {
      return [];
    }

    const filteredByGeneration = await this.filterByActiveGeneration(results);

    return filteredByGeneration
      .filter((result) => matchesFilePatterns(result.chunk.filePath, params.filePatterns))
      .slice(0, topK)
      .map((result) => ({
        chunk: result.chunk,
        score: result.score,
        source: 'semantic' as const,
      }));
  }

  private async filterByActiveGeneration(
    results: VectorSearchResult[],
  ): Promise<VectorSearchResult[]> {
    const resolver = this.options.activeGenerationResolver;
    if (!resolver) {
      return results;
    }

    const structuredResults = results.filter((r) => r.generationId !== undefined);
    if (structuredResults.length === 0) {
      return results;
    }

    const uniqueFilePaths = [...new Set(structuredResults.map((r) => r.chunk.filePath))];
    const activeGenerations = await resolver.resolveActiveGenerations(uniqueFilePaths);

    return results.filter((result) => {
      if (result.generationId === undefined) {
        // Legacy rows are not subject to structured generation filtering.
        return true;
      }
      const activeGeneration = activeGenerations.get(result.chunk.filePath);
      return activeGeneration !== undefined && activeGeneration === result.generationId;
    });
  }
}

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+.-]/g, '\\$&');

const globToRegExp = (pattern: string): RegExp => {
  const normalized = pattern.replace(/\*\*/g, '__DOUBLE_STAR__');
  const escaped = escapeRegex(normalized)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__DOUBLE_STAR__/g, '.*');

  return new RegExp(`^${escaped}$`);
};

const matchesFilePatterns = (filePath: string, filePatterns?: string[]): boolean => {
  if (filePatterns === undefined || filePatterns.length === 0) {
    return true;
  }

  return filePatterns
    .filter((p) => p.trim() !== "")
    .some((pattern) => globToRegExp(pattern).test(filePath));
};
