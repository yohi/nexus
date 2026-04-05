import type { GrepMatch, IGrepEngine } from '../../types/index.js';

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
): Promise<{ matches: GrepMatch[] }> => ({
  matches: await grepEngine.search({
    query: args.pattern,
    cwd: projectRoot,
    glob: args.filePattern ? [args.filePattern] : undefined,
    caseSensitive: args.caseSensitive,
    maxResults: args.maxResults,
  }),
});
