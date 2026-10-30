import type { DiagnosticTraceEvent } from './contracts.js';
import type { ProfileCorrelationInput, ProfileCorrelationReason } from './profile-correlation.js';

type ProfileEvent = Extract<DiagnosticTraceEvent, {
  event: 'profile_segment_started' | 'profile_segment_stop_requested' | 'profile_segment_stopped'
    | 'profile_write_completed' | 'profile_write_failed' | 'profile_segment_start_failed' | 'profile_segment_stop_failed';
}>;
type StageEvent = Extract<DiagnosticTraceEvent, { event: 'span_started' | 'span_finished' }>;

export function stageOverlaps(
  segments: readonly (readonly ProfileEvent[])[],
  stages: readonly StageEvent[],
  input: ProfileCorrelationInput,
  reasons: Set<ProfileCorrelationReason>,
): readonly Readonly<{ stageId: string; overlapNs: string }>[] {
  const starts = new Map<string, Extract<StageEvent, { event: 'span_started' }>>();
  const results: { stageId: string; overlapNs: string }[] = [];
  for (const event of stages) {
    if (event.runId !== input.runId) continue;
    if (event.event === 'span_started') starts.set(event.spanId, event);
  }
  for (const segment of segments) {
    const first = segment[0];
    const stop = segment[2];
    if (first === undefined || stop === undefined || stop.event !== 'profile_segment_stopped') continue;
    for (const terminal of stages) {
      if (terminal.event !== 'span_finished' || terminal.runId !== input.runId) continue;
      const start = starts.get(terminal.spanId);
      if (start === undefined) continue;
      if (terminal.pid !== start.pid || terminal.processStartTicks !== start.processStartTicks
        || terminal.operationId !== start.operationId || terminal.attemptId !== start.attemptId
        || terminal.stageId !== start.stageId || terminal.jobId !== start.jobId
        || terminal.recipeDigest !== start.recipeDigest || terminal.sourceFingerprint !== start.sourceFingerprint) {
        reasons.add('process_identity_mismatch');
        continue;
      }
      if (start.pid !== first.pid || start.processStartTicks !== first.processStartTicks) continue;
      if (start.jobId !== first.jobId || start.recipeDigest !== first.recipeDigest
        || start.sourceFingerprint !== first.sourceFingerprint) {
        reasons.add('process_identity_mismatch');
        continue;
      }
      if (start.clockDomain !== first.clockDomain || terminal.clockDomain !== first.clockDomain) {
        reasons.add('stage_clock_mismatch');
        continue;
      }
      const overlap = BigInt(terminal.endMonotonicNs) < BigInt(stop.monotonicNs)
        ? BigInt(terminal.endMonotonicNs) : BigInt(stop.monotonicNs);
      const beginning = BigInt(start.monotonicNs) > BigInt(first.monotonicNs)
        ? BigInt(start.monotonicNs) : BigInt(first.monotonicNs);
      if (overlap <= beginning) continue;
      results.push({ stageId: start.stageId, overlapNs: (overlap - beginning).toString() });
    }
  }
  return results;
}
