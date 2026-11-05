import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type SupervisedProcessResult = Readonly<{
  status: 'completed' | 'failed' | 'cleanup_unverified';
  exitCode: number | null;
  reasonCode?: string;
  processCpuSamples?: readonly Readonly<{ pid: number; startTicks: string; ppid: number; cpuTicksDelta: number }>[];
}>;
type ProcessIdentity = Readonly<{ pid: number; startTicks: string; ppid: number; pgid: number; sid: number; cpuTicks: number }>;
type ProcessSupervisorProcessModule = Readonly<{
  superviseDiagnosticProcess: (input: Readonly<{
    command: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    timeoutMs: number;
    termGraceMs: number;
    startGateRequired?: boolean;
    runId?: string;
  }>, services?: Readonly<{
    checkPidfdSignalSupport?: () => Promise<boolean>;
    sendSignal?: (identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL') => void;
    spawn?: (...args: readonly unknown[]) => never;
    scanSession?: (
      procRoot: string,
      leader: ProcessIdentity,
      tracked: Map<number, ProcessIdentity>,
    ) => Promise<Readonly<{
      members: readonly ProcessIdentity[];
      incomplete: boolean;
    }>>;
    onIdentityObserved?: (identity: ProcessIdentity) => void;
    monotonicNow?: () => bigint;
    wait?: (milliseconds: number) => Promise<void>;
    readProcessIdentity?: () => Promise<Readonly<{ status: 'not_collected'; reasonCode: 'not_found' | 'permission_denied' | 'malformed' }>>;
  }>) => Promise<SupervisedProcessResult>;
}>;

function isSupervisorProcessModule(value: unknown): value is ProcessSupervisorProcessModule {
  return typeof value === 'object' && value !== null
    && 'superviseDiagnosticProcess' in value && typeof value.superviseDiagnosticProcess === 'function';
}

async function loadSupervisorProcessModule(): Promise<ProcessSupervisorProcessModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/process-supervisor-process.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isSupervisorProcessModule(loaded)).toBe(true);
  if (!isSupervisorProcessModule(loaded)) throw new Error('process_supervisor_process_module_missing');
  return loaded;
}

const fixture = resolve(process.cwd(), 'tests/fixtures/performance/supervisor-child.mjs');

async function runObservedChildScenario(supervisor: ProcessSupervisorProcessModule, scenario: string, prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const pidFile = join(directory, 'child-pid');
  const acknowledgementFile = join(directory, 'child-observed');
  const signals: Array<Readonly<{ pid: number; signal: string }>> = [];
  try {
    const result = await supervisor.superviseDiagnosticProcess({
      command: process.execPath,
      args: [fixture, scenario],
      cwd: process.cwd(),
      environment: {
        ...process.env,
        SUPERVISOR_TEST_PID_FILE: pidFile,
        SUPERVISOR_TEST_ACK_FILE: acknowledgementFile,
      },
      timeoutMs: 2_000,
      termGraceMs: 50,
    }, {
      sendSignal: (identity, signal) => {
        signals.push({ pid: identity.pid, signal });
        process.kill(identity.pid, signal);
      },
      onIdentityObserved: () => { writeFileSync(acknowledgementFile, 'observed\n', { flag: 'wx', mode: 0o600 }); },
    });
    return { result, signals, childPid: Number(await readFile(pidFile, 'utf8')) };
  } finally {
    if (scenario === 'spawn-detached-child') await terminateEscapedFixture(pidFile);
    await rm(directory, { recursive: true, force: true });
  }
}

it('does_not_spawn_a_child_when_atomic_pidfd_signal_support_is_unavailable', async () => {
  const supervisor = await loadSupervisorProcessModule();
  let spawnCount = 0;

  await expect(supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'exit'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 2_000,
    termGraceMs: 50,
  }, {
    checkPidfdSignalSupport: () => Promise.resolve(false),
    spawn: () => {
      spawnCount += 1;
      throw new Error('worker_spawned_without_pidfd_support');
    },
  })).resolves.toMatchObject({ status: 'failed', reasonCode: 'pidfd_signal_unavailable' });

  expect(spawnCount).toBe(0);
});

