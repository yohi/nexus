import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import type { FixtureManifest } from './contracts.js';
import { applyIncrement } from './fixtures.js';
import { physicalFixturePath } from './audit-manifest.js';
import { observeRuntimeWork } from '../../../src/observability/runtime-work.js';
import type { OutcomeCollector } from './outcomes.js';
import { LifecycleError } from './lifecycle-context.js';

export async function prepareIncrementalOperation(assembly: RuntimeAssembly, manifest: FixtureManifest,
  collector: OutcomeCollector) {
  const queue = assembly.options.eventQueue;
  const pipeline = assembly.options.pipeline;
  if (queue === undefined || !(pipeline instanceof IndexPipeline)) throw new LifecycleError('unsupported_pipeline');
  await assembly.options.watcher.stop();
  try {
    const before = assembly.diagnostics.queueSnapshot();
    if (before.size !== 0 || before.postScanSize !== 0 || before.dropped !== 0 || before.postScanActive ||
      assembly.diagnostics.pendingDrainCount() !== 0) throw new LifecycleError('unexpected_queued_work');
    const changed = await applyIncrement(assembly.options.projectRoot, manifest);
    const detectedAt = new Date().toISOString();
    return {
      manifest: changed.manifest,
      invoke: () => observeRuntimeWork(collector, 'drain', async () => {
        for (const event of changed.events) {
          if (!queue.enqueue({ ...event, filePath: physicalFixturePath(event.filePath), detectedAt })) throw new LifecycleError('unexpected_queued_work');
        }
        await queue.drain(async (event) => {
          if (event.type === 'reindex') throw new LifecycleError('unexpected_queued_work');
          await pipeline.processEvents([event], assembly.options.loadFileContent, { trackProgress: false });
        });
      }),
      restore: () => assembly.options.watcher.start(),
    };
  } catch (error) {
    await assembly.options.watcher.start();
    throw error;
  }
}
