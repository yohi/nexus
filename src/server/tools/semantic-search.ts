import type { SearchResult } from '../../types/index.js';
import type { SemanticSearch, SemanticSearchParams } from '../../search/semantic.js';

export interface SemanticSearchToolArgs extends SemanticSearchParams {}

export const executeSemanticSearch = async (
  semanticSearch: SemanticSearch,
  args: SemanticSearchToolArgs,
): Promise<{ results: SearchResult[] }> => ({
  results: await semanticSearch.search(args),
});
