import { readFile, readdir, statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  classifyCgroup,
  parseAggregateCpuStat,
  parseCpuMax,
  parseCpuSet,
  parseCpuThrottledPeriods,
  parseIoStats,
  parseMemInfo,
  parseMemoryEvents,
  parseMemoryValue,
  parsePressure,
  parseProcStat,
  parseUid,
  parseUnifiedCgroupPath,
  sanitizeExecutable,
} from './host-snapshot-parsers.mjs';

export class HostSnapshotUnavailableError extends Error {
  constructor(inputId, reasonCode = 'unavailable') {
    super('host_snapshot_unavailable');
    this.name = 'HostSnapshotUnavailableError';
    this.code = 'host_snapshot_unavailable';
    this.inputId = inputId;
    this.reasonCode = reasonCode;
  }
}

function parseRequired(parser, contents, inputId, ...args) {
  try {
    return parser(contents, ...args);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new HostSnapshotUnavailableError(inputId, 'malformed');
  }
}

async function requiredText(readText, path, inputId) {
  try {
    return await readText(path);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const reasonCode = inputId.startsWith('process_') && error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'process_exited'
      : 'read_error';
    throw new HostSnapshotUnavailableError(inputId, reasonCode);
  }
}

async function systemAvailableBytes(path) {
  const stats = await statfs(path, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new HostSnapshotUnavailableError('scratch_free_bytes');
  return Number(bytes);
}

async function readAvailableBytes(readBytes, path) {
  let bytes;
  try {
    bytes = await readBytes(path);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new HostSnapshotUnavailableError('scratch_free_bytes');
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new HostSnapshotUnavailableError('scratch_free_bytes');
  }
  return bytes;
}

function resolveCgroupDirectory(sysRoot, cgroupPath) {
  const cgroupRoot = resolve(sysRoot, 'fs/cgroup');
  const directory = resolve(cgroupRoot, cgroupPath.slice(1));
  const relativePath = relative(cgroupRoot, directory);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new HostSnapshotUnavailableError('cgroup_path');
  }
  return directory;
}

async function processSample(procRoot, pid, readText) {
  const directory = join(procRoot, String(pid));
  try {
    const [statText, statusText, comm, cgroupText] = await Promise.all([
      requiredText(readText, join(directory, 'stat'), 'process_stat'),
      requiredText(readText, join(directory, 'status'), 'process_status'),
      requiredText(readText, join(directory, 'comm'), 'process_comm'),
      requiredText(readText, join(directory, 'cgroup'), 'process_cgroup'),
    ]);
    const stat = parseRequired(parseProcStat, statText, 'process_stat');
    return Object.freeze({ status: 'observed', sample: Object.freeze({
      pid,
      startTicks: stat.startTicks,
      ppid: stat.ppid,
      pgid: stat.pgid,
      sid: stat.sid,
      cpuTicks: stat.cpuTicks,
      uid: parseRequired(parseUid, statusText, 'process_uid'),
      executable: sanitizeExecutable(comm),
      cgroupClass: classifyCgroup(parseRequired(parseUnifiedCgroupPath, cgroupText, 'process_cgroup')),
    }) });
  } catch (error) {
    if (!(error instanceof HostSnapshotUnavailableError)) throw error;
    return Object.freeze({ status: error.reasonCode === 'process_exited' ? 'exited' : 'unavailable' });
  }
}

