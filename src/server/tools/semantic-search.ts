import type { SearchResult } from '../../types/index.js';
import type { ISemanticSearch, SemanticSearchParams } from '../../search/semantic.js';
import { PathSanitizer } from '../path-sanitizer.js';

export interface SemanticSearchToolArgs extends SemanticSearchParams {}

export const executeSemanticSearch = async (
  semanticSearch: ISemanticSearch,
  args: SemanticSearchToolArgs,
): Promise<{ results: SearchResult[] }> => {
  const sanitizedArgs = {
    ...args,
    filePattern: args.filePattern ? PathSanitizer.validateGlob(args.filePattern) : undefined,
  };

  return {
    results: await semanticSearch.search(sanitizedArgs),
  };
};
