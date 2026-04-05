import type { IndexEvent, ReindexResult } from '../../types/index.js';
import type { IndexPipeline } from '../../indexer/pipeline.js';

export interface ReindexToolArgs {
  fullRebuild?: boolean;
}

export type ReindexToolResult = ReindexResult | { status: 'already_running' };

export const executeReindex = async (
  pipeline: IndexPipeline,
  runReindex: () => Promise<IndexEvent[]>,
  loadFileContent: (filePath: string) => Promise<string>,
  _args: ReindexToolArgs,
): Promise<ReindexToolResult> => pipeline.reindex(runReindex, loadFileContent);
