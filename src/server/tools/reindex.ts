import type { IndexEvent, ReindexResult, ReindexOptions } from '../../types/index.js';
import type { IIndexPipeline } from '../../indexer/pipeline.js';

export interface ReindexToolArgs {
  fullRebuild?: boolean;
}

export type ReindexToolResult = ReindexResult | { status: 'already_running' };

export const executeReindex = async (
  pipeline: IIndexPipeline,
  runReindex: (options?: ReindexOptions) => Promise<IndexEvent[]>,
  loadFileContent: (filePath: string) => Promise<string>,
  args: ReindexToolArgs,
): Promise<ReindexToolResult> => pipeline.reindex(runReindex, loadFileContent, args.fullRebuild);
