const MIN_INTERVAL_NS = 30_000_000_000n;
const MIN_OBSERVATION_NS = 60_000_000_000n;

function processIdentityKey(process) {
  return `${process.pid}:${process.startTicks}`;
}

export function validateSnapshotSequence(snapshots) {
  if (snapshots.length < 3) return ['insufficient_snapshots'];
  const times = snapshots.map((sample) => BigInt(sample.monotonicNs));
  const intervals = times.slice(1).map((time, index) => time - (times[index] ?? time));
  if (times.at(-1) - (times[0] ?? 0n) < MIN_OBSERVATION_NS
    || intervals.some((interval) => interval < MIN_INTERVAL_NS)) return ['snapshot_spacing_invalid'];
  if (snapshots.some((sample) => !sample.processEnumerationComplete
    || !sample.processes.some((process) => process.pid === sample.selfPid))) {
    return ['process_enumeration_incomplete'];
  }
  if (snapshots.some((sample, index) => index > 0
    && sample.logicalCpuCount !== snapshots[index - 1]?.logicalCpuCount)) {
    return ['logical_cpu_count_changed'];
  }
  return [];
}

export function processCpuInterval(previous, current) {
  const aggregateDeltaTicks = current.aggregateCpuTicks - previous.aggregateCpuTicks;
  if (aggregateDeltaTicks <= 0) return { valid: false };
  const previousProcesses = new Map(previous.processes.map((process) => [processIdentityKey(process), process]));
  const currentIdentities = new Set();
  const perProcessCores = new Map();
  let aggregateCores = 0;
  let processDeltaTicks = 0;
  for (const process of current.processes) {
    if (process.pid === current.selfPid) continue;
    const identity = processIdentityKey(process);
    currentIdentities.add(identity);
    const earlier = previousProcesses.get(identity);
    if (earlier === undefined) continue;
    const deltaTicks = process.cpuTicks - earlier.cpuTicks;
    if (deltaTicks < 0) return { valid: false };
    const cores = deltaTicks * current.logicalCpuCount / aggregateDeltaTicks;
    perProcessCores.set(identity, cores);
    aggregateCores += cores;
    processDeltaTicks += deltaTicks;
  }
  return { valid: true, currentIdentities, perProcessCores, aggregateCores, aggregateDeltaTicks, processDeltaTicks };
}
