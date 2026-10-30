import type {
  DiagnosticTraceEvent,
  DiagnosticTraceIdentity,
} from './contracts.js';
import type { ClockMappingResult } from './clock-domain.js';
import { stageOverlaps } from './profile-overlap.js';

type ProfileEvent = Extract<DiagnosticTraceEvent, {
  event: 'profile_segment_started' | 'profile_segment_stop_requested' | 'profile_segment_stopped'
    | 'profile_write_completed' | 'profile_write_failed' | 'profile_segment_start_failed' | 'profile_segment_stop_failed';
}>;
type StageEvent = Extract<DiagnosticTraceEvent, { event: 'span_started' | 'span_finished' }>;

export type ProfileSegmentEvidence = Readonly<{
  events: readonly ProfileEvent[];
  profileValid: boolean;
}>;

export type ProcessCpuEvidence = Readonly<{
  runId: string;
  pid: number;
  processStartTicks: string;
  ppid: number;
  cpuDeltaUs: number;
}>;

export type ProfileCorrelationInput = Readonly<{
  runId: string;
  parentPid: number;
  clockAlignment: ClockMappingResult;
  processSamples: readonly ProcessCpuEvidence[];
  preloadMarkers: readonly Readonly<{ runId: string; pid: number; processStartTicks: string; processRole: 'vitest_worker' | 'vitest_parent' | 'unknown_node' }>[];
  segments: readonly ProfileSegmentEvidence[];
  stageEvents: readonly StageEvent[];
}>;

export type ProfileCorrelationReason =
  | 'clock_unaligned'
  | 'parent_only_profile'
  | 'pid_start_tick_mismatch'
  | 'process_identity_mismatch'
  | 'worker_not_observed'
  | 'preload_marker_missing'
  | 'cpu_inactive'
  | 'insufficient_segments'
  | 'insufficient_self_samples'
  | 'corrupt_profile'
  | 'incomplete_segment'
  | 'duplicate_segment_transition'
  | 'out_of_order_segment_transition'
  | 'stage_clock_mismatch';

export type ProfileCorrelationResult = Readonly<{
  status: 'cpu_active_fork_profile_captured' | 'worker_profile_NOT_PROVEN';
  reasonCodes: readonly ProfileCorrelationReason[];
  selfSamples: number;
  profilesMissing: number;
  stageOverlaps: readonly Readonly<{ stageId: string; overlapNs: string }>[];
}>;

const lifecycle = ['profile_segment_started', 'profile_segment_stop_requested', 'profile_segment_stopped'] as const;
const SELF_SAMPLE_THRESHOLD = 100;
const CPU_ACTIVE_THRESHOLD_US = 1_000_000;

function addReason(reasons: Set<ProfileCorrelationReason>, reason: ProfileCorrelationReason): void {
  reasons.add(reason);
}

function sameProcessIdentity(left: DiagnosticTraceIdentity, right: DiagnosticTraceIdentity): boolean {
  return left.runId === right.runId && left.pid === right.pid && left.processStartTicks === right.processStartTicks
    && left.ppid === right.ppid && left.processRole === right.processRole && left.clockDomain === right.clockDomain
    && left.jobId === right.jobId && left.recipeDigest === right.recipeDigest && left.sourceFingerprint === right.sourceFingerprint;
}

