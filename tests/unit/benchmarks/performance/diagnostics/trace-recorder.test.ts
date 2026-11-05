import { describe, expect, it } from 'vitest';
import {
  diagnosticTraceEventSchema,
  type DiagnosticTraceEvent,
  type DiagnosticTraceIdentity,
  type ProgressInput,
  type StageInput,
} from '../../../../benchmarks/performance/diagnostics/contracts.js';
import { createTraceRecorder, type DiagnosticTraceRecorder } from '../../../../benchmarks/performance/diagnostics/trace-recorder.js';

const identity: DiagnosticTraceIdentity = {
  runId: '00000000-0000-4000-8000-000000000001',
  jobId: 'cold_initial_index',
  recipeDigest: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  pid: 1234,
  processStartTicks: '4567',
  ppid: 1200,
  processRole: 'vitest_worker',
  clockDomain: 'process_local_monotonic',
};

function createFakeClock(values?: readonly bigint[]): () => bigint {
  let currentNs = 1_000_000n;
  let index = 0;
  return () => {
    if (values !== undefined) {
      const value = values[index];
      index += 1;
      return value ?? values[values.length - 1] ?? 0n;
    }
    const sample = currentNs;
    currentNs += 2_000_000n;
    return sample;
  };
}

function createSequenceClock(values: readonly bigint[]): () => bigint {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value ?? values.at(-1) ?? 0n;
  };
}

function spanStartedEvents(events: readonly DiagnosticTraceEvent[]) {
  return events.filter((event): event is Extract<DiagnosticTraceEvent, { readonly event: 'span_started' }> =>
    event.event === 'span_started');
}

function spanFinishedEvents(events: readonly DiagnosticTraceEvent[]) {
  return events.filter((event): event is Extract<DiagnosticTraceEvent, { readonly event: 'span_finished' }> =>
    event.event === 'span_finished');
}

function progressEvents(events: readonly DiagnosticTraceEvent[]) {
  return events.filter((event): event is Extract<DiagnosticTraceEvent, { readonly event: 'progress' }> =>
    event.event === 'progress');
}

