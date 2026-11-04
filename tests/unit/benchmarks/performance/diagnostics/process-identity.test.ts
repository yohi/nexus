import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

type ProcessIdentity = Readonly<{ pid: number; startTicks: string; ppid: number; pgid: number; sid: number; cpuTicks: number }>;
type ProcessIdentityReadResult =
  | Readonly<{ status: 'observed'; identity: ProcessIdentity }>
  | Readonly<{ status: 'not_collected'; reasonCode: 'not_found' | 'permission_denied' | 'malformed' }>;
type ProcessIdentityModule = Readonly<{
  parseProcessIdentity: (pid: number, statText: string) => ProcessIdentity;
  readProcessIdentity: (pid: number, procRoot: string) => Promise<ProcessIdentityReadResult>;
  signalVerifiedProcess: (
    expectedIdentity: ProcessIdentity,
    signal: 'SIGTERM' | 'SIGKILL',
    dependencies?: Readonly<{
      readIdentity: (pid: number) => Promise<ProcessIdentityReadResult>;
      signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
    }>,
  ) => Promise<'signaled' | 'identity_mismatch' | 'not_found' | 'signal_failed'>;
}>;

function isProcessIdentityModule(value: unknown): value is ProcessIdentityModule {
  return typeof value === 'object' && value !== null
    && 'parseProcessIdentity' in value && typeof value.parseProcessIdentity === 'function'
    && 'readProcessIdentity' in value && typeof value.readProcessIdentity === 'function'
    && 'signalVerifiedProcess' in value && typeof value.signalVerifiedProcess === 'function';
}

async function loadProcessIdentityModule(): Promise<ProcessIdentityModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/process-identity.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isProcessIdentityModule(loaded)).toBe(true);
  if (!isProcessIdentityModule(loaded)) throw new Error('process_identity_module_missing');
  return loaded;
}

function procStatLine(pid: number, command: string, startTicks: number): string {
  const fields = Array.from({ length: 20 }, () => '0');
  fields[0] = 'S';
  fields[1] = '1';
  fields[2] = '42';
  fields[3] = '42';
  fields[11] = '20';
  fields[12] = '3';
  fields[19] = String(startTicks);
  return `${pid} (${command}) ${fields.join(' ')}`;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('parses_process_identity_when_comm_contains_spaces_and_parentheses', async () => {
  const identity = await loadProcessIdentityModule().then((module) =>
    module.parseProcessIdentity(81, procStatLine(81, 'diagnostic (fork) worker', 9012)));

  expect(identity).toEqual({ pid: 81, startTicks: '9012', ppid: 1, pgid: 42, sid: 42, cpuTicks: 23 });
});

it('reports_not_found_when_process_identity_file_does_not_exist', async () => {
  const module = await loadProcessIdentityModule();
  const root = await mkdtemp(join(tmpdir(), 'nexus-proc-identity-'));
  roots.push(root);

  await expect(module.readProcessIdentity(82, root)).resolves.toEqual({ status: 'not_collected', reasonCode: 'not_found' });
});

it('does_not_signal_when_pid_start_ticks_no_longer_match', async () => {
  const module = await loadProcessIdentityModule();
  const expectedIdentity = { pid: 83, startTicks: '9012', ppid: 1, pgid: 42, sid: 42, cpuTicks: 23 };
  const signals: Array<Readonly<{ pid: number; signal: string }>> = [];

  const result = await module.signalVerifiedProcess(expectedIdentity, 'SIGTERM', {
    readIdentity: () => Promise.resolve({
      status: 'observed',
      identity: { ...expectedIdentity, startTicks: '9013' },
    }),
    signal: (pid, signal) => { signals.push({ pid, signal }); },
  });

  expect(result).toBe('identity_mismatch');
  expect(signals).toEqual([]);
});

it('signals_only_the_verified_pid_after_matching_start_ticks', async () => {
  const module = await loadProcessIdentityModule();
  const identity = { pid: 84, startTicks: '9012', ppid: 1, pgid: 42, sid: 42, cpuTicks: 23 };
  const signals: Array<Readonly<{ pid: number; signal: string }>> = [];

  await expect(module.signalVerifiedProcess(identity, 'SIGTERM', {
    readIdentity: () => Promise.resolve({ status: 'observed', identity }),
    signal: (pid, signal) => { signals.push({ pid, signal }); },
  })).resolves.toBe('signaled');

  expect(signals).toEqual([{ pid: identity.pid, signal: 'SIGTERM' }]);
});
