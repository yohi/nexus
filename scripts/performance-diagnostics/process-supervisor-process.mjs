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

function trackSessionIdentity(identity, leader, tracked, onIdentityObserved, state) {
  const previous = tracked.get(identity.pid);
  const outsideSession = identity.sid !== leader.sid || identity.pgid !== leader.pgid;
  if (outsideSession) {
    if (previous !== undefined || tracked.has(identity.ppid)) {
      state.incomplete = true;
      if (previous === undefined) onIdentityObserved?.(identity);
    }
    return;
  }
  if (previous !== undefined) {
    if (!sameProcess(previous, identity)) {
      state.incomplete = true;
      return;
    }
    tracked.set(identity.pid, identity);
    state.members.push(identity);
    return;
  }
  if (identity.pid === leader.pid || tracked.has(identity.ppid)) {
    tracked.set(identity.pid, identity);
    state.members.push(identity);
    onIdentityObserved?.(identity);
    return;
  }
  state.incomplete = true;
}

async function inspectSessionEntry(entry, procRoot, leader, tracked, onIdentityObserved, state) {
  if (!/^[1-9][0-9]*$/.test(entry)) return;
  const observed = await readProcessIdentity(Number(entry), procRoot);
  if (observed.status !== 'observed') {
    if (observed.reasonCode === 'permission_denied' || observed.reasonCode === 'malformed') state.incomplete = true;
    return;
  }
  trackSessionIdentity(observed.identity, leader, tracked, onIdentityObserved, state);
}

async function scanSession(procRoot, leader, tracked, onIdentityObserved) {
  let entries;
  try {
    entries = await readdir(procRoot);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { members: [], incomplete: true };
  }

  const state = { members: [], incomplete: false };
  for (const entry of entries) {
    await inspectSessionEntry(entry, procRoot, leader, tracked, onIdentityObserved, state);
  }
  return state;
}

function isSafeTrackedIdentity(expected, current, leader, tracked) {
  return current.status === 'observed' && sameProcess(expected, current.identity)
    && current.identity.sid === leader.sid && current.identity.pgid === leader.pgid
    && (expected.pid === leader.pid || current.identity.ppid === 1 || tracked.has(current.identity.ppid));
}

async function signalExpectedProcess(expected, signal, leader, tracked, procRoot, sendSignal) {
  const current = await readProcessIdentity(expected.pid, procRoot);
  if (current.status === 'not_collected' && current.reasonCode === 'not_found') return false;
  if (!isSafeTrackedIdentity(expected, current, leader, tracked)) return true;
  try {
    await sendSignal(expected, signal);
    return false;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return !('code' in error && error.code === 'ESRCH');
  }
}

