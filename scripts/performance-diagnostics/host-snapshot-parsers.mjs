function invalid(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function nonnegativeInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid(code);
  return parsed;
}

export function parseProcStat(contents) {
  const close = contents.lastIndexOf(') ');
  if (close < 0) invalid('proc_stat_invalid');
  const fields = contents.slice(close + 2).trim().split(/\s+/);
  if (fields.length < 20) invalid('proc_stat_invalid');
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[1-9][0-9]*$/.test(startTicks)) invalid('proc_stat_invalid');
  return Object.freeze({
    state: fields[0] ?? '',
    ppid: nonnegativeInteger(fields[1], 'proc_stat_invalid'),
    pgid: nonnegativeInteger(fields[2], 'proc_stat_invalid'),
    sid: nonnegativeInteger(fields[3], 'proc_stat_invalid'),
    cpuTicks: nonnegativeInteger(fields[11], 'proc_stat_invalid')
      + nonnegativeInteger(fields[12], 'proc_stat_invalid'),
    startTicks,
  });
}

export function parseAggregateCpuStat(contents) {
  const rows = contents.split('\n').filter((line) => line.length > 0);
  const aggregate = rows.find((line) => /^cpu\s/.test(line));
  if (aggregate === undefined) invalid('proc_cpu_stat_missing');
  const values = aggregate.trim().split(/\s+/).slice(1, 9)
    .map((value) => nonnegativeInteger(value, 'proc_cpu_stat_invalid'));
  if (values.length !== 8) invalid('proc_cpu_stat_invalid');
  const logicalCpuCount = rows.filter((line) => /^cpu[0-9]+\s/.test(line)).length;
  const aggregateCpuTicks = values.reduce((total, value) => total + value, 0);
  if (logicalCpuCount < 1 || !Number.isSafeInteger(aggregateCpuTicks)) invalid('proc_cpu_stat_invalid');
  return Object.freeze({ logicalCpuCount, aggregateCpuTicks });
}

export function parseCpuSet(contents) {
  const cpus = new Set();
  for (const range of contents.trim().split(',')) {
    const match = /^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/.exec(range);
    if (match === null) invalid('cpu_set_invalid');
    const first = nonnegativeInteger(match[1], 'cpu_set_invalid');
    const last = nonnegativeInteger(match[2] ?? match[1], 'cpu_set_invalid');
    if (last < first || last - first > 4_096) invalid('cpu_set_invalid');
    for (let cpu = first; cpu <= last; cpu += 1) cpus.add(cpu);
  }
  if (cpus.size === 0) invalid('cpu_set_empty');
  return cpus.size;
}

export function parseCpuMax(contents) {
  const [quota, period, ...extra] = contents.trim().split(/\s+/);
  if (quota === undefined || period === undefined || extra.length > 0) invalid('cpu_max_invalid');
  const periodValue = nonnegativeInteger(period, 'cpu_max_invalid');
  if (periodValue === 0) invalid('cpu_max_invalid');
  if (quota === 'max') return null;
  const quotaValue = nonnegativeInteger(quota, 'cpu_max_invalid');
  if (quotaValue === 0) invalid('cpu_max_invalid');
  const capacity = quotaValue / periodValue;
  if (!Number.isFinite(capacity) || capacity <= 0) invalid('cpu_max_invalid');
  return capacity;
}

export function parseCpuThrottledPeriods(contents) {
  const row = contents.split('\n').find((line) => line.startsWith('nr_throttled '));
  if (row === undefined) invalid('cpu_stat_throttle_missing');
  return nonnegativeInteger(row.slice('nr_throttled '.length), 'cpu_stat_invalid');
}

export function parseMemoryValue(contents, code) {
  const value = contents.trim();
  if (value === 'max') return null;
  return nonnegativeInteger(value, code);
}

