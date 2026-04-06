import type { SearchResult } from '../../types/index.js';
import type { ISemanticSearch, SemanticSearchParams } from '../../search/semantic.js';
import type { PathSanitizer } from '../path-sanitizer.js';

export interface SemanticSearchToolArgs extends SemanticSearchParams {}

export const executeSemanticSearch = async (
  semanticSearch: ISemanticSearch,
  sanitizer: PathSanitizer,
  args: SemanticSearchToolArgs,
  abortSignal?: AbortSignal,
): Promise<{ results: SearchResult[] }> => {
  const validatedArgs = { ...args };
  if (args.filePattern) {
    validatedArgs.filePattern = sanitizer.validateGlob(args.filePattern);
  }

  return {
    results: await semanticSearch.search({ ...validatedArgs, abortSignal }),
  };
};
