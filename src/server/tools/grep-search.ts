import type { GrepMatch, IGrepEngine } from '../../types/index.js';
import type { PathSanitizer } from '../path-sanitizer.js';

export interface GrepSearchToolArgs {
  pattern: string;
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export const executeGrepSearch = async (
  grepEngine: IGrepEngine,
  projectRoot: string,
  sanitizer: PathSanitizer,
  args: GrepSearchToolArgs,
  abortSignal?: AbortSignal,
): Promise<{ matches: GrepMatch[] }> => {
  const glob = args.filePattern ? [sanitizer.validateGlob(args.filePattern)] : undefined;

  return {
    matches: await grepEngine.search({
      query: args.pattern,
      cwd: projectRoot,
      glob,
      caseSensitive: args.caseSensitive,
      maxResults: args.maxResults,
      abortSignal,
    }),
  };
};
