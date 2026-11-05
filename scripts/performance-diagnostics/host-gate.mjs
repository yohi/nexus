import { indeterminate, parseHostGateInputs } from './host-gate-inputs.mjs';
import { processCpuInterval, validateSnapshotSequence } from './host-gate-process-cpu.mjs';
import { compareStrings } from './diagnostic-string-order.mjs';

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

function evaluatePressureAndMemory(snapshot, requiredScratchBytes, reasons) {
  const cpuPressure = [snapshot.cpuPressure.host, snapshot.cpuPressure.cgroup];
  if (cpuPressure.some((pressure) => pressure.someAvg60 > MAX_CPU_PRESSURE_SOME
    || pressure.fullAvg60 > MAX_CPU_PRESSURE_FULL)) reasons.add('cpu_pressure');
  const memoryPressure = [snapshot.memoryPressure.host, snapshot.memoryPressure.cgroup];
  if (memoryPressure.some((pressure) => pressure.someAvg60 > 0 || pressure.fullAvg60 > 0)) reasons.add('memory_pressure');
  if (snapshot.memoryAvailableBytes < MIN_HOST_HEADROOM) reasons.add('host_memory_low');
  if (snapshot.cgroupMemoryMaxBytes !== null) {
    if (snapshot.cgroupMemoryCurrentBytes > snapshot.cgroupMemoryMaxBytes) {
      return indeterminate(['cgroup_memory_values_invalid'], ['memory.current', 'memory.max']);
    }
    if (snapshot.cgroupMemoryMaxBytes - snapshot.cgroupMemoryCurrentBytes < MIN_CGROUP_HEADROOM) {
      reasons.add('cgroup_memory_low');
    }
  }
  if (snapshot.scratchFreeBytes < requiredScratchBytes) reasons.add('scratch_low');
  return undefined;
}

function recordBusyProcessIntervals(interval, busyIntervalsByProcess, reasons) {
  for (const [identity, cores] of interval.perProcessCores) {
    const count = cores > MAX_SINGLE_PROCESS_CORES ? (busyIntervalsByProcess.get(identity) ?? 0) + 1 : 0;
    busyIntervalsByProcess.set(identity, count);
    if (count >= 2) reasons.add('process_cpu_busy');
  }
  for (const identity of busyIntervalsByProcess.keys()) {
    if (!interval.currentIdentities.has(identity)) busyIntervalsByProcess.set(identity, 0);
  }
}

function validateResourceCounters(previous, current, reasons) {
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
  return undefined;
}

function accumulateProcessInterval(previous, current, busyIntervalsByProcess, state) {
  if (previous === undefined) return undefined;
  const interval = processCpuInterval(previous, current);
  if (!interval.valid) return indeterminate(['process_cpu_counter_regressed'], ['processes.cpuTicks']);
  state.aggregateProcessTicks += interval.processDeltaTicks;
  state.aggregateSystemTicks += interval.aggregateDeltaTicks;
  recordBusyProcessIntervals(interval, busyIntervalsByProcess, state.reasons);
  return validateResourceCounters(previous, current, state.reasons);
}

function inspectHostSnapshot(snapshot, previous, requiredScratchBytes, state) {
  const cpuCapacity = Math.min(snapshot.logicalCpuCount, snapshot.affinityCpuCount,
    snapshot.cpusetCpuCount, snapshot.quotaCpuCapacity ?? Number.POSITIVE_INFINITY);
  state.minimumEffectiveCpu = Math.min(state.minimumEffectiveCpu, cpuCapacity);
  if (cpuCapacity < MIN_CPU_CAPACITY) state.reasons.add('cpu_capacity_low');
  const invalidResources = evaluatePressureAndMemory(snapshot, requiredScratchBytes, state.reasons);
  if (invalidResources !== undefined) return invalidResources;
  return accumulateProcessInterval(previous, snapshot, state.busyIntervalsByProcess, state);
}

function createSnapshotState() {
  return {
    reasons: new Set(),
    busyIntervalsByProcess: new Map(),
    aggregateProcessTicks: 0,
    aggregateSystemTicks: 0,
    minimumEffectiveCpu: Number.POSITIVE_INFINITY,
  };
}

function hostGateResult(snapshots, requiredScratchBytes, state) {
  const first = snapshots[0];
  const swapGrowth = Math.max(
    ...snapshots.map((snapshot) => snapshot.swapUsedBytes - first.swapUsedBytes),
    ...snapshots.map((snapshot) => snapshot.cgroupSwapCurrentBytes - first.cgroupSwapCurrentBytes),
  );
  if (swapGrowth > MAX_SWAP_GROWTH) state.reasons.add('swap_growth');
  if (state.aggregateSystemTicks > 0
    && state.aggregateProcessTicks * snapshots[0].logicalCpuCount / state.aggregateSystemTicks > MAX_AGGREGATE_PROCESS_CORES) {
    state.reasons.add('aggregate_process_cpu_busy');
  }
  const reasonCodes = [...state.reasons].sort(compareStrings);
  const common = {
    reasonCodes: Object.freeze(reasonCodes),
    requiredScratchBytes,
    scratchFreeBytes: Math.min(...snapshots.map((sample) => sample.scratchFreeBytes)),
    effectiveCpuCapacity: state.minimumEffectiveCpu,
  };
  return reasonCodes.length > 0
    ? Object.freeze({ status: 'HOST_BUSY_STOP', ...common })
    : Object.freeze({ status: 'PASS', ...common });
}

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

  const state = createSnapshotState();

  for (let index = 0; index < snapshots.length; index += 1) {
    const current = snapshots[index];
    const previous = snapshots[index - 1];
    const invalid = inspectHostSnapshot(current, previous, requiredScratchBytes, state);
    if (invalid !== undefined) return invalid;
  }

  return hostGateResult(snapshots, requiredScratchBytes, state);
}
