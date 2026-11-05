import type { ClockMappingResult } from '../../tests/benchmarks/performance/diagnostics/clock-domain.js';
import type { DiagnosticTraceEvent, DiagnosticTraceIdentity } from '../../tests/benchmarks/performance/diagnostics/contracts.js';

type ProfileEvent = Extract<DiagnosticTraceEvent, {
  readonly event: 'profile_segment_started' | 'profile_segment_stop_requested' | 'profile_segment_stopped'
    | 'profile_write_completed' | 'profile_write_failed' | 'profile_segment_start_failed' | 'profile_segment_stop_failed';
}>;
type StageEvent = Extract<DiagnosticTraceEvent, { readonly event: 'span_started' | 'span_finished' }>;

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
  cpuTicksDelta: number;
}>;

export type ProfileCorrelationInput = Readonly<{
  runId: string;
  parentPid: number;
  clockAlignment: ClockMappingResult;
  processSamples: readonly ProcessCpuEvidence[];
  preloadMarkers: readonly Readonly<{
    runId: string;
    pid: number;
    processStartTicks: string;
    processRole: DiagnosticTraceIdentity['processRole'];
  }>[];
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

export function correlateProfileEvidence(input: ProfileCorrelationInput): ProfileCorrelationResult;
