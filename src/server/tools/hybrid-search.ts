import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';
import type { PathSanitizer } from '../path-sanitizer.js';

export interface HybridSearchToolArgs extends HybridSearchParams {}

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  sanitizer: PathSanitizer,
  args: HybridSearchToolArgs & { filePattern?: string },
  abortSignal?: AbortSignal,
): Promise<SearchResponse> => {
  const { filePattern, ...rest } = args;
  const validatedArgs: HybridSearchParams = { ...rest };

  if (filePattern) {
    validatedArgs.filePatterns = [sanitizer.validateGlob(filePattern)];
  } else if (args.filePatterns) {
    validatedArgs.filePatterns = args.filePatterns.map((p) => sanitizer.validateGlob(p));
  }

  return orchestrator.search({ ...validatedArgs, abortSignal });
};
