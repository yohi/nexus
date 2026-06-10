import type {
  EmbeddingProvider,
  IVectorStore,
  SearchResult,
  VectorFilter,
} from '../types/index.js';

export interface SemanticSearchParams {
  query: string;
  topK?: number;
  filePatterns?: string[];
  language?: string;
  abortSignal?: AbortSignal;
}

export interface SemanticSearchOptions {
  vectorStore: IVectorStore;
  embeddingProvider: EmbeddingProvider;
}

export interface ISemanticSearch {
  search(params: SemanticSearchParams): Promise<SearchResult[]>;
}

export class SemanticSearch implements ISemanticSearch {
  constructor(private readonly options: SemanticSearchOptions) {}

  async search(params: SemanticSearchParams): Promise<SearchResult[]> {
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

    return results
      .filter((result) => matchesFilePatterns(result.chunk.filePath, params.filePatterns))
      .slice(0, topK)
      .map((result) => ({
        chunk: result.chunk,
        score: result.score,
        source: 'semantic' as const,
      }));
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

  return filePatterns.some((pattern) => {
    if (pattern.trim() === '') return true;
    return globToRegExp(pattern).test(filePath);
  });
};
