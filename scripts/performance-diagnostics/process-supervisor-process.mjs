import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { readProcessIdentity } from './process-identity.mjs';
import { checkPidfdSignalSupport, sendProcessSignalWithPidfd } from './process-pidfd-signal.mjs';

const POLL_INTERVAL_MS = 1_000;
const INITIAL_IDENTITY_ATTEMPTS = 10;
const INITIAL_IDENTITY_RETRY_MS = 10;
const START_GATE_EXIT_GRACE_MS = 2_500;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameProcess(left, right) {
  return left.pid === right.pid && left.startTicks === right.startTicks
    && left.pgid === right.pgid && left.sid === right.sid;
}

async function scanSession(procRoot, leader, tracked, onIdentityObserved) {
  let entries;
  try {
    entries = await readdir(procRoot);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { members: [], incomplete: true };
  }

  const members = [];
  let incomplete = false;
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const pid = Number(entry);
    const observed = await readProcessIdentity(pid, procRoot);
    if (observed.status !== 'observed') {
      if (observed.reasonCode === 'permission_denied' || observed.reasonCode === 'malformed') incomplete = true;
      continue;
    }
    const identity = observed.identity;
    const previous = tracked.get(identity.pid);
    if (identity.sid !== leader.sid || identity.pgid !== leader.pgid) {
      if (previous !== undefined || tracked.has(identity.ppid)) {
        incomplete = true;
        if (previous === undefined) onIdentityObserved?.(identity);
      }
      continue;
    }
      if (previous !== undefined) {
        if (!sameProcess(previous, identity)) {
          incomplete = true;
          continue;
        }
        tracked.set(identity.pid, identity);
        members.push(identity);
        continue;
    }
    if (identity.pid === leader.pid || tracked.has(identity.ppid)) {
      tracked.set(identity.pid, identity);
      members.push(identity);
      onIdentityObserved?.(identity);
      continue;
    }
    incomplete = true;
  }
  return { members, incomplete };
}

async function signalTracked(signal, leader, tracked, procRoot, sendSignal) {
  let incomplete = false;
  for (const expected of tracked.values()) {
    const current = await readProcessIdentity(expected.pid, procRoot);
    if (current.status === 'not_collected' && current.reasonCode === 'not_found') continue;
    if (current.status !== 'observed' || !sameProcess(expected, current.identity)
      || current.identity.sid !== leader.sid || current.identity.pgid !== leader.pgid
      || (expected.pid !== leader.pid && current.identity.ppid !== 1 && !tracked.has(current.identity.ppid))) {
      incomplete = true;
      continue;
    }
    try {
      await sendSignal(expected, signal);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if ('code' in error && error.code === 'ESRCH') continue;
      incomplete = true;
    }
  }
  return incomplete;
}

async function terminateTracked(leader, tracked, procRoot, services, termGraceMs, wait) {
  const scan = services.scanSession ?? ((root, leader, tracked) =>
    scanSession(root, leader, tracked, services.onIdentityObserved));
  let incomplete = await signalTracked('SIGTERM', leader, tracked, procRoot, services.sendSignal);
  await wait(termGraceMs);
  const afterTerm = await scan(procRoot, leader, tracked);
  incomplete ||= afterTerm.incomplete;
  if (afterTerm.members.length > 0) {
    incomplete ||= await signalTracked('SIGKILL', leader, tracked, procRoot, services.sendSignal);
    await wait(termGraceMs);
  }
  const afterKill = await scan(procRoot, leader, tracked);
  return afterKill.incomplete || incomplete || afterKill.members.length > 0;
}

