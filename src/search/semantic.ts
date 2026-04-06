import type {
  EmbeddingProvider,
  IVectorStore,
  SearchResult,
  VectorFilter,
} from '../types/index.js';

export interface SemanticSearchParams {
  query: string;
  topK?: number;
  filePattern?: string;
  language?: string;
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
    const [queryVector] = await this.options.embeddingProvider.embed([params.query]);

    if (queryVector === undefined) {
      return [];
    }

    const filter: VectorFilter = {};
    if (params.language !== undefined) {
      filter.language = params.language;
    }

    const candidateLimit = params.filePattern ? topK * 5 : topK;
    const results = await this.options.vectorStore.search(queryVector, candidateLimit, filter);

    return results
      .filter((result) => matchesFilePattern(result.chunk.filePath, params.filePattern))
      .slice(0, topK)
      .map((result) => ({
        chunk: result.chunk,
        score: result.score,
        source: 'semantic' as const,
      }));
  }
}

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');

const globToRegExp = (pattern: string): RegExp => {
  const normalized = pattern.replace(/\*\*/g, '__DOUBLE_STAR__');
  const escaped = escapeRegex(normalized)
    .replace(/__DOUBLE_STAR__/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${escaped}$`);
};

const matchesFilePattern = (filePath: string, filePattern?: string): boolean => {
  if (filePattern === undefined || filePattern.trim() === '') {
    return true;
  }

  return globToRegExp(filePattern).test(filePath);
};
