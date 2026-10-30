import { describe, expect, it } from 'vitest';

import {
  diagnosticTraceEventSchema,
  type DiagnosticTraceEvent,
  type DiagnosticTraceIdentity,
} from '../../../../benchmarks/performance/diagnostics/contracts.js';
import { correlateProfileEvidence, type ProfileCorrelationInput } from '../../../../benchmarks/performance/diagnostics/profile-correlation.js';
import { calibrateClockMapping } from '../../../../benchmarks/performance/diagnostics/clock-domain.js';

type ProfileTraceEvent = Extract<DiagnosticTraceEvent, {
  event: 'profile_segment_started' | 'profile_segment_stop_requested' | 'profile_segment_stopped'
    | 'profile_write_completed' | 'profile_write_failed' | 'profile_segment_start_failed' | 'profile_segment_stop_failed';
}>;
type StageTraceEvent = Extract<DiagnosticTraceEvent, { event: 'span_started' | 'span_finished' }>;

const identity: DiagnosticTraceIdentity = {
  runId: '00000000-0000-4000-8000-000000000001',
  jobId: 'cold_initial_index',
  recipeDigest: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  pid: 3002,
  processStartTicks: '4567',
  ppid: 2000,
  processRole: 'vitest_worker',
  clockDomain: 'process_local_monotonic',
};

function alignedClock() {
  const pings = [1n, 2n, 3n].map((sample) => {
    const childMonotonicNs = sample * 1_000n;
    const parentSendNs = childMonotonicNs + 10_000n;
    return { parentSendNs, childMonotonicNs, parentReceiveNs: parentSendNs + 1_000n };
  });
  return calibrateClockMapping({
    start: {
      bootId: 'boot-a', parentClockSource: 'time.clock_gettime_ns:CLOCK_MONOTONIC', parentResolutionNs: 1n,
      childClockSource: 'process.hrtime.bigint', childResolutionNs: 1n, pings,
    },
    end: {
      bootId: 'boot-a', parentClockSource: 'time.clock_gettime_ns:CLOCK_MONOTONIC', parentResolutionNs: 1n,
      childClockSource: 'process.hrtime.bigint', childResolutionNs: 1n, pings,
    },
    parentClockDomain: 'linux_clock_monotonic_ns', childClockDomain: 'process_local_monotonic',
  });
}

function profileEvent(event: string, segmentId: string, seq: number, monotonicNs: string, extra: Record<string, unknown> = {}): ProfileTraceEvent {
  const parsed = diagnosticTraceEventSchema.parse({
    ...identity, schemaVersion: 1, seq, monotonicNs, event, segmentId,
    ...(event === 'profile_segment_started' || event === 'profile_segment_stop_requested'
      ? { sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' }, fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' } }
      : {}),
    ...(event === 'profile_segment_stopped'
      ? { sampleCount: { status: 'observed', value: 50 }, fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' } }
      : {}),
    ...(event === 'profile_write_completed'
      ? { sampleCount: { status: 'observed', value: 50 }, fileBytes: { status: 'observed', value: 100 } }
      : {}),
    ...extra,
  });
  switch (parsed.event) {
    case 'profile_segment_started':
    case 'profile_segment_stop_requested':
    case 'profile_segment_stopped':
    case 'profile_write_completed':
    case 'profile_write_failed':
    case 'profile_segment_start_failed':
    case 'profile_segment_stop_failed':
      return parsed;
    default:
      throw new Error('Expected profile lifecycle event');
  }
}

function stageEvent(event: unknown): StageTraceEvent {
  const parsed = diagnosticTraceEventSchema.parse(event);
  switch (parsed.event) {
    case 'span_started':
    case 'span_finished':
      return parsed;
    default:
      throw new Error('Expected stage span event');
  }
}

function completeSegment(segmentId: string, seq: number, startNs: number): readonly ProfileTraceEvent[] {
  return [
    profileEvent('profile_segment_started', segmentId, seq, String(startNs)),
    profileEvent('profile_segment_stop_requested', segmentId, seq + 1, String(startNs + 10)),
    profileEvent('profile_segment_stopped', segmentId, seq + 2, String(startNs + 20)),
    profileEvent('profile_write_completed', segmentId, seq + 3, String(startNs + 30)),
  ];
}

