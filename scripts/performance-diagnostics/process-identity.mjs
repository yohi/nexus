import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProcStat } from './host-snapshot-parsers.mjs';

export function parseProcessIdentity(pid, statText) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('process_identity_pid_invalid');
  const match = /^([1-9][0-9]*) \(/.exec(statText);
  if (match === null || Number(match[1]) !== pid) throw new Error('process_identity_pid_mismatch');
  const stat = parseProcStat(statText);
  return Object.freeze({
    pid,
    startTicks: stat.startTicks,
    ppid: stat.ppid,
    pgid: stat.pgid,
    sid: stat.sid,
    cpuTicks: stat.cpuTicks,
  });
}

function notCollectedReason(error) {
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return 'not_found';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission_denied';
  }
  return 'malformed';
}

export async function readProcessIdentity(pid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1) return Object.freeze({ status: 'not_collected', reasonCode: 'malformed' });
  try {
    const statText = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
    return Object.freeze({ status: 'observed', identity: parseProcessIdentity(pid, statText) });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return Object.freeze({ status: 'not_collected', reasonCode: notCollectedReason(error) });
  }
}

function sameIdentity(left, right) {
  return left.pid === right.pid && left.startTicks === right.startTicks
    && left.ppid === right.ppid && left.pgid === right.pgid && left.sid === right.sid;
}

export async function signalVerifiedProcess(expectedIdentity, signal, dependencies = {}) {
  const observe = dependencies.readIdentity ?? (async (pid) => await readProcessIdentity(pid));
  const sendSignal = dependencies.signal ?? ((pid, requestedSignal) => process.kill(pid, requestedSignal));
  const observed = await observe(expectedIdentity.pid);
  if (observed.status !== 'observed') return observed.reasonCode === 'not_found' ? 'not_found' : 'signal_failed';
  if (!sameIdentity(expectedIdentity, observed.identity)) return 'identity_mismatch';
  try {
    sendSignal(expectedIdentity.pid, signal);
    return 'signaled';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return 'signal_failed';
  }
}