function collectValidSegmentEvents(
  segment: ProfileSegmentEvidence,
  input: ProfileCorrelationInput,
  reasons: Set<ProfileCorrelationReason>,
): readonly ProfileEvent[] | undefined {
  if (segment.events.length !== 4) {
    addReason(reasons, segment.events.length > 4 ? 'duplicate_segment_transition' : 'incomplete_segment');
    return undefined;
  }
  const first = segment.events[0];
  if (first === undefined) {
    addReason(reasons, 'incomplete_segment');
    return undefined;
  }
  const segmentId = first.segmentId;
  let identity: DiagnosticTraceIdentity | undefined;
  for (const [index, event] of segment.events.entries()) {
    const expectedEvent = index < lifecycle.length ? lifecycle[index] : undefined;
    if (event.segmentId !== segmentId || event.runId !== input.runId) {
      addReason(reasons, 'process_identity_mismatch');
      return undefined;
    }
    if (expectedEvent !== undefined && event.event !== expectedEvent) {
      addReason(reasons, index === 0 ? 'out_of_order_segment_transition' : 'out_of_order_segment_transition');
      return undefined;
    }
    if (index === 3) {
      switch (event.event) {
        case 'profile_write_completed':
        case 'profile_write_failed':
          break;
        default:
          addReason(reasons, 'out_of_order_segment_transition');
          return undefined;
      }
    }
    if (identity !== undefined && !sameProcessIdentity(identity, event)) {
      addReason(reasons, 'process_identity_mismatch');
      return undefined;
    }
    identity = event;
    if (index > 0) {
      const previous = segment.events[index - 1];
      if (previous !== undefined && (event.seq <= previous.seq || BigInt(event.monotonicNs) < BigInt(previous.monotonicNs))) {
        addReason(reasons, 'out_of_order_segment_transition');
        return undefined;
      }
    }
  }
  if (!segment.profileValid) {
    addReason(reasons, 'corrupt_profile');
    return undefined;
  }
  const terminal = segment.events[3];
  const stopped = segment.events[2];
  if (terminal?.event === 'profile_write_completed' && (terminal.fileBytes.value === 0
    || stopped?.event !== 'profile_segment_stopped' || terminal.sampleCount.value !== stopped.sampleCount.value)) {
    addReason(reasons, 'corrupt_profile');
    return undefined;
  }
  if (segment.events[3]?.event === 'profile_write_failed') {
    addReason(reasons, 'incomplete_segment');
    return undefined;
  }
  return segment.events;
}

