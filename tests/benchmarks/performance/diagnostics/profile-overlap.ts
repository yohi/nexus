import type { DiagnosticTraceEvent } from './contracts.js';
import type { ProfileCorrelationInput, ProfileCorrelationReason } from './profile-correlation.js';

type ProfileEvent = Extract<DiagnosticTraceEvent, {
  event: 'profile_segment_started' | 'profile_segment_stop_requested' | 'profile_segment_stopped'
    | 'profile_write_completed' | 'profile_write_failed' | 'profile_segment_start_failed' | 'profile_segment_stop_failed';
}>;
type StageEvent = Extract<DiagnosticTraceEvent, { event: 'span_started' | 'span_finished' }>;
type StartedStage = Extract<StageEvent, { event: 'span_started' }>;
type FinishedStage = Extract<StageEvent, { event: 'span_finished' }>;
type CompletedStage = Readonly<{ start: StartedStage; terminal: FinishedStage }>;

function completedStages(
  stages: readonly StageEvent[],
  runId: string,
  reasons: Set<ProfileCorrelationReason>,
): readonly CompletedStage[] {
  const starts = new Map<string, StartedStage>();
  const completed: CompletedStage[] = [];
  for (const event of stages) {
    if (event.runId !== runId) continue;
    if (event.event === 'span_started') starts.set(event.spanId, event);
  }
  for (const terminal of stages) {
    if (terminal.event !== 'span_finished' || terminal.runId !== runId) continue;
    const start = starts.get(terminal.spanId);
    if (start === undefined) continue;
    if (!sameStageIdentity(start, terminal)) {
      reasons.add('process_identity_mismatch');
      continue;
    }
    completed.push({ start, terminal });
  }
  return completed;
}

function sameStageIdentity(start: StartedStage, terminal: FinishedStage): boolean {
  return terminal.pid === start.pid && terminal.processStartTicks === start.processStartTicks
    && terminal.operationId === start.operationId && terminal.attemptId === start.attemptId
    && terminal.stageId === start.stageId && terminal.jobId === start.jobId
    && terminal.recipeDigest === start.recipeDigest && terminal.sourceFingerprint === start.sourceFingerprint;
}

function overlapForSegment(
  first: ProfileEvent,
  stop: Extract<ProfileEvent, { event: 'profile_segment_stopped' }>,
  stage: CompletedStage,
  reasons: Set<ProfileCorrelationReason>,
): Readonly<{ stageId: string; overlapNs: string }> | undefined {
  const { start, terminal } = stage;
  if (start.pid !== first.pid || start.processStartTicks !== first.processStartTicks) return undefined;
  if (start.jobId !== first.jobId || start.recipeDigest !== first.recipeDigest
    || start.sourceFingerprint !== first.sourceFingerprint) {
    reasons.add('process_identity_mismatch');
    return undefined;
  }
  if (start.clockDomain !== first.clockDomain || terminal.clockDomain !== first.clockDomain) {
    reasons.add('stage_clock_mismatch');
    return undefined;
  }
  const overlap = BigInt(terminal.endMonotonicNs) < BigInt(stop.monotonicNs)
    ? BigInt(terminal.endMonotonicNs) : BigInt(stop.monotonicNs);
  const beginning = BigInt(start.monotonicNs) > BigInt(first.monotonicNs)
    ? BigInt(start.monotonicNs) : BigInt(first.monotonicNs);
  return overlap <= beginning ? undefined : { stageId: start.stageId, overlapNs: (overlap - beginning).toString() };
}

export function stageOverlaps(
  segments: readonly (readonly ProfileEvent[])[],
  stages: readonly StageEvent[],
  input: ProfileCorrelationInput,
  reasons: Set<ProfileCorrelationReason>,
): readonly Readonly<{ stageId: string; overlapNs: string }>[] {
  const results: { stageId: string; overlapNs: string }[] = [];
  const completed = completedStages(stages, input.runId, reasons);
  for (const segment of segments) {
    const first = segment[0];
    const stop = segment[2];
    if (first === undefined || stop === undefined || stop.event !== 'profile_segment_stopped') continue;
    for (const stage of completed) {
      const result = overlapForSegment(first, stop, stage, reasons);
      if (result !== undefined) results.push(result);
    }
  }
  return results;
}
