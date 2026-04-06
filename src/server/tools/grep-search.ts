import type { GrepMatch, IGrepEngine } from '../../types/index.js';
import { PathSanitizer } from '../path-sanitizer.js';

export interface GrepSearchToolArgs {
  pattern: string;
  filePattern?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export const executeGrepSearch = async (
  grepEngine: IGrepEngine,
  projectRoot: string,
  args: GrepSearchToolArgs,
): Promise<{ matches: GrepMatch[] }> => {
  const glob = args.filePattern ? [PathSanitizer.validateGlob(args.filePattern)] : undefined;

  return {
    matches: await grepEngine.search({
      query: args.pattern,
      cwd: projectRoot,
      glob,
      caseSensitive: args.caseSensitive,
      maxResults: args.maxResults,
    }),
  };
};
