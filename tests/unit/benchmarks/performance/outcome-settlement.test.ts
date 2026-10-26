import { describe, expect, it } from 'vitest';
import { emitRuntimeEvent } from '../../../../src/observability/runtime-observer.js';
import { observeReindex, observeRuntimeWork, startRuntimeWork } from '../../../../src/observability/runtime-work.js';
import { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';

describe('observation settlement ownership', () => {
  it('does not admit an already-running owner whose auxiliary compaction failed', async () => {
    const collector = new OutcomeCollector();
    const owner = {};
    let finish = () => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = collector.run('owner', () => observeReindex(collector, owner, async () => {
      await pending;
      emitRuntimeEvent(collector, { kind: 'compaction_failed' });
      return { startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:00.001Z',
        durationMs: 1, reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 }, chunksIndexed: 1 };
    }));
    await collector.run('borrower', async () => {
      await observeReindex(collector, owner, () => Promise.resolve({ status: 'already_running' }));
      finish();
      await first;
      expect((await collector.seal('borrower')).status).toBe('invalid');
    });
  });

  it('waits for child work that began after sealing started', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      let closeChild = () => {};
      const parent = observeRuntimeWork(collector, 'semantic', () => new Promise<void>((resolve) => {
        queueMicrotask(() => {
          const child = startRuntimeWork(collector, 'grep_spawn');
          closeChild = () => {
            child.emit({ kind: 'grep_child_finished', outcome: { status: 'exited', exitCode: 0 } });
            child.finish('success');
          };
          resolve();
        });
      }));
      let settled = false;
      const sealing = collector.seal('request').then((result) => { settled = true; return result; });
      await parent;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(settled).toBe(false);
      closeChild();
      expect((await sealing).status).toBe('valid');
    });
  });
});