export function correlateProfileEvidence(input: ProfileCorrelationInput): ProfileCorrelationResult {
  const reasons = new Set<ProfileCorrelationReason>();
  if (input.clockAlignment.status !== 'aligned') addReason(reasons, 'clock_unaligned');
  const segmentEvents = input.segments.flatMap((segment) => {
    const valid = collectValidSegmentEvents(segment, input, reasons);
    return valid === undefined ? [] : [valid];
  });
  const groups = new Map<string, readonly (readonly ProfileEvent[])[]>();
  const processIdentities = new Map<string, DiagnosticTraceIdentity>();
  const segmentIds = new Map<string, Set<string>>();
  const sequences = new Map<string, Set<number>>();
  for (const segment of segmentEvents) {
    const first = segment[0];
    if (first === undefined) continue;
    const identityKey = `${first.pid}:${first.processStartTicks}`;
    const previousIdentity = processIdentities.get(identityKey);
    if (previousIdentity !== undefined && !sameProcessIdentity(previousIdentity, first)) {
      addReason(reasons, 'process_identity_mismatch');
    } else {
      processIdentities.set(identityKey, first);
    }
    const identifiers = segmentIds.get(identityKey) ?? new Set<string>();
    if (identifiers.has(first.segmentId)) addReason(reasons, 'duplicate_segment_transition');
    identifiers.add(first.segmentId);
    segmentIds.set(identityKey, identifiers);
    const sequenceSet = sequences.get(identityKey) ?? new Set<number>();
    for (const event of segment) {
      if (sequenceSet.has(event.seq)) addReason(reasons, 'duplicate_segment_transition');
      sequenceSet.add(event.seq);
    }
    sequences.set(identityKey, sequenceSet);
    const current = groups.get(identityKey) ?? [];
    groups.set(identityKey, [...current, segment]);
  }

  let workerSegments: readonly (readonly ProfileEvent[])[] = [];
  let selfSamples = 0;
  let hasObservedChild = false;
  let hasReusedPid = false;
  let hasUnownedChild = false;
  let hasInactiveChild = false;
  let hasMissingPreload = false;
  for (const segments of groups.values()) {
    const first = segments[0]?.[0];
    if (first === undefined || first.pid === input.parentPid) continue;
    hasObservedChild = true;
    const samePid = input.processSamples.filter((sample) => sample.runId === input.runId && sample.pid === first.pid);
    const matchingTicks = samePid.find((sample) => sample.processStartTicks === first.processStartTicks);
    if (matchingTicks === undefined) {
      hasReusedPid ||= samePid.length > 0;
      continue;
    }
    if (matchingTicks.ppid !== input.parentPid) {
      hasUnownedChild = true;
      continue;
    }
    if (!Number.isSafeInteger(matchingTicks.cpuDeltaUs) || matchingTicks.cpuDeltaUs <= CPU_ACTIVE_THRESHOLD_US) {
      hasInactiveChild = true;
      continue;
    }
    const marker = input.preloadMarkers.find((candidate) => candidate.runId === input.runId
      && candidate.pid === first.pid && candidate.processStartTicks === first.processStartTicks
      && candidate.processRole === 'vitest_worker');
    if (marker === undefined) {
      hasMissingPreload = true;
      continue;
    }
    const sampleCount = segments.reduce((total, segment) => {
      const write = segment[3];
      return total + (write?.event === 'profile_write_completed' ? write.sampleCount.value : 0);
    }, 0);
    if (segments.length >= 2 && sampleCount >= SELF_SAMPLE_THRESHOLD) {
      workerSegments = segments;
      selfSamples = sampleCount;
      break;
    }
  }
  if (workerSegments.length === 0) {
    if (!hasObservedChild && groups.size > 0) addReason(reasons, 'parent_only_profile');
    if (hasReusedPid) addReason(reasons, 'pid_start_tick_mismatch');
    else if (hasUnownedChild) addReason(reasons, 'process_identity_mismatch');
    else if (hasInactiveChild) addReason(reasons, 'cpu_inactive');
    else if (hasMissingPreload) addReason(reasons, 'preload_marker_missing');
    else if (!hasObservedChild && groups.size === 0) addReason(reasons, 'incomplete_segment');
    if (hasObservedChild && !reasons.has('pid_start_tick_mismatch') && !reasons.has('process_identity_mismatch')
      && !reasons.has('cpu_inactive') && !reasons.has('preload_marker_missing')) addReason(reasons, 'worker_not_observed');
    const maxSegments = Math.max(0, ...[...groups.values()].filter((segments) => segments[0]?.[0]?.pid !== input.parentPid).map((segments) => segments.length));
    const maxSamples = Math.max(0, ...[...groups.values()].filter((segments) => segments[0]?.[0]?.pid !== input.parentPid).map((segments) => segments.reduce((total, segment) => {
      const terminal = segment[3];
      return total + (terminal?.event === 'profile_write_completed' ? terminal.sampleCount.value : 0);
    }, 0)));
    if (maxSegments < 2) addReason(reasons, 'insufficient_segments');
    if (maxSamples < SELF_SAMPLE_THRESHOLD) addReason(reasons, 'insufficient_self_samples');
  }

  const selfSampleCount = workerSegments.reduce((total, segment) => {
    const write = segment[3];
    return total + (write?.event === 'profile_write_completed' ? write.sampleCount.value : 0);
  }, 0);
  const overlaps = stageOverlaps(workerSegments, input.stageEvents, input, reasons);
  const reasonCodes = [...reasons];
  return Object.freeze({
    status: reasonCodes.length === 0 ? 'cpu_active_fork_profile_captured' : 'worker_profile_NOT_PROVEN',
    reasonCodes: Object.freeze(reasonCodes),
    selfSamples: workerSegments.length === 0 ? selfSamples : selfSampleCount,
    profilesMissing: input.segments.length - segmentEvents.length,
    stageOverlaps: Object.freeze(overlaps),
  });
}
