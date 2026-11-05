import { describe, expect, it } from 'vitest';

import { WorkerResourceSampler } from '../../../../benchmarks/performance/diagnostics/resource-sampler.js';
import { createTraceRecorder } from '../../../../benchmarks/performance/diagnostics/trace-recorder.js';

describe('worker resource sampler', () => {
  it('records worker measurements and explicit unavailable supervisor values', () => {
    const recorder = createTraceRecorder({
      runId: '00000000-0000-4000-8000-000000000001',
      jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      pid: 3002,
      processStartTicks: '4567',
      ppid: 2000,
      processRole: 'vitest_worker',
      clockDomain: 'process_local_monotonic',
    }, { nowNs: () => process.hrtime.bigint() });
    const sampler = new WorkerResourceSampler(recorder);

    sampler.sampleBoundary();

    const sample = recorder.snapshot().events.find((event) => event.event === 'resource_sample');
    expect(sample).toBeDefined();
    if (sample?.event !== 'resource_sample') throw new Error('resource sample event missing');
    expect(sample.sampleScope).toBe('worker_process');
    expect(sample.heapUsedBytes.status).toBe('observed');
    expect(sample.rssBytes.status).toBe('observed');
    expect(sample.ioReadBytes).toEqual({ status: 'not_collected', reasonCode: 'unsupported' });
    expect(sample.cgroupMemoryCurrentBytes).toEqual({ status: 'not_collected', reasonCode: 'not_requested' });
  });

  it('enforces five-second sampling cadence and includes final cleanup', () => {
    let nowNs = 100n;
    const recorder = createTraceRecorder({
      runId: '00000000-0000-4000-8000-000000000001',
      jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      pid: 3002,
      processStartTicks: '4567',
      ppid: 2000,
      processRole: 'vitest_worker',
      clockDomain: 'process_local_monotonic',
    }, { nowNs: () => nowNs });
    const sampler = new WorkerResourceSampler(recorder, 5_000, () => nowNs);

    sampler.start();
    nowNs += 1_000_000_000n;
    sampler.sampleBoundary();
    expect(recorder.snapshot().events.filter((event) => event.event === 'resource_sample')).toHaveLength(1);
    nowNs += 4_000_000_000n;
    sampler.sampleBoundary();
    nowNs += 1_000_000_000n;
    sampler.stop();

    expect(recorder.snapshot().events.filter((event) => event.event === 'resource_sample')).toHaveLength(3);
  });

  it('marks an unavailable sampling clock without throwing into the measured work', () => {
    const recorder = createTraceRecorder({
      runId: '00000000-0000-4000-8000-000000000001',
      jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      pid: 3002,
      processStartTicks: '4567',
      ppid: 2000,
      processRole: 'vitest_worker',
      clockDomain: 'process_local_monotonic',
    }, { nowNs: () => process.hrtime.bigint() });
    const sampler = new WorkerResourceSampler(recorder, 5_000, () => { throw new Error('clock unavailable'); });

    expect(() => sampler.sampleBoundary()).not.toThrow();
    expect(recorder.snapshot().incompleteReasons).toContain('observer_failure');
  });
});