function counter(counterId: string, value: number): ProgressInput {
  return { counterId, value, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold' };
}

function recorder(clock = createFakeClock()): DiagnosticTraceRecorder {
  return createTraceRecorder(identity, { nowNs: clock });
}

const eventIdentity = {
  schemaVersion: 1,
  ...identity,
  seq: 1,
  monotonicNs: '1000000',
};

describe('diagnostic trace recorder contract', () => {
  it('validates a span event and rejects malformed process identity or clock values', () => {
    const validSpanEvent = {
      ...eventIdentity,
      event: 'span_started',
      spanId: '1234:4567:1',
      operationId: 'op_0000000000000001',
      attemptId: 'attempt_1',
      stageId: 'S03_runtime_assembly',
    };

    expect(diagnosticTraceEventSchema.safeParse(validSpanEvent).success).toBe(true);
    expect(diagnosticTraceEventSchema.safeParse({ ...validSpanEvent, pid: 0 }).success).toBe(false);
    expect(diagnosticTraceEventSchema.safeParse({ ...validSpanEvent, monotonicNs: '1.5' }).success).toBe(false);
    expect(diagnosticTraceEventSchema.safeParse({ ...validSpanEvent, processStartTicks: '0' }).success).toBe(false);
  });

  it('represents unavailable resource measurements explicitly instead of zero', () => {
    const notCollected = { status: 'not_collected', reasonCode: 'not_yet_sampled' } as const;
    const resourceSample = {
      ...eventIdentity,
      event: 'resource_sample',
      sampleScope: 'worker_process',
      heapUsedBytes: notCollected,
      heapTotalBytes: notCollected,
      rssBytes: notCollected,
      externalBytes: notCollected,
      arrayBuffersBytes: notCollected,
      cpuUserUs: notCollected,
      cpuSystemUs: notCollected,
      ioReadBytes: notCollected,
      ioWriteBytes: notCollected,
      eventLoopDelayMaxNs: notCollected,
      cgroupMemoryCurrentBytes: notCollected,
      cgroupSwapCurrentBytes: notCollected,
      cpuPressureSomeAvg60: notCollected,
      ioPressureSomeAvg60: notCollected,
      memoryPressureSomeAvg60: notCollected,
      oomKillDelta: notCollected,
    };

    expect(diagnosticTraceEventSchema.safeParse(resourceSample).success).toBe(true);
    expect(diagnosticTraceEventSchema.safeParse({ ...resourceSample, rssBytes: 0 }).success).toBe(false);
    expect(diagnosticTraceEventSchema.safeParse({
      ...resourceSample,
      rssBytes: { status: 'observed', value: 0 },
    }).success).toBe(true);
  });

  it('represents each profile lifecycle measurement at the point it becomes available', () => {
    const notYetSampled = { status: 'not_collected', reasonCode: 'not_yet_sampled' } as const;
    const notYetWritten = { status: 'not_collected', reasonCode: 'not_yet_written' } as const;
    const profileStarted = {
      ...eventIdentity,
      event: 'profile_segment_started',
      segmentId: 'segment-1',
      sampleCount: notYetSampled,
      fileBytes: notYetWritten,
    };
    const profileStopped = {
      ...eventIdentity,
      event: 'profile_segment_stopped',
      segmentId: 'segment-1',
      sampleCount: { status: 'observed', value: 0 },
      fileBytes: notYetWritten,
    };
    const profileWritten = {
      ...eventIdentity,
      event: 'profile_write_completed',
      segmentId: 'segment-1',
      sampleCount: { status: 'observed', value: 0 },
      fileBytes: { status: 'observed', value: 0 },
    };
    const profileFailed = {
      ...eventIdentity,
      event: 'profile_write_failed',
      segmentId: 'segment-1',
      sampleCount: { status: 'not_collected', reasonCode: 'profile_missing' },
      fileBytes: { status: 'not_collected', reasonCode: 'profile_missing' },
      errorCategory: 'process_exit',
    };

    expect(diagnosticTraceEventSchema.safeParse(profileStarted).success).toBe(true);
    expect(diagnosticTraceEventSchema.safeParse({ ...profileStarted, sampleCount: { status: 'observed', value: 0 } }).success).toBe(false);
    expect(diagnosticTraceEventSchema.safeParse(profileStopped).success).toBe(true);
    expect(diagnosticTraceEventSchema.safeParse(profileWritten).success).toBe(true);
    expect(diagnosticTraceEventSchema.safeParse(profileFailed).success).toBe(true);
  });

  it('records nested and parallel spans with the owning process identity', async () => {
    const target = recorder();
    const result = await target.withStage(
      { stageId: 'S03_runtime_assembly', operationId: 'op_0000000000000001', attemptId: 'attempt_1' },
      async () => {
        const children = await Promise.all([
          target.withStage(
            { stageId: 'S04_runtime_initialization', operationId: 'op_0000000000000001', attemptId: 'attempt_1' },
            () => 'initialize',
          ),
          target.withStage(
            { stageId: 'S05_directory_scan', operationId: 'op_0000000000000002', attemptId: 'attempt_1' },
            () => 'scan',
          ),
        ]);
        return children.join('+');
      },
    );

    expect(result).toBe('initialize+scan');
    const snapshot = target.snapshot();
    const starts = spanStartedEvents(snapshot.events);
    expect(starts).toHaveLength(3);
    expect(starts.every((event) => event.processStartTicks === identity.processStartTicks)).toBe(true);
    expect(new Set(starts.map((event) => event.spanId)).size).toBe(3);
    const root = starts.find((event) => event.stageId === 'S03_runtime_assembly');
    expect(root).toBeDefined();
    if (root === undefined) return;
    expect(starts.filter((event) => event.parentSpanId === root.spanId)).toHaveLength(2);
  });

  it('separates span identity for the same pid with a different process start tick', async () => {
    const first = recorder();
    const reusedPid = createTraceRecorder({ ...identity, processStartTicks: '4568' }, { nowNs: createFakeClock() });
    const input: StageInput = {
      stageId: 'S00_worker_bootstrap',
      operationId: 'op_0000000000000003',
      attemptId: 'attempt_1',
    };
    await first.withStage(input, () => undefined);
    await reusedPid.withStage(input, () => undefined);

    const firstSpan = spanStartedEvents(first.snapshot().events)[0];
    const reusedSpan = spanStartedEvents(reusedPid.snapshot().events)[0];
    expect(firstSpan?.spanId).not.toBe(reusedSpan?.spanId);
    expect(firstSpan?.processStartTicks).toBe('4567');
    expect(reusedSpan?.processStartTicks).toBe('4568');
  });

  it('uses monotonic nanoseconds for a nonnegative stage duration', async () => {
    const target = recorder();
    await target.withStage(
      { stageId: 'S00_worker_bootstrap', operationId: 'op_0000000000000003', attemptId: 'attempt_1' },
      () => undefined,
    );
    const events = target.snapshot().events;
    const started = spanStartedEvents(events)[0];
    const finished = spanFinishedEvents(events)[0];
    expect(started?.monotonicNs).toBe('1000000');
    expect(finished?.endMonotonicNs).toBe(finished?.monotonicNs);
    expect(finished?.elapsedNs).toBe('2000000');
  });

  it('marks a process-event clock regression incomplete', async () => {
    const target = recorder(createSequenceClock([100n, 200n, 150n]));
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => target.progress(counter('scan.files_emitted', 1)),
    );

    const snapshot = target.snapshot();
    expect(snapshot.traceIncomplete).toBe(true);
    expect(snapshot.incompleteReasons).toContain('clock_regressed');
    const times = snapshot.events.map((event) => BigInt(event.monotonicNs));
    expect(times).toEqual([...times].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
  });

  it('preserves the work result and original error while recording terminal status', async () => {
    const target = recorder();
    const result = await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => 17,
    );
    expect(result).toBe(17);

    const failure = new Error('private filesystem detail');
    await expect(target.withStage(
      { stageId: 'S06_parse_chunk', operationId: 'op_0000000000000006', attemptId: 'attempt_1' },
      () => { throw failure; },
    )).rejects.toBe(failure);

    const finishes = spanFinishedEvents(target.snapshot().events);
    expect(finishes.map((event) => event.status)).toEqual(['completed', 'failed']);
    expect(JSON.stringify(target.snapshot().events)).not.toContain('private filesystem detail');
  });

  it('marks a counter contract violation incomplete without changing the wrapped result', async () => {
    const target = recorder();
    const result = await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => {
        target.progress({ counterId: 'scan.files_emitted', value: 1, unit: 'files', semantics: 'succeeded', sampleReason: 'threshold' });
        target.progress({ counterId: 'scan.files_emitted', value: 2, unit: 'files', semantics: 'succeeded', sampleReason: 'stage_end' });
        target.progress({ counterId: 'scan.files_emitted', value: 1, unit: 'files', semantics: 'succeeded', sampleReason: 'interval' });
        return 'scan-result';
      },
    );

    expect(result).toBe('scan-result');
    const snapshot = target.snapshot();
    expect(snapshot.traceIncomplete).toBe(true);
    expect(snapshot.incompleteReasons).toEqual(['counter_contract_violation']);
    expect(progressEvents(snapshot.events)).toHaveLength(2);
  });

  it('keeps counter monotonicity across child spans in the same operation and attempt', async () => {
    const target = recorder();
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
      () => {
        target.progress(counter('scan.files_emitted', 2));
        return target.withStage(
          { stageId: 'S05_directory_scan', operationId: 'op_0000000000000004', attemptId: 'attempt_1' },
          () => target.progress(counter('scan.files_emitted', 1)),
        );
      },
    );

    const snapshot = target.snapshot();
    expect(snapshot.traceIncomplete).toBe(true);
    expect(snapshot.incompleteReasons).toContain('counter_contract_violation');
    expect(progressEvents(snapshot.events).map((event) => event.value)).toEqual([2]);
  });

  it('rejects invalid initial counter values before event serialization', async () => {
    const target = recorder();
    await target.withStage(
      { stageId: 'S05_directory_scan', operationId: 'op_0000000000000005', attemptId: 'attempt_1' },
      () => target.progress(counter('scan.files_emitted', -1)),
    );

    const snapshot = target.snapshot();
    expect(snapshot.traceIncomplete).toBe(true);
    expect(snapshot.incompleteReasons).toContain('counter_contract_violation');
    expect(progressEvents(snapshot.events)).toHaveLength(0);
  });
});
