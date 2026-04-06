import type { SearchResult } from '../../types/index.js';
import type { ISemanticSearch, SemanticSearchParams } from '../../search/semantic.js';

export interface SemanticSearchToolArgs extends SemanticSearchParams {}

export const executeSemanticSearch = async (
  semanticSearch: ISemanticSearch,
  args: SemanticSearchToolArgs,
): Promise<{ results: SearchResult[] }> => ({
  results: await semanticSearch.search(args),
});