async function terminateEscapedFixture(pidFile: string): Promise<void> {
  const pidContents = await readFile(pidFile, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (pidContents === undefined) return;
  try {
    process.kill(Number(pidContents), 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}

it('returns_completed_after_a_harmless_detached_child_exits', async () => {
  const supervisor = await loadSupervisorProcessModule();

  await expect(supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'exit'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 2_000,
    termGraceMs: 50,
  })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
});

it('releases_a_gated_child_only_after_observing_its_session_identity', async () => {
  const supervisor = await loadSupervisorProcessModule();
  const script = [
    "process.once('message', (message) => {",
    "  const valid = message?.type === 'supervisor_start' && message.pid === process.pid",
    "    && typeof message.startTicks === 'string' && message.pgid === process.pid && message.sid === process.pid;",
    "  process.exit(valid ? 0 : 3);",
    '});',
    'setTimeout(() => process.exit(2), 3_000);',
  ].join('\n');

  await expect(supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 2_000,
    termGraceMs: 50,
    startGateRequired: true,
    runId: '00000000-0000-4000-8000-000000000001',
  })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
});

it('does_not_release_a_worker_when_initial_process_identity_cannot_be_verified', async () => {
  const supervisor = await loadSupervisorProcessModule();
  const directory = await mkdtemp(join(tmpdir(), 'nexus-supervisor-start-gate-'));
  const startedFile = join(directory, 'worker-started');
  const script = [
    "const { writeFileSync } = require('node:fs');",
    "process.once('message', () => { writeFileSync(process.env.SUPERVISOR_TEST_STARTED_FILE, 'started'); process.exit(0); });",
    'setTimeout(() => process.exit(0), 1_000);',
  ].join('\n');

  try {
    const result = await supervisor.superviseDiagnosticProcess({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      environment: { ...process.env, SUPERVISOR_TEST_STARTED_FILE: startedFile },
      timeoutMs: 2_000,
      termGraceMs: 50,
      startGateRequired: true,
      runId: '00000000-0000-4000-8000-000000000001',
    }, {
      readProcessIdentity: () => Promise.resolve({ status: 'not_collected', reasonCode: 'permission_denied' }),
    });

    expect(result).toMatchObject({ status: 'failed', reasonCode: 'child_identity_unavailable' });
    await expect(readFile(startedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('terminates_a_timed_out_harmless_child_and_verifies_cleanup', async () => {
  const supervisor = await loadSupervisorProcessModule();

  await expect(supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'ignore-term'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 250,
    termGraceMs: 50,
  })).resolves.toEqual({ status: 'failed', exitCode: null, reasonCode: 'timeout' });
});

it('uses_an_injected_monotonic_deadline_for_supervised_worker_timeout', async () => {
  const supervisor = await loadSupervisorProcessModule();
  let monotonicNs = 0n;
  let monotonicReads = 0;

  const result = await supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'ignore-term'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 50,
    termGraceMs: 10,
  }, {
    monotonicNow: () => { monotonicReads += 1; return monotonicNs; },
    wait: async (milliseconds) => {
      monotonicNs += BigInt(milliseconds) * 1_000_000n;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  });

  expect(result).toMatchObject({ status: 'failed', reasonCode: 'timeout' });
  expect(monotonicReads).toBeGreaterThan(1);
});

it('bounds_full_session_scans_during_a_supervised_timeout', async () => {
  const supervisor = await loadSupervisorProcessModule();
  let monotonicNs = 0n;
  let scans = 0;
  let killed = false;

  const result = await supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'ignore-term'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 750,
    termGraceMs: 50,
  }, {
    monotonicNow: () => monotonicNs,
    wait: async (milliseconds) => {
      monotonicNs += BigInt(milliseconds) * 1_000_000n;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
    scanSession: (_procRoot, _leader, tracked) => {
      scans += 1;
      return Promise.resolve({ members: killed ? [] : [...tracked.values()], incomplete: false });
    },
    sendSignal: (identity, signal) => {
      if (signal === 'SIGKILL') killed = true;
      process.kill(identity.pid, signal);
    },
  });

  expect(result.reasonCode).toBe('timeout');
  expect(scans).toBeLessThanOrEqual(6);
});

it('returns_supervisor_observed_cpu_tick_deltas_for_owned_process_identities', async () => {
  const supervisor = await loadSupervisorProcessModule();
  let sampleCount = 0;
  let stopped = false;
  const script = "process.once('message', () => setInterval(() => {}, 1000));";

  const result = await supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 500,
    termGraceMs: 10,
    startGateRequired: true,
    runId: '00000000-0000-4000-8000-000000000001',
  }, {
    scanSession: (_procRoot, leader) => {
      if (stopped) return Promise.resolve({ members: [], incomplete: false });
      sampleCount += 1;
      return Promise.resolve({
        members: [{ ...leader, cpuTicks: leader.cpuTicks + sampleCount * 10 }],
        incomplete: false,
      });
    },
    sendSignal: (identity, signal) => {
      if (signal === 'SIGTERM') stopped = true;
      process.kill(identity.pid, signal);
    },
  });

  expect(result).toMatchObject({ status: 'failed', reasonCode: 'timeout' });
  const processCpuSamples = result.processCpuSamples ?? [];
  expect(processCpuSamples.length).toBeGreaterThan(0);
  expect(processCpuSamples.some((sample) => sample.pid > 0
    && /^[1-9][0-9]*$/.test(sample.startTicks) && sample.cpuTicksDelta > 0)).toBe(true);
});