async function signalTracked(signal, leader, tracked, procRoot, sendSignal) {
  let incomplete = false;
  for (const expected of tracked.values()) {
    incomplete ||= await signalExpectedProcess(expected, signal, leader, tracked, procRoot, sendSignal);
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

function supervisorInputIsInvalid(input) {
  return process.platform !== 'linux' || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
    || !Number.isSafeInteger(input.termGraceMs) || input.termGraceMs < 1
    || (input.startGateRequired === true && (typeof input.runId !== 'string' || input.runId.length === 0));
}

async function pidfdSignalIsAvailable(services) {
  if (services.sendSignal !== undefined) return true;
  const checkSupport = services.checkPidfdSignalSupport ?? checkPidfdSignalSupport;
  try {
    return await checkSupport();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function spawnSupervisedChild(input, spawnChild) {
  try {
    return {
      child: spawnChild(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.environment,
        detached: true,
        stdio: input.startGateRequired === true ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
        windowsHide: true,
      }),
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { failure: Object.freeze({ status: 'failed', exitCode: null, reasonCode: 'spawn_failed' }) };
  }
}

function observeChildExit(child) {
  let resolveExit;
  const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
  child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
  child.once('error', () => resolveExit({ exitCode: null, signal: null }));
  return exitPromise;
}

async function readInitialIdentity(child, procRoot, readIdentity, wait) {
  let firstIdentity;
  for (let attempt = 0; attempt < INITIAL_IDENTITY_ATTEMPTS; attempt += 1) {
    firstIdentity = await readIdentity(child.pid, procRoot);
    if (firstIdentity.status === 'observed') break;
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (attempt + 1 < INITIAL_IDENTITY_ATTEMPTS) await wait(INITIAL_IDENTITY_RETRY_MS);
  }
  return firstIdentity;
}

function isExpectedSessionLeader(identity, childPid) {
  return identity?.status === 'observed' && identity.identity.pgid === childPid && identity.identity.sid === childPid;
}

function createCpuEvidenceCollector(startGateRequired) {
  const samples = new Map();
  const record = (identity) => {
    const key = `${identity.pid}:${identity.startTicks}`;
    const previous = samples.get(key);
    if (previous === undefined) {
      samples.set(key, { identity, firstCpuTicks: identity.cpuTicks, lastCpuTicks: identity.cpuTicks, regressed: false });
      return;
    }
    if (identity.cpuTicks < previous.lastCpuTicks) {
      samples.set(key, { ...previous, regressed: true });
      return;
    }
    samples.set(key, { ...previous, identity, lastCpuTicks: identity.cpuTicks });
  };
  const addEvidence = (result) => {
    const processCpuSamples = Object.freeze([...samples.values()].map((sample) => Object.freeze({
      pid: sample.identity.pid,
      startTicks: sample.identity.startTicks,
      ppid: sample.identity.ppid,
      cpuTicksDelta: sample.regressed ? 0 : Math.max(0, sample.lastCpuTicks - sample.firstCpuTicks),
    })));
    return Object.freeze(startGateRequired && processCpuSamples.length > 0
      ? { ...result, processCpuSamples }
      : result);
  };
  return { record, addEvidence };
}

async function identityUnavailableResult(input, child, exitPromise, wait, addEvidence) {
  if (input.startGateRequired === true) {
    const exit = await waitForExit(exitPromise, wait, START_GATE_EXIT_GRACE_MS);
    if (exit !== null) return addEvidence({ status: 'failed', exitCode: exit.exitCode, reasonCode: 'child_identity_unavailable' });
  }
  return addEvidence({ status: 'cleanup_unverified', exitCode: null, reasonCode: 'child_identity_unavailable' });
}

async function completeSuccessfulChild(input, exit, leader, tracked, procRoot, scan, sendSignal, wait,
  observationIncomplete, addEvidence) {
  await wait(POLL_INTERVAL_MS);
  const finalScan = await scan(procRoot, leader, tracked);
  if (!observationIncomplete && !finalScan.incomplete && finalScan.members.length === 0) {
    return addEvidence({ status: 'completed', exitCode: 0 });
  }
  const cleanupFailed = await terminateTracked(leader, tracked, procRoot, { sendSignal, scanSession: scan }, input.termGraceMs, wait);
  return addEvidence({
    status: cleanupFailed || observationIncomplete || finalScan.incomplete ? 'cleanup_unverified' : 'failed',
    exitCode: exit.exitCode,
    reasonCode: 'session_members_remain',
  });
}

async function failChildAndCleanup(input, exit, leader, tracked, procRoot, scan, sendSignal, wait, timedOut,
  observationIncomplete, addEvidence) {
  const cleanupFailed = await terminateTracked(leader, tracked, procRoot, { sendSignal, scanSession: scan }, input.termGraceMs, wait);
  const reasonCode = timedOut ? 'timeout' : input.signal?.aborted === true ? 'interrupted' : 'child_failed';
  return addEvidence({
    status: cleanupFailed || observationIncomplete ? 'cleanup_unverified' : 'failed',
    exitCode: exit?.exitCode ?? null,
    reasonCode,
  });
}

async function runSupervisedChild(input, child, leader, exitPromise, runtime) {
  const { procRoot, scan, sendSignal, monotonicNow, wait, recordCpuSample, addEvidence } = runtime;
  recordCpuSample(leader);
  if (input.startGateRequired === true && !await sendSupervisorStart(child, input.runId, leader)) {
    const tracked = new Map([[leader.pid, leader]]);
    const cleanupFailed = await terminateTracked(leader, tracked, procRoot, { sendSignal, scanSession: scan }, input.termGraceMs, wait);
    return addEvidence({
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
  if (exit !== null && !timedOut && input.signal?.aborted !== true && exit.exitCode === 0) {
    return completeSuccessfulChild(input, exit, leader, tracked, procRoot, scan, sendSignal, wait,
      observationIncomplete, addEvidence);
  }
  return failChildAndCleanup(input, exit, leader, tracked, procRoot, scan, sendSignal, wait, timedOut,
    observationIncomplete, addEvidence);
}

export async function superviseDiagnosticProcess(input, services = {}) {
  if (supervisorInputIsInvalid(input)) {
    return Object.freeze({ status: 'failed', exitCode: null, reasonCode: 'supervisor_input_invalid' });
  }
  const procRoot = services.procRoot ?? '/proc';
  if (!await pidfdSignalIsAvailable(services)) {
    return Object.freeze({ status: 'failed', exitCode: null, reasonCode: 'pidfd_signal_unavailable' });
  }
  const scan = services.scanSession ?? ((root, leader, tracked) =>
    scanSession(root, leader, tracked, services.onIdentityObserved));
  const sendSignal = services.sendSignal ?? sendProcessSignalWithPidfd;
  const monotonicNow = services.monotonicNow ?? (() => process.hrtime.bigint());
  const wait = services.wait ?? delay;
  const spawnChild = services.spawn ?? spawn;
  const spawned = spawnSupervisedChild(input, spawnChild);
  if (spawned.failure !== undefined) return spawned.failure;
  const child = spawned.child;
  if (child.pid === undefined || child.pid < 1) {
    return Object.freeze({ status: 'cleanup_unverified', exitCode: null, reasonCode: 'child_pid_unavailable' });
  }
  const exitPromise = observeChildExit(child);
  const readIdentity = services.readProcessIdentity ?? readProcessIdentity;
  const cpuEvidence = createCpuEvidenceCollector(input.startGateRequired === true);
  const firstIdentity = await readInitialIdentity(child, procRoot, readIdentity, wait);
  if (!isExpectedSessionLeader(firstIdentity, child.pid)) {
    return identityUnavailableResult(input, child, exitPromise, wait, cpuEvidence.addEvidence);
  }
  return runSupervisedChild(input, child, firstIdentity.identity, exitPromise, {
    procRoot,
    scan,
    sendSignal,
    monotonicNow,
    wait,
    recordCpuSample: cpuEvidence.record,
    addEvidence: cpuEvidence.addEvidence,
  });
}
