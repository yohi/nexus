import type { SearchResult } from '../../types/index.js';
import type { SemanticSearch, SemanticSearchParams } from '../../search/semantic.js';

export interface SemanticSearchToolArgs extends SemanticSearchParams {}

export const executeSemanticSearch = async (
  semanticSearch: SemanticSearch,
  args: SemanticSearchToolArgs,
): Promise<{ results: SearchResult[] }> => {
  // TODO(Phase 3): Apply PathSanitizer at the tool boundary before accepting semantic search path filters.
  return {
    results: await semanticSearch.search(args),
  };
};
