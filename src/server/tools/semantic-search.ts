import type { SearchResult } from '../../types/index.js';
import type { ISemanticSearch, SemanticSearchParams } from '../../search/semantic.js';
import type { PathSanitizer } from '../path-sanitizer.js';

export interface SemanticSearchToolArgs extends SemanticSearchParams {}

export const executeSemanticSearch = async (
  semanticSearch: ISemanticSearch,
  sanitizer: PathSanitizer,
  args: SemanticSearchToolArgs & { filePattern?: string },
  abortSignal?: AbortSignal,
): Promise<{ results: SearchResult[] }> => {
  const { filePattern, ...rest } = args;
  const validatedArgs: SemanticSearchParams = { ...rest };

  if (filePattern) {
    validatedArgs.filePatterns = [sanitizer.validateGlob(filePattern)];
  } else if (args.filePatterns) {
    validatedArgs.filePatterns = args.filePatterns.map((p) => sanitizer.validateGlob(p));
  }

  return {
    results: await semanticSearch.search({ ...validatedArgs, abortSignal }),
  };
};
