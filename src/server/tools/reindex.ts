import type { IndexEvent, ReindexOperationResult, ReindexOptions, IIndexPipeline } from '../../types/index.js';

export interface ReindexToolArgs {
  fullRebuild?: boolean;
  reason?: ReindexOptions['reason'];
}

export type ReindexToolResult = ReindexOperationResult;

export const executeReindex = async (
  pipeline: IIndexPipeline,
  runReindex: (options?: ReindexOptions) => Promise<IndexEvent[]>,
  loadFileContent: (filePath: string) => Promise<string>,
  args: ReindexToolArgs,
): Promise<ReindexToolResult> => {
  const result = await pipeline.reindex(runReindex, loadFileContent, args.fullRebuild, args.reason);
  if (!('status' in result) || result.status !== 'rebuild_required') return result;
  return await pipeline.reindex(runReindex, loadFileContent, true, 'integrity-recovery', result.request);
};
