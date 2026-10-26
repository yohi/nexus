import { describe, expect, it } from 'vitest';
import { getObservationContext } from '../../../../src/observability/runtime-observer.js';
import { observeRuntimeWork } from '../../../../src/observability/runtime-work.js';
import { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';

describe('provider accounting admission', () => {
  it('rejects missing provider batch completion even when indexing work fulfilled', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      await observeRuntimeWork(collector, 'process_events', () => {
        const context = getObservationContext();
        if (context?.workId === undefined) throw new Error('work context required');
        const identity = { context, workId: context.workId, time: 1 };
        const input = { origin: 'legacy' as const, keyDigest: 'a'.repeat(64) };
        collector.onEvent({ ...identity, kind: 'cache_lookup', outcome: 'miss', input });
        collector.onEvent({ ...identity, kind: 'embedding_batch_submitted', batchId: 'batch', entries: [input] });
        return Promise.resolve();
      });
      expect((await collector.seal('request')).failures).toContain('missing_embedding_outcome');
    });
  });

  it('rejects lookup and provider occurrence disagreement', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      await observeRuntimeWork(collector, 'process_events', () => {
        const context = getObservationContext();
        if (context?.workId === undefined) throw new Error('work context required');
        const identity = { context, workId: context.workId, time: 1 };
        collector.onEvent({ ...identity, kind: 'embedding_batch_submitted', batchId: 'batch',
          entries: [{ origin: 'structured', keyDigest: 'b'.repeat(64) }] });
        collector.onEvent({ ...identity, kind: 'embedding_batch_finished', batchId: 'batch', outcome: 'fulfilled' });
        return Promise.resolve();
      });
      expect((await collector.seal('request')).failures).toContain('cache_accounting_mismatch');
    });
  });

  it('waits for an in-flight provider batch before deciding whether its terminal evidence is missing', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      let finish = () => {};
      const work = observeRuntimeWork(collector, 'process_events', () => new Promise<void>((resolve) => {
        const context = getObservationContext();
        if (context?.workId === undefined) throw new Error('work context required');
        const identity = { context, workId: context.workId, time: 1 };
        const input = { origin: 'legacy' as const, keyDigest: 'a'.repeat(64) };
        collector.onEvent({ ...identity, kind: 'cache_lookup', outcome: 'miss', input });
        collector.onEvent({ ...identity, kind: 'embedding_batch_submitted', batchId: 'batch', entries: [input] });
        finish = () => {
          collector.onEvent({ ...identity, kind: 'embedding_batch_finished', batchId: 'batch', outcome: 'fulfilled' });
          resolve();
        };
      }));
      const sealed = collector.seal('request');
      queueMicrotask(finish);
      await work;
      expect((await sealed).status).toBe('valid');
    });
  });
});
