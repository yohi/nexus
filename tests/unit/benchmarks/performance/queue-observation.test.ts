import { describe, expect, it } from 'vitest';
import { EventQueue } from '../../../../src/indexer/event-queue.js';
import { runtimeStateRevision, withQueuedObservation } from '../../../../src/observability/runtime-observer.js';
import { observeRuntimeWork } from '../../../../src/observability/runtime-work.js';
import { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';

describe('observed queue settlement', () => {
  it('changes revision for real queue mutations but not repeated empty drain polls', async () => {
    const collector = new OutcomeCollector();
    const queue = new EventQueue({ debounceMs: 100, maxQueueSize: 10, fullScanThreshold: 9,
      concurrency: 1, observer: collector });
    try {
      await collector.run('queue', async () => {
        queue.enterPostScanMode();
        const entered = runtimeStateRevision(collector);
        queue.drainPostScanQueue();
        expect(runtimeStateRevision(collector)).toBeGreaterThan(entered);
        await queue.drain(() => Promise.resolve());
        const settled = runtimeStateRevision(collector);
        await queue.drain(() => Promise.resolve());
        expect(runtimeStateRevision(collector)).toBe(settled);
      });
    } finally { queue.clear(); }
  });

  it('retains the submission context through event merging and later draining', async () => {
    const collector = new OutcomeCollector();
    const queue = new EventQueue({ debounceMs: 100, maxQueueSize: 10, fullScanThreshold: 9,
      concurrency: 1, observer: collector });
    try {
      await collector.run('submission', () => {
        queue.enqueue({ type: 'added', filePath: 'src/a.ts', detectedAt: '2026-10-24T00:00:00.000Z' });
        queue.enqueue({ type: 'modified', filePath: 'src/a.ts', detectedAt: '2026-10-24T00:00:00.001Z' });
        return Promise.resolve();
      });
      await collector.run('drain-loop', () => queue.drain((event) => withQueuedObservation(event,
        () => observeRuntimeWork(collector, 'process_events', () => Promise.resolve()))));
      expect((await collector.seal('submission')).status).toBe('valid');
    } finally { queue.clear(); }
  });

  it('observes dropped events even when no metrics hook is configured', async () => {
    const collector = new OutcomeCollector();
    const queue = new EventQueue({ debounceMs: 100, maxQueueSize: 1, fullScanThreshold: 1,
      concurrency: 1, observer: collector });
    try {
      await collector.run('overflow', async () => {
        queue.enqueue({ type: 'added', filePath: 'src/a.ts', detectedAt: '2026-10-24T00:00:00.000Z' });
        queue.enqueue({ type: 'added', filePath: 'src/b.ts', detectedAt: '2026-10-24T00:00:00.000Z' });
        expect((await collector.seal('overflow')).failures).toContain('dropped_events');
      });
    } finally { queue.clear(); }
  });
});
