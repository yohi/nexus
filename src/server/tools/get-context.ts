import type { PathSanitizer } from '../path-sanitizer.js';

export interface GetContextToolArgs {
  filePath: string;
  /**
   * @deprecated reserved for future use
   */
  symbolName?: string;
  startLine?: number;
  endLine?: number;
}

export interface GetContextResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
}

export const executeGetContext = async (
  loadFileContent: (filePath: string) => Promise<string>,
  sanitizer: PathSanitizer,
  args: GetContextToolArgs,
): Promise<GetContextResult> => {
  const sanitizedPath = await sanitizer.sanitize(args.filePath);
  const content = await loadFileContent(sanitizedPath);
  const lines = content.split('\n');

  const resolvedStart = Math.max(1, Math.min(args.startLine ?? 1, lines.length));
  const resolvedEnd = Math.max(1, Math.min(args.endLine ?? lines.length, lines.length));

  if (resolvedStart > resolvedEnd) {
    throw new Error(`Invalid line range: startLine (${resolvedStart}) is greater than endLine (${resolvedEnd})`);
  }

  const slice = lines.slice(resolvedStart - 1, resolvedEnd);

  return {
    filePath: args.filePath,
    content: slice.join('\n'),
    startLine: resolvedStart,
    endLine: resolvedEnd,
  };
};
