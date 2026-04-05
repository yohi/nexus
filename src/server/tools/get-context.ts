export interface GetContextToolArgs {
  filePath: string;
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
  args: GetContextToolArgs,
): Promise<GetContextResult> => {
  const content = await loadFileContent(args.filePath);
  const lines = content.split('\n');
  const startLine = args.startLine ?? 1;
  const endLine = args.endLine ?? lines.length;
  const slice = lines.slice(Math.max(0, startLine - 1), endLine);

  return {
    filePath: args.filePath,
    content: slice.join('\n'),
    startLine,
    endLine,
  };
};
