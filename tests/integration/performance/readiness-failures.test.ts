import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReadiness } from '../../benchmarks/performance/readiness.js';
import { systemClock } from '../../benchmarks/performance/clock.js';
import * as settlement from '../../benchmarks/performance/readiness-settlement.js';
import { observeReindex, observeRuntimeWork } from '../../../src/observability/runtime-work.js';
import { createLifecycleFixture } from './lifecycle-fixture.js';
import { createTraceRecorder } from '../../benchmarks/performance/diagnostics/trace-recorder.js';
import { createRuntimeDiagnosticContext } from '../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../src/observability/diagnostic-stage-trace.js';

const fixtures: Awaited<ReturnType<typeof createLifecycleFixture>>[] = [];
async function fixture() {
  const value = await createLifecycleFixture(); fixtures.push(value); return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.dispose();
});

describe('readiness failure admission', () => {
  it('records an S11 span around the actual-handler readiness probe', async () => {
    const current = await fixture();
    const workerContext = {
      recorder: createTraceRecorder({
        runId: '00000000-0000-4000-8000-000000000001',
        jobId: 'cold_initial_index',
        recipeDigest: 'a'.repeat(64),
        sourceFingerprint: 'b'.repeat(64),
        pid: 3002,
        processStartTicks: '4567',
        ppid: 2000,
        processRole: 'vitest_worker',
        clockDomain: 'process_local_monotonic',
      }, { nowNs: () => process.hrtime.bigint() }),
      operationId: 'op_0000000000000001',
      attemptId: 'attempt_1',
    };
    const result = await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(workerContext), () =>
      captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal));

    expect(result.status).toBe('valid');
    const stages = workerContext.recorder.snapshot().events
      .filter((event) => event.event === 'span_started')
      .map((event) => event.stageId);
    expect(stages).toContain('S11_readiness_probe');
  });

  it.each(['rejected', 'incomplete', 'unowned', 'stale'] as const)(
    'does not admit %s indexing evidence as a fast startup', async (failure) => {
      const current = await fixture();
      const factory = async (signal: AbortSignal) => {
        const assembly = await current.factory(signal);
        switch (failure) {
          case 'rejected': vi.spyOn(assembly.options, 'runReindex').mockRejectedValueOnce(new Error('hidden_scan_failure')); break;
          case 'incomplete': vi.spyOn(assembly.diagnostics.metadataStore, 'atomicCompletionCheck')
            .mockResolvedValueOnce({ dlqEmpty: false, dlqEntries: [] }); break;
          case 'unowned': vi.spyOn(assembly.options.pipeline, 'reindex').mockImplementationOnce(() =>
            observeReindex(current.collector, {}, () => Promise.resolve({ status: 'already_running' }))); break;
          case 'stale': {
            const original = assembly.diagnostics.metadataStore.getIndexStats.bind(assembly.diagnostics.metadataStore);
            vi.spyOn(assembly.diagnostics.metadataStore, 'getIndexStats').mockImplementation(async () => {
              const stats = await original();
              return stats?.lastIndexedAt ? { ...stats, lastIndexedAt: '2000-01-01T00:00:00.000Z' } : stats;
            });
            break;
          }
        }
        return assembly;
      };
      const captured = await captureReadiness(factory, current.collector, current.manifest, systemClock, new AbortController().signal);
      expect(captured).toMatchObject({ status: 'invalid', record: { phase: 'indexing' } });
      expect(captured.record).not.toHaveProperty('rawSamples');
    },
  );

  it('rejects dropped fixture events without waiting for a nominal empty queue', async () => {
    const current = await fixture();
    const factory = async (signal: AbortSignal) => {
      const assembly = await current.factory(signal);
      return { ...assembly, diagnostics: { ...assembly.diagnostics,
        queueSnapshot: () => ({ ...assembly.diagnostics.queueSnapshot(), dropped: 1 }) } };
    };
    expect(await captureReadiness(factory, current.collector, current.manifest, systemClock, new AbortController().signal))
      .toMatchObject({ status: 'invalid', record: { phase: 'indexing' } });
  });

  it('does not admit an undrained queue when the scenario is cancelled', async () => {
    const current = await fixture();
    const controller = new AbortController();
    let scheduled = false;
    const factory = async (signal: AbortSignal) => {
      const assembly = await current.factory(signal);
      return { ...assembly, diagnostics: { ...assembly.diagnostics, queueSnapshot: () => {
        if (!scheduled) { scheduled = true; queueMicrotask(() => controller.abort()); }
        return { ...assembly.diagnostics.queueSnapshot(), size: 1 };
      } } };
    };
    expect((await captureReadiness(factory, current.collector, current.manifest, systemClock, controller.signal)).status).toBe('invalid');
  });

  it('rejects a failed auxiliary compaction from another request before the readiness candidate', async () => {
    const current = await fixture();
    const settle = settlement.settleReadiness;
    vi.spyOn(settlement, 'settleReadiness').mockImplementationOnce(async (assembly, collector, ...args) => {
      await settle(assembly, collector, ...args);
      await collector.run('auxiliary', () => observeRuntimeWork(collector, 'compaction',
        () => Promise.reject(new Error('auxiliary_compaction_failed')))).catch(() => {});
    });
    expect((await captureReadiness(current.factory, current.collector, current.manifest, systemClock, new AbortController().signal)).status)
      .toBe('invalid');
  });
});
