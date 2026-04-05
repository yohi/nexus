import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';

export interface HybridSearchToolArgs extends HybridSearchParams {}

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  args: HybridSearchToolArgs,
): Promise<SearchResponse> => {
  // TODO(Phase 3): Apply PathSanitizer at the tool boundary before accepting hybrid search path filters.
  return orchestrator.search(args);
};