function validInput(overrides: Partial<ProfileCorrelationInput> = {}): ProfileCorrelationInput {
  const stages: readonly StageTraceEvent[] = [
    stageEvent({
      ...identity, schemaVersion: 1, seq: 20, monotonicNs: '5', event: 'span_started',
      spanId: '3002:4567:1', operationId: 'op_0000000000000001', attemptId: 'attempt_1', stageId: 'S06_parse_chunk',
    }),
    stageEvent({
      ...identity, schemaVersion: 1, seq: 21, monotonicNs: '25', event: 'span_finished',
      spanId: '3002:4567:1', operationId: 'op_0000000000000001', attemptId: 'attempt_1', stageId: 'S06_parse_chunk',
      status: 'completed', endMonotonicNs: '25', elapsedNs: '20',
    }),
  ];
  return {
    runId: identity.runId,
    parentPid: 2000,
    clockAlignment: alignedClock(),
    processSamples: [{ runId: identity.runId, pid: identity.pid, processStartTicks: identity.processStartTicks, ppid: 2000, cpuDeltaUs: 2_000_000 }],
    preloadMarkers: [{ runId: identity.runId, pid: identity.pid, processStartTicks: identity.processStartTicks, processRole: 'vitest_worker' }],
    segments: [
      { events: completeSegment('segment_a', 1, 6), profileValid: true },
      { events: completeSegment('segment_b', 5, 26), profileValid: true },
    ],
    stageEvents: stages,
    ...overrides,
  };
}