it('terminates_a_previously_observed_descendant_individually', async () => {
  const supervisor = await loadSupervisorProcessModule();

  await expect(supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'spawn-ignore-term'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 500,
    termGraceMs: 50,
  })).resolves.toEqual({ status: 'failed', exitCode: null, reasonCode: 'timeout' });
});

it('cleans_up_a_previously_observed_child_after_its_parent_exits', async () => {
  const supervisor = await loadSupervisorProcessModule();
  const { result, signals, childPid } = await runObservedChildScenario(
    supervisor, 'exit-with-child', 'nexus-supervisor-parent-exit-',
  );

  expect(result).toEqual({ status: 'failed', exitCode: 0, reasonCode: 'session_members_remain' });
  expect(signals).toEqual([
    { pid: childPid, signal: 'SIGTERM' },
    { pid: childPid, signal: 'SIGKILL' },
  ]);
});

it('preserves_cleanup_unverified_and_never_signals_an_unobserved_session_member', async () => {
  const supervisor = await loadSupervisorProcessModule();
  const signals: Array<Readonly<{ pid: number; signal: string }>> = [];

  const result = await supervisor.superviseDiagnosticProcess({
    command: process.execPath,
    args: [fixture, 'exit'],
    cwd: process.cwd(),
    environment: process.env,
    timeoutMs: 2_000,
    termGraceMs: 50,
  }, {
    sendSignal: (identity, signal) => { signals.push({ pid: identity.pid, signal }); },
    scanSession: (_procRoot, _leader, tracked) => {
      const leader = [...tracked.values()][0];
      return Promise.resolve({
        members: leader === undefined ? [] : [
        { pid: leader.pid + 1, startTicks: '9999', ppid: leader.pid + 10, pgid: leader.pgid, sid: leader.sid, cpuTicks: 1 },
        ],
        incomplete: true,
      });
    },
  });

  expect(result).toMatchObject({ status: 'cleanup_unverified', reasonCode: 'session_members_remain' });
  expect(signals).toEqual([]);
});

it('cleans_up_a_previously_observed_descendant_after_parent_failure', async () => {
  const supervisor = await loadSupervisorProcessModule();
  const { result, signals, childPid } = await runObservedChildScenario(
    supervisor, 'crash-with-child', 'nexus-supervisor-parent-crash-',
  );

  expect(result).toEqual({ status: 'failed', exitCode: 1, reasonCode: 'child_failed' });
  expect(signals).toEqual([
    { pid: childPid, signal: 'SIGTERM' },
    { pid: childPid, signal: 'SIGKILL' },
  ]);
});

it('preserves_cleanup_unverified_without_signaling_a_descendant_that_leaves_the_session', async () => {
  const supervisor = await loadSupervisorProcessModule();
  const { result, signals, childPid } = await runObservedChildScenario(
    supervisor, 'spawn-detached-child', 'nexus-supervisor-session-escape-',
  );

  expect(result).toMatchObject({ status: 'cleanup_unverified', reasonCode: 'session_members_remain' });
  expect(signals.some((signal) => signal.pid === childPid)).toBe(false);
});
