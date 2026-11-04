import { stageOverlaps } from './profile-overlap.mjs';

const lifecycle = ['profile_segment_started', 'profile_segment_stop_requested', 'profile_segment_stopped'];
const SELF_SAMPLE_THRESHOLD = 100;
const CPU_ACTIVE_THRESHOLD_US = 1_000_000;

function addReason(reasons, reason) {
  reasons.add(reason);
}

function sameProcessIdentity(left, right) {
  return left.runId === right.runId && left.pid === right.pid && left.processStartTicks === right.processStartTicks
    && left.ppid === right.ppid && left.processRole === right.processRole && left.clockDomain === right.clockDomain
    && left.jobId === right.jobId && left.recipeDigest === right.recipeDigest && left.sourceFingerprint === right.sourceFingerprint;
}

function collectValidSegmentEvents(segment, input, reasons) {
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
  let identity;
  for (const [index, event] of segment.events.entries()) {
    const expectedEvent = lifecycle[index];
    if (event.segmentId !== segmentId || event.runId !== input.runId) {
      addReason(reasons, 'process_identity_mismatch');
      return undefined;
    }
    if (expectedEvent !== undefined && event.event !== expectedEvent) {
      addReason(reasons, 'out_of_order_segment_transition');
      return undefined;
    }
    if (index === 3 && event.event !== 'profile_write_completed' && event.event !== 'profile_write_failed') {
      addReason(reasons, 'out_of_order_segment_transition');
      return undefined;
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
  if (terminal?.event === 'profile_write_failed') {
    addReason(reasons, 'incomplete_segment');
    return undefined;
  }
  return segment.events;
}

export function correlateProfileEvidence(input) {
  const reasons = new Set();
  if (input.clockAlignment.status !== 'aligned') addReason(reasons, 'clock_unaligned');
  const segmentEvents = input.segments.flatMap((segment) => {
    const valid = collectValidSegmentEvents(segment, input, reasons);
    return valid === undefined ? [] : [valid];
  });
  const groups = new Map();
  const processIdentities = new Map();
  const segmentIds = new Map();
  const sequences = new Map();
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
    const identifiers = segmentIds.get(identityKey) ?? new Set();
    if (identifiers.has(first.segmentId)) addReason(reasons, 'duplicate_segment_transition');
    identifiers.add(first.segmentId);
    segmentIds.set(identityKey, identifiers);
    const sequenceSet = sequences.get(identityKey) ?? new Set();
    for (const event of segment) {
      if (sequenceSet.has(event.seq)) addReason(reasons, 'duplicate_segment_transition');
      sequenceSet.add(event.seq);
    }
    sequences.set(identityKey, sequenceSet);
    const current = groups.get(identityKey) ?? [];
    groups.set(identityKey, [...current, segment]);
  }

  let workerSegments = [];
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
    if (!Number.isSafeInteger(matchingTicks.cpuTicksDelta) || matchingTicks.cpuTicksDelta <= 0
      || !Number.isSafeInteger(matchingTicks.cpuDeltaUs) || matchingTicks.cpuDeltaUs <= CPU_ACTIVE_THRESHOLD_US) {
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
    const nonParentGroups = [...groups.values()].filter((segments) => segments[0]?.[0]?.pid !== input.parentPid);
    const maxSegments = Math.max(0, ...nonParentGroups.map((segments) => segments.length));
    const maxSamples = Math.max(0, ...nonParentGroups.map((segments) => segments.reduce((total, segment) => {
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
  if (workerSegments.length > 0 && overlaps.length === 0) addReason(reasons, 'stage_clock_mismatch');
  const reasonCodes = [...reasons];
  return Object.freeze({
    status: reasonCodes.length === 0 ? 'cpu_active_fork_profile_captured' : 'worker_profile_NOT_PROVEN',
    reasonCodes: Object.freeze(reasonCodes),
    selfSamples: workerSegments.length === 0 ? selfSamples : selfSampleCount,
    profilesMissing: input.segments.length - segmentEvents.length,
    stageOverlaps: Object.freeze(overlaps),
  });
}
