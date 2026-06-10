import type { GrepMatch, IGrepEngine } from '../../types/index.js';
import type { PathSanitizer } from '../path-sanitizer.js';

export interface GrepSearchToolArgs {
  pattern: string;
  filePattern?: string;
  filePatterns?: string[];
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
  let glob: string[] | undefined;
  if (args.filePattern) {
    glob = [sanitizer.validateGlob(args.filePattern)];
  } else if (args.filePatterns) {
    glob = args.filePatterns.map((p) => sanitizer.validateGlob(p));
  }

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