async function sendSupervisorStart(child, runId, identity) {
  if (typeof child.send !== 'function' || child.connected !== true) return false;
  try {
    return await new Promise((resolveResult) => {
      child.send({ type: 'supervisor_start', runId, ...identity }, (error) => resolveResult(error === null));
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

async function waitForExit(exitPromise, wait, timeoutMs) {
  return await Promise.race([exitPromise, wait(timeoutMs).then(() => null)]);
}

export async function superviseDiagnosticProcess(input, services = {}) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
    || !Number.isSafeInteger(input.termGraceMs) || input.termGraceMs < 1
    || (input.startGateRequired === true && (typeof input.runId !== 'string' || input.runId.length === 0))) {
    return Object.freeze({ status: 'failed', exitCode: null, reasonCode: 'supervisor_input_invalid' });
  }
  const procRoot = services.procRoot ?? '/proc';
  const checkSignalSupport = services.checkPidfdSignalSupport ?? checkPidfdSignalSupport;
  let pidfdAvailable = services.sendSignal !== undefined;
  if (!pidfdAvailable) {
    try {
      pidfdAvailable = await checkSignalSupport();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  if (!pidfdAvailable) {
    return Object.freeze({ status: 'failed', exitCode: null, reasonCode: 'pidfd_signal_unavailable' });
  }
  const scan = services.scanSession ?? ((root, leader, tracked) =>
    scanSession(root, leader, tracked, services.onIdentityObserved));
  const sendSignal = services.sendSignal ?? sendProcessSignalWithPidfd;
  const monotonicNow = services.monotonicNow ?? (() => process.hrtime.bigint());
  const wait = services.wait ?? delay;
  const spawnChild = services.spawn ?? spawn;
  let child;
  try {
    child = spawnChild(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.environment,
      detached: true,
      stdio: input.startGateRequired === true ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return Object.freeze({ status: 'failed', exitCode: null, reasonCode: 'spawn_failed' });
  }
  if (child.pid === undefined || child.pid < 1) {
    return Object.freeze({ status: 'cleanup_unverified', exitCode: null, reasonCode: 'child_pid_unavailable' });
  }
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
  child.once('error', () => resolveExit({ exitCode: null, signal: null }));
  const readIdentity = services.readProcessIdentity ?? readProcessIdentity;
  const cpuSamples = new Map();
  function recordCpuSample(identity) {
    const key = `${identity.pid}:${identity.startTicks}`;
    const previous = cpuSamples.get(key);
    if (previous === undefined) {
      cpuSamples.set(key, { identity, firstCpuTicks: identity.cpuTicks, lastCpuTicks: identity.cpuTicks, regressed: false });
      return;
    }
    if (identity.cpuTicks < previous.lastCpuTicks) {
      cpuSamples.set(key, { ...previous, regressed: true });
      return;
    }
    cpuSamples.set(key, { ...previous, identity, lastCpuTicks: identity.cpuTicks });
  }
  function processCpuEvidence() {
    return Object.freeze([...cpuSamples.values()].map((sample) => Object.freeze({
      pid: sample.identity.pid,
      startTicks: sample.identity.startTicks,
      ppid: sample.identity.ppid,
      cpuTicksDelta: sample.regressed ? 0 : Math.max(0, sample.lastCpuTicks - sample.firstCpuTicks),
    })));
  }
  function resultWithCpuEvidence(result) {
    const samples = processCpuEvidence();
    return Object.freeze(input.startGateRequired === true && samples.length > 0
      ? { ...result, processCpuSamples: samples }
      : result);
  }
  let firstIdentity;
  for (let attempt = 0; attempt < INITIAL_IDENTITY_ATTEMPTS; attempt += 1) {
    firstIdentity = await readIdentity(child.pid, procRoot);
    if (firstIdentity.status === 'observed') break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (attempt + 1 < INITIAL_IDENTITY_ATTEMPTS) await wait(INITIAL_IDENTITY_RETRY_MS);
  }
  if (firstIdentity?.status !== 'observed' || firstIdentity.identity.pgid !== child.pid || firstIdentity.identity.sid !== child.pid) {
    if (input.startGateRequired === true) {
      const exit = await waitForExit(exitPromise, wait, START_GATE_EXIT_GRACE_MS);
      if (exit !== null) return resultWithCpuEvidence({ status: 'failed', exitCode: exit.exitCode, reasonCode: 'child_identity_unavailable' });
    }
    return resultWithCpuEvidence({ status: 'cleanup_unverified', exitCode: null, reasonCode: 'child_identity_unavailable' });
  }
  const leader = firstIdentity.identity;
  recordCpuSample(leader);
  if (input.startGateRequired === true && !await sendSupervisorStart(child, input.runId, leader)) {
    const tracked = new Map([[leader.pid, leader]]);
    const cleanupFailed = await terminateTracked(leader, tracked, procRoot, { sendSignal, scanSession: scan }, input.termGraceMs, wait);
    return resultWithCpuEvidence({
      status: cleanupFailed ? 'cleanup_unverified' : 'failed',
      exitCode: null,
      reasonCode: 'supervisor_start_gate_failed',
    });
  }
  const tracked = new Map([[leader.pid, leader]]);
  const deadline = monotonicNow() + BigInt(input.timeoutMs) * 1_000_000n;
  let exit = null;
  let observationIncomplete = false;

  while (exit === null && monotonicNow() < deadline) {
    const sample = await scan(procRoot, leader, tracked);
    observationIncomplete ||= sample.incomplete;
    for (const identity of sample.members) recordCpuSample(identity);
    const remainingNs = deadline - monotonicNow();
    const remainingMs = Math.max(1, Number((remainingNs + 999_999n) / 1_000_000n));
    exit = await Promise.race([
      exitPromise,
      wait(Math.min(POLL_INTERVAL_MS, remainingMs)).then(() => null),
    ]);
    if (input.signal?.aborted === true) break;
  }
  const timedOut = exit === null && input.signal?.aborted !== true;
  const needsCleanup = timedOut || input.signal?.aborted === true || exit?.exitCode !== 0;

  if (exit !== null && !needsCleanup) {
    await wait(POLL_INTERVAL_MS);
    const finalScan = await scan(procRoot, leader, tracked);
    if (observationIncomplete || finalScan.incomplete || finalScan.members.length > 0) {
      const cleanupFailed = await terminateTracked(leader, tracked, procRoot, { sendSignal, scanSession: scan }, input.termGraceMs, wait);
      return resultWithCpuEvidence({
        status: cleanupFailed || observationIncomplete || finalScan.incomplete ? 'cleanup_unverified' : 'failed',
        exitCode: exit.exitCode,
        reasonCode: 'session_members_remain',
      });
    }
    return resultWithCpuEvidence({ status: 'completed', exitCode: 0 });
  }

  const cleanupFailed = await terminateTracked(leader, tracked, procRoot, { sendSignal, scanSession: scan }, input.termGraceMs, wait);
  const reasonCode = timedOut ? 'timeout' : input.signal?.aborted === true ? 'interrupted' : 'child_failed';
  return resultWithCpuEvidence({
    status: cleanupFailed || observationIncomplete ? 'cleanup_unverified' : 'failed',
    exitCode: exit?.exitCode ?? null,
    reasonCode,
  });
}
