import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import type { OutcomeCollector } from './outcomes.js';
import { ReadinessError } from './readiness-error.js';

export async function settleReadiness(assembly: RuntimeAssembly, collector: OutcomeCollector,
  requestId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await assembly.options.pipeline.waitForActiveReindex();
  if ((await collector.seal(requestId)).status !== 'valid') throw new ReadinessError('indexing_failed');
  await collector.waitUntil(() => {
    if (collector.hasRuntimeFailure) throw new ReadinessError('indexing_failed');
    const progress = assembly.options.pipeline.getProgress();
    const queue = assembly.diagnostics.queueSnapshot();
    if (progress.lastError !== undefined) throw new ReadinessError('runtime_index_error');
    if (queue.dropped !== 0 || queue.state !== 'normal') throw new ReadinessError('dropped_events');
    return progress.status === 'idle' && queue.size === 0 && queue.postScanSize === 0 &&
      !queue.postScanActive && assembly.diagnostics.pendingDrainCount() === 0 && collector.pendingRuntimeMutations === 0;
  }, signal);
  if ((await collector.seal(requestId)).status !== 'valid') throw new ReadinessError('indexing_failed');
  if (assembly.options.pipeline instanceof IndexPipeline && assembly.options.pipeline.getSkippedFiles().size !== 0) {
    throw new ReadinessError('runtime_skipped_files');
  }
  const completions = collector.successfulReindexes(requestId);
  if (completions.length > 0) {
    const latest = completions.at(-1);
    const stats = await assembly.diagnostics.metadataStore.getIndexStats();
    if (latest === undefined || stats?.lastIndexedAt !== latest.finishedAt) throw new ReadinessError('stale_index_timestamp');
  }
  signal.throwIfAborted();
}