export async function collectHostSnapshot(options, services = {}) {
  const procRoot = resolve(options.procRoot);
  const sysRoot = resolve(options.sysRoot);
  const scratchPath = resolve(options.scratchPath);
  const selfPid = options.selfPid ?? services.selfPid ?? process.pid;
  if (![options.procRoot, options.sysRoot, options.scratchPath].every((path) => typeof path === 'string' && isAbsolute(path))) {
    throw new HostSnapshotUnavailableError('host_snapshot_paths');
  }

  const readText = services.readText ?? (async (path) => await readFile(path, 'utf8'));
  const readDirectory = services.readDirectory ?? (async (path) => await readdir(path));
  const availableBytes = services.availableBytes ?? systemAvailableBytes;
  const now = services.now ?? (() => ({ capturedAtUtc: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString() }));
  const clock = now();
  if (!Number.isFinite(Date.parse(clock.capturedAtUtc)) || !/^(0|[1-9][0-9]*)$/.test(clock.monotonicNs)) {
    throw new HostSnapshotUnavailableError('monotonic_clock');
  }

  const cgroupPath = parseRequired(parseUnifiedCgroupPath,
    await requiredText(readText, join(procRoot, String(selfPid), 'cgroup'), 'cgroup_v2_path'), 'cgroup_v2_path');
  const cgroupRoot = resolveCgroupDirectory(sysRoot, cgroupPath);
  const [procStat, selfStatus, meminfo, hostCpuPressure, hostMemoryPressure, hostIoPressure,
    cpuMax, cpuStat, cpuset, memoryCurrent, memoryMax, memoryHigh, memoryEvents,
    swapCurrent, cgroupCpuPressure, cgroupMemoryPressure, cgroupIoPressure, ioStat,
    processEntries, scratchFreeBytes] = await Promise.all([
    requiredText(readText, join(procRoot, 'stat'), 'host_cpu_stat'),
    requiredText(readText, join(procRoot, String(selfPid), 'status'), 'process_affinity'),
    requiredText(readText, join(procRoot, 'meminfo'), 'host_memory'),
    requiredText(readText, join(procRoot, 'pressure/cpu'), 'host_cpu_pressure'),
    requiredText(readText, join(procRoot, 'pressure/memory'), 'host_memory_pressure'),
    requiredText(readText, join(procRoot, 'pressure/io'), 'host_io_pressure'),
    requiredText(readText, join(cgroupRoot, 'cpu.max'), 'cgroup_cpu_quota'),
    requiredText(readText, join(cgroupRoot, 'cpu.stat'), 'cgroup_cpu_stat'),
    requiredText(readText, join(cgroupRoot, 'cpuset.cpus.effective'), 'cgroup_cpuset'),
    requiredText(readText, join(cgroupRoot, 'memory.current'), 'cgroup_memory_current'),
    requiredText(readText, join(cgroupRoot, 'memory.max'), 'cgroup_memory_max'),
    requiredText(readText, join(cgroupRoot, 'memory.high'), 'cgroup_memory_high'),
    requiredText(readText, join(cgroupRoot, 'memory.events'), 'cgroup_memory_events'),
    requiredText(readText, join(cgroupRoot, 'memory.swap.current'), 'cgroup_swap_current'),
    requiredText(readText, join(cgroupRoot, 'cpu.pressure'), 'cgroup_cpu_pressure'),
    requiredText(readText, join(cgroupRoot, 'memory.pressure'), 'cgroup_memory_pressure'),
    requiredText(readText, join(cgroupRoot, 'io.pressure'), 'cgroup_io_pressure'),
    requiredText(readText, join(cgroupRoot, 'io.stat'), 'cgroup_io_stat'),
    readDirectory(procRoot).catch(() => { throw new HostSnapshotUnavailableError('process_inventory'); }),
    readAvailableBytes(availableBytes, scratchPath),
  ]);

  const cpu = parseRequired(parseAggregateCpuStat, procStat, 'host_cpu_stat');
  const allowedCpus = selfStatus.split('\n').find((line) => line.startsWith('Cpus_allowed_list:'));
  if (allowedCpus === undefined) throw new HostSnapshotUnavailableError('process_affinity');
  const affinityCpuCount = parseRequired(parseCpuSet, allowedCpus.slice('Cpus_allowed_list:'.length).trim(), 'process_affinity');
  const swapTotalBytes = parseRequired(parseMemInfo, meminfo, 'host_swap_total', 'SwapTotal');
  const swapFreeBytes = parseRequired(parseMemInfo, meminfo, 'host_swap_free', 'SwapFree');
  if (swapFreeBytes > swapTotalBytes) throw new HostSnapshotUnavailableError('host_swap_values');

  const processIds = processEntries.filter((entry) => /^[1-9][0-9]*$/.test(entry)).map(Number).sort((left, right) => left - right);
  const processResults = await Promise.all(processIds.map((pid) => processSample(procRoot, pid, readText)));
  const processes = processResults.flatMap((result) => result.status === 'observed' ? [result.sample] : []);
  const cgroupIoBytes = parseRequired(parseIoStats, ioStat, 'cgroup_io_stat');
  return Object.freeze({
    capturedAtUtc: clock.capturedAtUtc,
    monotonicNs: clock.monotonicNs,
    selfPid,
    logicalCpuCount: cpu.logicalCpuCount,
    affinityCpuCount,
    cpusetCpuCount: parseRequired(parseCpuSet, cpuset, 'cgroup_cpuset'),
    quotaCpuCapacity: parseRequired(parseCpuMax, cpuMax, 'cgroup_cpu_quota'),
    aggregateCpuTicks: cpu.aggregateCpuTicks,
    throttledPeriods: parseRequired(parseCpuThrottledPeriods, cpuStat, 'cgroup_cpu_stat'),
    cpuPressure: Object.freeze({
      host: parseRequired(parsePressure, hostCpuPressure, 'host_cpu_pressure'),
      cgroup: parseRequired(parsePressure, cgroupCpuPressure, 'cgroup_cpu_pressure'),
    }),
    memoryPressure: Object.freeze({
      host: parseRequired(parsePressure, hostMemoryPressure, 'host_memory_pressure'),
      cgroup: parseRequired(parsePressure, cgroupMemoryPressure, 'cgroup_memory_pressure'),
    }),
    ioPressure: Object.freeze({
      host: parseRequired(parsePressure, hostIoPressure, 'host_io_pressure'),
      cgroup: parseRequired(parsePressure, cgroupIoPressure, 'cgroup_io_pressure'),
    }),
    memoryAvailableBytes: parseRequired(parseMemInfo, meminfo, 'host_memory_available', 'MemAvailable'),
    swapUsedBytes: swapTotalBytes - swapFreeBytes,
    cgroupMemoryCurrentBytes: parseRequired(parseMemoryValue, memoryCurrent, 'cgroup_memory_current'),
    cgroupMemoryMaxBytes: parseRequired(parseMemoryValue, memoryMax, 'cgroup_memory_max'),
    cgroupMemoryHighBytes: parseRequired(parseMemoryValue, memoryHigh, 'cgroup_memory_high'),
    memoryEvents: parseRequired(parseMemoryEvents, memoryEvents, 'cgroup_memory_events'),
    cgroupSwapCurrentBytes: parseRequired(parseMemoryValue, swapCurrent, 'cgroup_swap_current'),
    ioReadBytes: cgroupIoBytes.readBytes,
    ioWriteBytes: cgroupIoBytes.writeBytes,
    scratchFreeBytes,
    processEnumerationComplete: processResults.every((result) => result.status !== 'unavailable'),
    processes: Object.freeze(processes),
  });
}
