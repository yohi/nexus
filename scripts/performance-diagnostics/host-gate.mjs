import { indeterminate, parseHostGateInputs } from './host-gate-inputs.mjs';
import { processCpuInterval, validateSnapshotSequence } from './host-gate-process-cpu.mjs';

const GIB = 1_073_741_824;
const MIB = 1_048_576;
const MIN_HOST_HEADROOM = 4 * GIB;
const MIN_CGROUP_HEADROOM = 4 * GIB;
const MAX_SWAP_GROWTH = 256 * MIB;
const MIN_CPU_CAPACITY = 4;
const MAX_SINGLE_PROCESS_CORES = 0.5;
const MAX_AGGREGATE_PROCESS_CORES = 1;
const MAX_CPU_PRESSURE_SOME = 1;
const MAX_CPU_PRESSURE_FULL = 0.1;
const MAX_HOST_SNAPSHOT_AGE_NS = 120_000_000_000n;

export function evaluateHostGate(snapshotsValue, smallReportValue, mediumFixtureSizeValue, currentMonotonicNsValue) {
  const parsed = parseHostGateInputs(snapshotsValue, smallReportValue, mediumFixtureSizeValue);
  if (!parsed.ready) return parsed.result;
  const { snapshots, requiredScratchBytes } = parsed;
  const sequenceIssues = validateSnapshotSequence(snapshots);
  if (sequenceIssues.length > 0) return indeterminate(sequenceIssues);
  const latestSnapshot = snapshots.at(-1);
  if (latestSnapshot === undefined) return indeterminate(['telemetry_missing']);
  const currentMonotonicNs = currentMonotonicNsValue ?? latestSnapshot.monotonicNs;
  if (!/^(0|[1-9][0-9]*)$/.test(currentMonotonicNs)) return indeterminate(['monotonic_clock_invalid']);
  const snapshotAgeNs = BigInt(currentMonotonicNs) - BigInt(latestSnapshot.monotonicNs);
  if (snapshotAgeNs < 0n || snapshotAgeNs > MAX_HOST_SNAPSHOT_AGE_NS) {
    return indeterminate(['host_snapshots_stale'], ['host_snapshot_monotonic_age']);
  }

  const reasons = new Set();
  const busyIntervalsByProcess = new Map();
  let aggregateProcessTicks = 0;
  let aggregateSystemTicks = 0;
  let minimumEffectiveCpu = Number.POSITIVE_INFINITY;

  for (let index = 0; index < snapshots.length; index += 1) {
    const current = snapshots[index];
    const previous = snapshots[index - 1];
    const cpuCapacity = Math.min(current.logicalCpuCount, current.affinityCpuCount,
      current.cpusetCpuCount, current.quotaCpuCapacity ?? Number.POSITIVE_INFINITY);
    minimumEffectiveCpu = Math.min(minimumEffectiveCpu, cpuCapacity);
    if (cpuCapacity < MIN_CPU_CAPACITY) reasons.add('cpu_capacity_low');

    const cpuPressure = [current.cpuPressure.host, current.cpuPressure.cgroup];
    if (cpuPressure.some((pressure) => pressure.someAvg60 > MAX_CPU_PRESSURE_SOME
      || pressure.fullAvg60 > MAX_CPU_PRESSURE_FULL)) reasons.add('cpu_pressure');
    const memoryPressure = [current.memoryPressure.host, current.memoryPressure.cgroup];
    if (memoryPressure.some((pressure) => pressure.someAvg60 > 0 || pressure.fullAvg60 > 0)) reasons.add('memory_pressure');
    if (current.memoryAvailableBytes < MIN_HOST_HEADROOM) reasons.add('host_memory_low');
    if (current.cgroupMemoryMaxBytes !== null) {
      if (current.cgroupMemoryCurrentBytes > current.cgroupMemoryMaxBytes) {
        return indeterminate(['cgroup_memory_values_invalid'], ['memory.current', 'memory.max']);
      }
      if (current.cgroupMemoryMaxBytes - current.cgroupMemoryCurrentBytes < MIN_CGROUP_HEADROOM) {
        reasons.add('cgroup_memory_low');
      }
    }
    if (current.scratchFreeBytes < requiredScratchBytes) reasons.add('scratch_low');
    if (previous === undefined) continue;

    const interval = processCpuInterval(previous, current);
    if (!interval.valid) return indeterminate(['process_cpu_counter_regressed'], ['processes.cpuTicks']);
    aggregateProcessTicks += interval.processDeltaTicks;
    aggregateSystemTicks += interval.aggregateDeltaTicks;
    for (const [identity, cores] of interval.perProcessCores) {
      const count = cores > MAX_SINGLE_PROCESS_CORES ? (busyIntervalsByProcess.get(identity) ?? 0) + 1 : 0;
      busyIntervalsByProcess.set(identity, count);
      if (count >= 2) reasons.add('process_cpu_busy');
    }
    for (const identity of busyIntervalsByProcess.keys()) {
      if (!interval.currentIdentities.has(identity)) busyIntervalsByProcess.set(identity, 0);
    }
    if (current.throttledPeriods < previous.throttledPeriods) {
      return indeterminate(['cpu_throttle_counter_regressed'], ['cpu.stat.nr_throttled']);
    }
    if (current.throttledPeriods > previous.throttledPeriods) reasons.add('cpu_throttled');
    for (const key of ['high', 'max', 'oom', 'oomKill']) {
      if (current.memoryEvents[key] < previous.memoryEvents[key]) {
        return indeterminate(['memory_event_counter_regressed'], [`memory.events.${key}`]);
      }
      if (current.memoryEvents[key] > previous.memoryEvents[key]) reasons.add('memory_event_increased');
    }
  }

  const first = snapshots[0];
  const swapGrowth = Math.max(
    ...snapshots.map((snapshot) => snapshot.swapUsedBytes - first.swapUsedBytes),
    ...snapshots.map((snapshot) => snapshot.cgroupSwapCurrentBytes - first.cgroupSwapCurrentBytes),
  );
  if (swapGrowth > MAX_SWAP_GROWTH) reasons.add('swap_growth');
  if (aggregateSystemTicks > 0
    && aggregateProcessTicks * snapshots[0].logicalCpuCount / aggregateSystemTicks > MAX_AGGREGATE_PROCESS_CORES) {
    reasons.add('aggregate_process_cpu_busy');
  }

  const reasonCodes = [...reasons].sort();
  const common = {
    reasonCodes: Object.freeze(reasonCodes),
    requiredScratchBytes,
    scratchFreeBytes: Math.min(...snapshots.map((sample) => sample.scratchFreeBytes)),
    effectiveCpuCapacity: minimumEffectiveCpu,
  };
  return reasonCodes.length > 0
    ? Object.freeze({ status: 'HOST_BUSY_STOP', ...common })
    : Object.freeze({ status: 'PASS', ...common });
}