describe('profile evidence correlation', () => {
  it('does not prove a worker profile without its matching preload marker', () => {
    const input = { ...validInput(), preloadMarkers: [] };
    const result = correlateProfileEvidence(input);
    expect(result.status).toBe('worker_profile_NOT_PROVEN');
    expect(result.reasonCodes).toContain('preload_marker_missing');
  });
  it('proves a CPU-active fork profile only from two complete same-identity segments', () => {
    const result = correlateProfileEvidence(validInput());

    expect(result.status).toBe('cpu_active_fork_profile_captured');
    expect(result.selfSamples).toBe(100);
    expect(result.stageOverlaps).toContainEqual({ stageId: 'S06_parse_chunk', overlapNs: '19' });
  });

  it('rejects a parent-only profile', () => {
    const parent = { ...identity, pid: 2000, ppid: 1, processRole: 'vitest_parent' as const, processStartTicks: '8888' };
    const parentSegments = validInput().segments.map((segment) => ({
      ...segment,
      events: segment.events.map((event) => profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, {
        pid: parent.pid, processStartTicks: parent.processStartTicks, ppid: parent.ppid, processRole: parent.processRole,
      })),
    }));
    const result = correlateProfileEvidence(validInput({
      segments: parentSegments,
      processSamples: [{ runId: parent.runId, pid: parent.pid, processStartTicks: parent.processStartTicks, ppid: parent.ppid, cpuDeltaUs: 2_000_000 }],
    }));

    expect(result.status).toBe('worker_profile_NOT_PROVEN');
    expect(result.reasonCodes).toContain('parent_only_profile');
  });

  it('uses complete child evidence even when parent profiles appear first', () => {
    const parent = { ...identity, pid: 2000, ppid: 1, processRole: 'vitest_parent' as const, processStartTicks: '8888' };
    const parentSegments = validInput().segments.slice(0, 1).map((segment) => ({
      ...segment,
      events: segment.events.map((event) => profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, {
        pid: parent.pid, processStartTicks: parent.processStartTicks, ppid: parent.ppid, processRole: parent.processRole,
      })),
    }));
    const result = correlateProfileEvidence(validInput({
      segments: [...parentSegments, ...validInput().segments],
      processSamples: [
        { runId: parent.runId, pid: parent.pid, processStartTicks: parent.processStartTicks, ppid: parent.ppid, cpuDeltaUs: 5_000_000 },
        ...validInput().processSamples,
      ],
    }));
    expect(result.status).toBe('cpu_active_fork_profile_captured');
    expect(result.reasonCodes).not.toContain('parent_only_profile');
  });

  it('rejects a child that did not exceed the CPU-active threshold', () => {
    const input = validInput({
      processSamples: [{ runId: identity.runId, pid: identity.pid, processStartTicks: identity.processStartTicks, ppid: 2000, cpuDeltaUs: 1_000_000 }],
    });
    expect(correlateProfileEvidence(input).reasonCodes).toContain('cpu_inactive');
  });

  it('rejects a non-finite CPU observation instead of proving a worker profile', () => {
    const input = validInput({
      processSamples: [{ runId: identity.runId, pid: identity.pid, processStartTicks: identity.processStartTicks, ppid: 2000, cpuDeltaUs: Number.NaN }],
    });
    expect(correlateProfileEvidence(input).status).toBe('worker_profile_NOT_PROVEN');
  });

  it('rejects fewer than two complete segments and fewer than one hundred self samples', () => {
    const oneSegment = validInput({ segments: validInput().segments.slice(0, 1) });
    const tooFewSamples = validInput({
      segments: validInput().segments.map((segment) => ({
        ...segment,
        events: segment.events.map((event) => event.event === 'profile_write_completed' || event.event === 'profile_segment_stopped'
          ? profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, { sampleCount: { status: 'observed', value: 49 } }) : event),
      })),
    });
    expect(correlateProfileEvidence(oneSegment).reasonCodes).toContain('insufficient_segments');
    expect(correlateProfileEvidence(tooFewSamples).reasonCodes).toContain('insufficient_self_samples');
  });

  it('does not accept observed zero samples or a failed profile write as complete evidence', () => {
    const zeroSamples = validInput({
      segments: validInput().segments.map((segment) => ({
        ...segment,
        events: segment.events.map((event) => event.event === 'profile_write_completed' || event.event === 'profile_segment_stopped'
          ? profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, {
            sampleCount: { status: 'observed', value: 0 },
          }) : event),
      })),
    });
    const failedWrite = validInput({
      segments: validInput().segments.map((segment) => ({
        ...segment,
        events: segment.events.map((event) => event.event === 'profile_write_completed'
          ? profileEvent('profile_write_failed', event.segmentId, event.seq, event.monotonicNs, {
            sampleCount: { status: 'observed', value: 50 },
            fileBytes: { status: 'not_collected', reasonCode: 'profile_missing' },
            errorCategory: 'io_error',
          }) : event),
      })),
    });
    expect(correlateProfileEvidence(zeroSamples).reasonCodes).toContain('insufficient_self_samples');
    expect(correlateProfileEvidence(failedWrite).reasonCodes).toContain('incomplete_segment');
  });

  it('reports a profiler stop failure as an incomplete segment', () => {
    const segment = completeSegment('segment_a', 1, 6);
    const failedStop = profileEvent('profile_segment_stop_failed', 'segment_a', 3, '26', {
      sampleCount: { status: 'not_collected', reasonCode: 'profile_missing' },
      fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
      errorCategory: 'observer_error',
    });
    const result = correlateProfileEvidence(validInput({
      segments: [{ events: [...segment.slice(0, 2), failedStop], profileValid: false }],
    }));
    expect(result.status).toBe('worker_profile_NOT_PROVEN');
    expect(result.reasonCodes).toContain('incomplete_segment');
  });

  it('rejects a write-completed profile with zero file bytes', () => {
    const emptyFiles = validInput({
      segments: validInput().segments.map((segment) => ({
        ...segment,
        events: segment.events.map((event) => event.event === 'profile_write_completed'
          ? profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, {
            fileBytes: { status: 'observed', value: 0 },
          }) : event),
      })),
    });
    expect(correlateProfileEvidence(emptyFiles).reasonCodes).toContain('corrupt_profile');
  });

  it('rejects a segment when stopped and written sample counts differ', () => {
    const mismatch = validInput({
      segments: validInput().segments.map((segment) => ({
        ...segment,
        events: segment.events.map((event) => event.event === 'profile_write_completed'
          ? profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, {
            sampleCount: { status: 'observed', value: 51 },
          }) : event),
      })),
    });
    expect(correlateProfileEvidence(mismatch).reasonCodes).toContain('corrupt_profile');
  });

  it('rejects reused PIDs whose process start ticks differ', () => {
    const input = validInput({
      processSamples: [{ runId: identity.runId, pid: identity.pid, processStartTicks: 'different-ticks', ppid: 2000, cpuDeltaUs: 2_000_000 }],
    });
    const result = correlateProfileEvidence(input);
    expect(result.status).toBe('worker_profile_NOT_PROVEN');
    expect(result.reasonCodes).toContain('pid_start_tick_mismatch');
  });

  it('rejects a matching PID/start-tick whose observed parent is not the expected Vitest parent', () => {
    const input = validInput({
      processSamples: [{ runId: identity.runId, pid: identity.pid, processStartTicks: identity.processStartTicks, ppid: 1999, cpuDeltaUs: 2_000_000 }],
    });
    const result = correlateProfileEvidence(input);
    expect(result.status).toBe('worker_profile_NOT_PROVEN');
    expect(result.reasonCodes).toContain('process_identity_mismatch');
  });

  it('rejects corrupt, missing, duplicate, out-of-order, or identity-mismatched segment events', () => {
    const valid = validInput();
    const corrupt = validInput({ segments: valid.segments.map((segment) => ({ ...segment, profileValid: false })) });
    const missingWrite = validInput({ segments: valid.segments.map((segment) => ({ ...segment, events: segment.events.slice(0, 3) })) });
    const duplicate = validInput({ segments: valid.segments.map((segment) => {
      const lastEvent = segment.events.at(-1);
      if (lastEvent === undefined) throw new Error('Expected a completed segment event');
      return { ...segment, events: [...segment.events, lastEvent] };
    }) });
    const outOfOrder = validInput({ segments: valid.segments.map((segment) => ({ ...segment, events: [...segment.events].reverse() })) });
    const wrongIdentity = validInput({ segments: valid.segments.map((segment) => ({
      ...segment,
      events: segment.events.map((event, index) => index === 1
        ? profileEvent(event.event, event.segmentId, event.seq, event.monotonicNs, { processStartTicks: '9999' }) : event),
    })) });

    expect(correlateProfileEvidence(corrupt).reasonCodes).toContain('corrupt_profile');
    expect(correlateProfileEvidence(missingWrite).reasonCodes).toContain('incomplete_segment');
    expect(correlateProfileEvidence(duplicate).reasonCodes).toContain('duplicate_segment_transition');
    expect(correlateProfileEvidence(outOfOrder).reasonCodes).toContain('out_of_order_segment_transition');
    expect(correlateProfileEvidence(wrongIdentity).reasonCodes).toContain('process_identity_mismatch');
  });

  it('rejects the same segment ID appearing twice for one worker identity', () => {
    const valid = validInput();
    const secondSegment = valid.segments[1];
    if (secondSegment === undefined) throw new Error('Expected second profile segment');
    const duplicateIdSegment = {
      ...secondSegment,
      events: completeSegment('segment_a', 5, 26),
    };
    const result = correlateProfileEvidence(validInput({ segments: [valid.segments[0] ?? secondSegment, duplicateIdSegment] }));
    expect(result.status).toBe('worker_profile_NOT_PROVEN');
    expect(result.reasonCodes).toContain('duplicate_segment_transition');
  });

  it('rejects segments from a different recipe under the same process identity', () => {
    const valid = validInput();
    const segments = valid.segments.map((segment, index) => ({
      ...segment,
      events: index === 0 ? segment.events : segment.events.map((event) => profileEvent(
        event.event, event.segmentId, event.seq, event.monotonicNs, { recipeDigest: 'c'.repeat(64) },
      )),
    }));
    expect(correlateProfileEvidence(validInput({ segments })).status).toBe('worker_profile_NOT_PROVEN');
  });

  it('does not attribute stage overlap from a different source fingerprint', () => {
    const input = validInput({ stageEvents: validInput().stageEvents.map((event) => stageEvent({
      ...event, sourceFingerprint: 'c'.repeat(64),
    })) });
    expect(correlateProfileEvidence(input).stageOverlaps).toEqual([]);
  });

  it('does not attribute stage overlap when profile and stage clocks differ', () => {
    const input = validInput({
      stageEvents: validInput().stageEvents.map((event) => stageEvent({ ...event, clockDomain: 'linux_clock_monotonic_ns' })),
    });
    const result = correlateProfileEvidence(input);
    expect(result.stageOverlaps).toEqual([]);
    expect(result.reasonCodes).toContain('stage_clock_mismatch');
  });

  it('does not join a stage terminal from a different process identity', () => {
    const input = validInput({
      stageEvents: validInput().stageEvents.map((event) => event.event === 'span_finished'
        ? stageEvent({ ...event, pid: 4000, processStartTicks: '9876' }) : event),
    });
    const result = correlateProfileEvidence(input);
    expect(result.stageOverlaps).toEqual([]);
    expect(result.reasonCodes).toContain('process_identity_mismatch');
  });

  it('does not sum overlapping spans into a misleading stage CPU duration', () => {
    const original = validInput();
    const secondSpan = original.stageEvents.map((event) => stageEvent({
      ...event, spanId: '3002:4567:2', seq: event.seq + 2,
    }));
    const result = correlateProfileEvidence(validInput({ stageEvents: [...original.stageEvents, ...secondSpan] }));
    expect(result.stageOverlaps).toEqual([
      { stageId: 'S06_parse_chunk', overlapNs: '19' },
      { stageId: 'S06_parse_chunk', overlapNs: '19' },
    ]);
  });

  it('never exposes raw profile paths or source URLs in the summary', () => {
    const result = correlateProfileEvidence(validInput());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('.cpuprofile');
    expect(serialized).not.toContain('file://');
  });
});
