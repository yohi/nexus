function sameStageIdentity(start, terminal) {
  return terminal.pid === start.pid && terminal.processStartTicks === start.processStartTicks
    && terminal.operationId === start.operationId && terminal.attemptId === start.attemptId
    && terminal.stageId === start.stageId && terminal.jobId === start.jobId
    && terminal.recipeDigest === start.recipeDigest && terminal.sourceFingerprint === start.sourceFingerprint;
}

function sameSegmentIdentity(start, first) {
  return start.pid === first.pid && start.processStartTicks === first.processStartTicks
    && start.jobId === first.jobId && start.recipeDigest === first.recipeDigest
    && start.sourceFingerprint === first.sourceFingerprint;
}

function addOverlap(start, terminal, first, stop, reasons, results) {
  if (!sameStageIdentity(start, terminal)) {
    reasons.add('process_identity_mismatch');
    return;
  }
  if (start.pid !== first.pid || start.processStartTicks !== first.processStartTicks) return;
  if (!sameSegmentIdentity(start, first)) {
    reasons.add('process_identity_mismatch');
    return;
  }
  if (start.clockDomain !== first.clockDomain || terminal.clockDomain !== first.clockDomain) {
    reasons.add('stage_clock_mismatch');
    return;
  }
  const overlap = BigInt(terminal.endMonotonicNs) < BigInt(stop.monotonicNs)
    ? BigInt(terminal.endMonotonicNs) : BigInt(stop.monotonicNs);
  const beginning = BigInt(start.monotonicNs) > BigInt(first.monotonicNs)
    ? BigInt(start.monotonicNs) : BigInt(first.monotonicNs);
  if (overlap > beginning) results.push({ stageId: start.stageId, overlapNs: (overlap - beginning).toString() });
}

function addSegmentOverlaps(segment, stages, starts, input, reasons, results) {
  const first = segment[0];
  const stop = segment[2];
  if (first === undefined || stop === undefined || stop.event !== 'profile_segment_stopped') return;
  for (const terminal of stages) {
    if (terminal.event !== 'span_finished' || terminal.runId !== input.runId) continue;
    const start = starts.get(terminal.spanId);
    if (start !== undefined) addOverlap(start, terminal, first, stop, reasons, results);
  }
}

export function stageOverlaps(segments, stages, input, reasons) {
  const starts = new Map();
  const results = [];
  for (const event of stages) {
    if (event.runId === input.runId && event.event === 'span_started') starts.set(event.spanId, event);
  }
  for (const segment of segments) addSegmentOverlaps(segment, stages, starts, input, reasons, results);
  return results;
}
