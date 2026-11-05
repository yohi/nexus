import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

type ProcessIdentity = Readonly<{ pid: number; startTicks: string; ppid: number; pgid: number; sid: number; cpuTicks: number }>;
type ProcessIdentityModule = Readonly<{
  readProcessIdentity: (pid: number) => Promise<
    | Readonly<{ status: 'observed'; identity: ProcessIdentity }>
    | Readonly<{ status: 'not_collected'; reasonCode: string }>
  >;
}>;
type PidfdSignalModule = Readonly<{
  checkPidfdSignalSupport: () => Promise<boolean>;
  sendProcessSignalWithPidfd: (identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL') => Promise<void>;
}>;

function isProcessIdentityModule(value: unknown): value is ProcessIdentityModule {
  return typeof value === 'object' && value !== null
    && 'readProcessIdentity' in value && typeof value.readProcessIdentity === 'function';
}

function isPidfdSignalModule(value: unknown): value is PidfdSignalModule {
  return typeof value === 'object' && value !== null
    && 'sendProcessSignalWithPidfd' in value && typeof value.sendProcessSignalWithPidfd === 'function';
}

async function loadModule<T>(file: string, isModule: (value: unknown) => value is T): Promise<T> {
  const url = pathToFileURL(resolve(process.cwd(), file)).href;
  const value: unknown = await import(url);
  expect(isModule(value)).toBe(true);
  if (!isModule(value)) throw new Error('pidfd_signal_module_invalid');
  return value;
}

it('signals_only_the_process_whose_pidfd_identity_matches_the_observed_start_ticks', async () => {
  const { readProcessIdentity } = await loadModule(
    'scripts/performance-diagnostics/process-identity.mjs',
    isProcessIdentityModule,
  );
  const { sendProcessSignalWithPidfd } = await loadModule(
    'scripts/performance-diagnostics/process-pidfd-signal.mjs',
    isPidfdSignalModule,
  );
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => process.exit(23)); process.send('ready'); setInterval(() => {}, 1000);",
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exitPromise = once(child, 'exit');
  const readyPromise = new Promise<string>((resolveReady, rejectReady) => {
    child.once('message', (message: unknown) => {
      if (message === 'ready') resolveReady(message);
      else rejectReady(new Error('pidfd_test_child_not_ready'));
    });
    child.once('error', rejectReady);
  });

  try {
    await once(child, 'spawn');
    await expect(readyPromise).resolves.toBe('ready');
    if (child.pid === undefined) throw new Error('pidfd_test_child_pid_unavailable');
    const observed = await readProcessIdentity(child.pid);
    if (observed.status !== 'observed') throw new Error('pidfd_test_child_identity_unavailable');

    await expect(sendProcessSignalWithPidfd({
      ...observed.identity,
      startTicks: '0',
    }, 'SIGTERM')).rejects.toMatchObject({ code: 'PIDFD_IDENTITY_MISMATCH' });
    await expect(readProcessIdentity(child.pid)).resolves.toMatchObject({
      status: 'observed',
      identity: { startTicks: observed.identity.startTicks },
    });

    await sendProcessSignalWithPidfd(observed.identity, 'SIGTERM');
    await expect(exitPromise).resolves.toEqual([23, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

it('does_not_resolve_the_pidfd_helper_from_a_writable_PATH_directory', async () => {
  const module = await loadModule(
    'scripts/performance-diagnostics/process-pidfd-signal.mjs',
    isPidfdSignalModule,
  );
  const directory = await mkdtemp(join(tmpdir(), 'nexus-pidfd-path-'));
  const marker = join(directory, 'invoked');
  const executable = join(directory, 'python3');
  const previousPath = process.env.PATH;
  const previousMarker = process.env.SONAR_TEST_MARKER;
  await writeFile(executable, '#!/bin/sh\nprintf invoked > "$SONAR_TEST_MARKER"\n', 'utf8');
  await chmod(executable, 0o700);

  try {
    process.env.PATH = directory;
    process.env.SONAR_TEST_MARKER = marker;

    await module.checkPidfdSignalSupport();

    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.SONAR_TEST_MARKER;
    else process.env.SONAR_TEST_MARKER = previousMarker;
    await rm(directory, { recursive: true, force: true });
  }
});
