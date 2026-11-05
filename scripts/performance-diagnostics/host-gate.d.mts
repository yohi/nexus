import type { HostSnapshot } from './host-snapshot.mjs';
import type { FixtureSizeSummary } from './fixture-size.mjs';

export type HostGateReasonCode =
  | 'telemetry_missing'
  | 'small_artifact_invalid'
  | 'medium_fixture_size_invalid'
  | 'insufficient_snapshots'
  | 'snapshot_spacing_invalid'
  | 'process_enumeration_incomplete'
  | 'logical_cpu_count_changed'
  | 'small_artifact_incompatible'
  | 'scratch_estimate_unavailable'
  | 'cgroup_memory_values_invalid'
  | 'process_cpu_counter_regressed'
  | 'cpu_capacity_low'
  | 'cpu_pressure'
  | 'memory_pressure'
  | 'host_memory_low'
  | 'cgroup_memory_low'
  | 'scratch_low'
  | 'cpu_throttle_counter_regressed'
  | 'cpu_throttled'
  | 'memory_event_counter_regressed'
  | 'memory_event_increased'
  | 'monotonic_clock_invalid'
  | 'host_snapshots_stale'
  | 'swap_growth'
  | 'process_cpu_busy'
  | 'aggregate_process_cpu_busy';

export type HostGateResult = Readonly<{
  status: 'PASS' | 'HOST_BUSY_STOP' | 'HOST_GATE_INDETERMINATE';
  reasonCodes: readonly HostGateReasonCode[];
  missingInputs?: readonly string[];
  requiredScratchBytes?: number;
  scratchFreeBytes?: number;
  effectiveCpuCapacity?: number;
  monotonicNs?: string;
}>;

export function evaluateHostGate(
  snapshots: unknown,
  smallReport: unknown,
  mediumFixtureSize: FixtureSizeSummary | unknown,
  currentMonotonicNs?: string,
): HostGateResult;
