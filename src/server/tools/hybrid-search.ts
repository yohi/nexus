import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';
import { PathSanitizer } from '../path-sanitizer.js';

export interface HybridSearchToolArgs extends HybridSearchParams {}

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  args: HybridSearchToolArgs,
): Promise<SearchResponse> => {
  const sanitizedArgs = {
    ...args,
    filePattern: args.filePattern ? PathSanitizer.validateGlob(args.filePattern) : undefined,
  };

  return orchestrator.search(sanitizedArgs);
};
