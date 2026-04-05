import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';

export interface HybridSearchToolArgs extends HybridSearchParams {}

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  args: HybridSearchToolArgs,
): Promise<SearchResponse> => orchestrator.search(args);