export function parseMemInfo(contents, key) {
  const row = contents.split('\n').find((line) => line.startsWith(`${key}:`));
  if (row === undefined) invalid('meminfo_field_missing');
  const match = /^([^:]+):\s+([0-9]+)\s+kB$/.exec(row);
  if (match === null) invalid('meminfo_field_invalid');
  const bytes = nonnegativeInteger(match[2], 'meminfo_field_invalid') * 1_024;
  if (!Number.isSafeInteger(bytes)) invalid('meminfo_field_invalid');
  return bytes;
}

export function parseMemoryEvents(contents) {
  const fields = new Map();
  for (const line of contents.split('\n').filter(Boolean)) {
    const [key, value, ...extra] = line.trim().split(/\s+/);
    if (key === undefined || value === undefined || extra.length > 0 || fields.has(key)) invalid('memory_events_invalid');
    fields.set(key, nonnegativeInteger(value, 'memory_events_invalid'));
  }
  const high = fields.get('high');
  const max = fields.get('max');
  const oom = fields.get('oom');
  const oomKill = fields.get('oom_kill');
  if (high === undefined || max === undefined || oom === undefined || oomKill === undefined) invalid('memory_events_missing');
  return Object.freeze({ high, max, oom, oomKill });
}

export function parsePressure(contents) {
  const result = {};
  for (const line of contents.split('\n').filter(Boolean)) {
    const [kind, ...pairs] = line.trim().split(/\s+/);
    if (kind !== 'some' && kind !== 'full') continue;
    const value = pairs.find((pair) => pair.startsWith('avg60='))?.slice('avg60='.length);
    if (value === undefined || result[kind] !== undefined) invalid('pressure_avg60_invalid');
    const average = Number(value);
    if (!Number.isFinite(average) || average < 0) invalid('pressure_avg60_invalid');
    result[kind] = average;
  }
  if (result.some === undefined || result.full === undefined) invalid('pressure_scope_missing');
  return Object.freeze({ someAvg60: result.some, fullAvg60: result.full });
}

export function parseIoStats(contents) {
  let readBytes = 0;
  let writeBytes = 0;
  let readSeen = false;
  let writeSeen = false;
  for (const row of contents.split('\n').filter(Boolean)) {
    for (const field of row.trim().split(/\s+/).slice(1)) {
      const match = /^(rbytes|wbytes)=([0-9]+)$/.exec(field);
      if (match === null) continue;
      const value = nonnegativeInteger(match[2], 'io_stat_invalid');
      if (match[1] === 'rbytes') {
        readBytes += value;
        readSeen = true;
      } else {
        writeBytes += value;
        writeSeen = true;
      }
    }
  }
  if (!readSeen || !writeSeen || !Number.isSafeInteger(readBytes) || !Number.isSafeInteger(writeBytes)) invalid('io_stat_missing');
  return Object.freeze({ readBytes, writeBytes });
}

export function parseUnifiedCgroupPath(contents) {
  const row = contents.split('\n').find((line) => line.startsWith('0::'));
  if (row === undefined) invalid('cgroup_v2_path_missing');
  const cgroupPath = row.slice(3);
  if (!cgroupPath.startsWith('/') || cgroupPath.split('/').includes('..')) invalid('cgroup_v2_path_invalid');
  return cgroupPath;
}

export function classifyCgroup(cgroupPath) {
  if (cgroupPath === '/') return 'root';
  if (cgroupPath.split('/').includes('user.slice')) return 'user_session';
  if (cgroupPath.split('/').includes('system.slice')) return 'service';
  return 'unknown';
}

export function parseUid(contents) {
  const row = contents.split('\n').find((line) => line.startsWith('Uid:'));
  if (row === undefined) invalid('process_uid_missing');
  const uid = row.trim().split(/\s+/)[1];
  return nonnegativeInteger(uid, 'process_uid_invalid');
}

export function sanitizeExecutable(contents) {
  const executable = contents.trim().slice(0, 256);
  return executable.length === 0 || /[^\x20-\x7e]/.test(executable) ? 'unknown' : executable;
}
