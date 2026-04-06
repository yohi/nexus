import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';
import type { PathSanitizer } from '../path-sanitizer.js';

export interface HybridSearchToolArgs extends HybridSearchParams {}

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  sanitizer: PathSanitizer,
  args: HybridSearchToolArgs,
  abortSignal?: AbortSignal,
): Promise<SearchResponse> => {
  const validatedArgs = { ...args };
  if (args.filePattern) {
    validatedArgs.filePattern = sanitizer.validateGlob(args.filePattern);
  }

  return orchestrator.search({ ...validatedArgs, abortSignal });
};
