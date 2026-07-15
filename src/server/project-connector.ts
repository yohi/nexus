import {
  acquireGlobalLock,
  GlobalLockHeldError,
  projectStartupLockName,
} from '../utils/global-lock.js';

import {
  readProjectEndpoint,
  removeProjectEndpointIfMatching,
  type ProjectEndpoint,
} from './project-endpoint.js';
import { isProcessAlive } from './process-lock.js';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: StdioOptions },
) => ChildProcess;

export type FetchFn = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

export interface ProjectConnectorOptions {
  readonly projectRoot: string;
  readonly storageDir: string;
  readonly childExecutable: string;
  /**
   * Extra arguments spawned immediately before the standard managed-mode
   * arguments (`--project-root`, `--port`, `--managed`). Used to route the
   * spawn through a runtime/loader (e.g. `process.execPath` plus its
   * `execArgv`) when `childExecutable` is not directly executable, such as
   * a TypeScript source entry when running from a source checkout.
   */
  readonly childArgs?: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly spawn: SpawnFn;
  readonly fetch: FetchFn;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_STARTUP_LOG_BYTES = 64 * 1024;
const STARTUP_STDOUT_LOG_NAME = 'startup-stdout.log';
const STARTUP_STDERR_LOG_NAME = 'startup-stderr.log';

function validateTimeout(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite, positive number`);
  }
  return value;
}

function tailBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let totalBytes = 0;
  let startIndex = text.length;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const charBytes = encoder.encode(text[i] as string).length;
    if (totalBytes + charBytes > maxBytes) {
      break;
    }
    totalBytes += charBytes;
    startIndex = i;
  }
  return text.slice(startIndex);
}

async function cleanupStartupLog(path: string | undefined): Promise<void> {
  if (path === undefined) {
    return;
  }
  try {
    await unlink(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }
}

function buildOutputPreview(stdoutLog: string, stderrLog: string): string {
  const stdoutSection = stdoutLog
    ? `\n\nChild stdout:\n${stdoutLog.trimEnd()}`
    : '';
  const stderrSection = stderrLog
    ? `\n\nChild stderr:\n${stderrLog.trimEnd()}`
    : '';
  return `${stderrSection}${stdoutSection}`;
}

async function fetchHealth(
  endpoint: ProjectEndpoint,
  projectRoot: string,
  fetchImpl: FetchFn,
  timeoutMs: number,
): Promise<ProjectEndpoint | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(new URL('/health', endpoint.url).toString(), { signal: controller.signal });
    } catch {
      return undefined;
    }

    if (!response.ok) {
      return undefined;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      (body as Record<string, unknown>).instanceId !== endpoint.instanceId ||
      (body as Record<string, unknown>).projectRoot !== projectRoot
    ) {
      return undefined;
    }

    return endpoint;
  } finally {
    clearTimeout(timer);
  }
}

async function validateEndpoint(
  endpoint: ProjectEndpoint | undefined,
  projectRoot: string,
  fetchImpl: FetchFn,
  timeoutMs: number,
): Promise<ProjectEndpoint | undefined> {
  if (endpoint === undefined) {
    return undefined;
  }

  if (endpoint.projectRoot !== projectRoot) {
    // Treat a projectRoot mismatch as an invalid descriptor so callers do not
    // have to silence unexpected errors with `.catch(() => undefined)`.
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint.url);
  } catch {
    return undefined;
  }

  if (parsedUrl.hostname !== '127.0.0.1') {
    return undefined;
  }

  if (!isProcessAlive(endpoint.pid)) {
    return undefined;
  }

  return fetchHealth(endpoint, projectRoot, fetchImpl, timeoutMs);
}

async function waitForHealthyEndpoint(
  storageDir: string,
  projectRoot: string,
  fetchImpl: FetchFn,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProjectEndpoint> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out waiting for a healthy project endpoint');
    }

    const endpoint = await readProjectEndpoint(storageDir);
    const validated = await validateEndpoint(endpoint, projectRoot, fetchImpl, remainingMs);
    if (validated !== undefined) {
      return validated;
    }

    const remainingAfterCheck = deadline - Date.now();
    if (remainingAfterCheck <= 0) {
      throw new Error('Timed out waiting for a healthy project endpoint');
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, remainingAfterCheck));
    });
  }
}

export async function ensureProjectEndpoint(options: ProjectConnectorOptions): Promise<URL> {
  const startupTimeoutMs = validateTimeout(
    options.startupTimeoutMs,
    'startupTimeoutMs',
    DEFAULT_STARTUP_TIMEOUT_MS,
  );
  const pollIntervalMs = validateTimeout(options.pollIntervalMs, 'pollIntervalMs', DEFAULT_POLL_INTERVAL_MS);
  await mkdir(options.storageDir, { recursive: true });

  const initialEndpoint = await readProjectEndpoint(options.storageDir);
  const validated = await validateEndpoint(initialEndpoint, options.projectRoot, options.fetch, startupTimeoutMs);
  if (validated !== undefined) {
    return new URL(validated.url);
  }

  // Descriptor was invalid; remove it so we do not reuse a stale record.
  if (initialEndpoint !== undefined) {
    await removeProjectEndpointIfMatching(options.storageDir, initialEndpoint).catch(() => {});
  }

  const lockName = await projectStartupLockName(options.storageDir);

  let lockHandle: Awaited<ReturnType<typeof acquireGlobalLock>> | undefined;
  let spawned = false;
  let succeeded = false;
  try {
    try {
      lockHandle = await acquireGlobalLock(lockName);
    } catch (error) {
      if (!(error instanceof GlobalLockHeldError)) {
        throw error;
      }
      // Another connector is starting the managed server for this project.
      // Wait for it to publish a healthy descriptor instead of spawning.
      const winnerEndpoint = await waitForHealthyEndpoint(
        options.storageDir,
        options.projectRoot,
        options.fetch,
        startupTimeoutMs,
        pollIntervalMs,
      );
      succeeded = true;
      return new URL(winnerEndpoint.url);
    }

    // We hold the startup lock. Re-check the descriptor in case the winner
    // published while we were acquiring the lock.
    const winnerEndpoint = await validateEndpoint(
      await readProjectEndpoint(options.storageDir),
      options.projectRoot,
      options.fetch,
      startupTimeoutMs,
    );
    if (winnerEndpoint !== undefined) {
      succeeded = true;
      return new URL(winnerEndpoint.url);
    }

    // Prepare startup log files so the detached child can write diagnostics
    // over a path that survives the bridge process exiting. Pipes would keep the
    // child coupled to the bridge's lifetime, so stdio is fully detached below
    // and the child receives log paths via environment variables instead.
    const startupStdoutLog = join(options.storageDir, `${randomUUID()}-${STARTUP_STDOUT_LOG_NAME}`);
    const startupStderrLog = join(options.storageDir, `${randomUUID()}-${STARTUP_STDERR_LOG_NAME}`);

    const child = options.spawn(
      options.childExecutable,
      [
        ...(options.childArgs ?? []),
        '--project-root',
        options.projectRoot,
        '--port',
        '0',
        '--managed',
      ],
      {
        detached: true,
        env: {
          ...options.env,
          NEXUS_STARTUP_STDOUT_LOG: startupStdoutLog,
          NEXUS_STARTUP_STDERR_LOG: startupStderrLog,
        },
        stdio: ['ignore', 'ignore', 'ignore'] as const,
      },
    );
    spawned = true;

    // Race the health-check poll against the child's own error/close events.
    // Without this, a spawn failure (e.g. ENOENT) or a child that crashes
    // immediately would otherwise be masked: waitForHealthyEndpoint() would
    // just keep polling until startupTimeoutMs elapses and report a generic
    // timeout instead of the real failure.
    //
    // Diagnostics are not captured from stdio pipes (stdio is detached so the
    // child can outlive the bridge). Instead, the child writes startup output
    // to per-stream log files and we read the trailing 64 KiB when reporting a
    // startup failure.
    let rejectChildFailure: (reason: unknown) => void = () => {};
    const childFailure = new Promise<never>((_, reject) => {
      rejectChildFailure = reject;
    });
    function buildFailureError(code: number | null, signal: NodeJS.Signals | null): Error {
      let stdoutLog = '';
      let stderrLog = '';
      try {
        stdoutLog = readFileSync(startupStdoutLog, 'utf8');
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          throw error;
        }
      }
      try {
        stderrLog = readFileSync(startupStderrLog, 'utf8');
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          throw error;
        }
      }
      const outputPreview = buildOutputPreview(
        tailBytes(stdoutLog, MAX_STARTUP_LOG_BYTES),
        tailBytes(stderrLog, MAX_STARTUP_LOG_BYTES),
      );
      return new Error(
        `Managed nexus child exited before publishing a healthy endpoint (code=${code ?? 'null'}, signal=${signal ?? 'null'})${outputPreview}`,
      );
    }

    const onChildError = (error: Error): void => {
      rejectChildFailure(error);
    };

    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      rejectChildFailure(buildFailureError(code, signal));
    };

    child.once('error', onChildError);
    child.once('close', onChildClose);
    child.unref();

    try {
      const managedEndpoint = await Promise.race([
        waitForHealthyEndpoint(
          options.storageDir,
          options.projectRoot,
          options.fetch,
          startupTimeoutMs,
          pollIntervalMs,
        ),
        childFailure,
      ]);
      succeeded = true;
      return new URL(managedEndpoint.url);
    } finally {
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      if (succeeded) {
        await Promise.all([
          cleanupStartupLog(startupStdoutLog),
          cleanupStartupLog(startupStderrLog),
        ]);
      }
    }

  } finally {
    await lockHandle?.release().catch(() => {});
    // If we spawned a child but never saw a healthy descriptor, clean up the
    // stale descriptor left by a crashed or slow-starting child.
    if (spawned && !succeeded) {
      const finalEndpoint = await readProjectEndpoint(options.storageDir);
      if (finalEndpoint !== undefined) {
        const stillHealthy = await validateEndpoint(finalEndpoint, options.projectRoot, options.fetch, pollIntervalMs);
        if (stillHealthy === undefined) {
          await removeProjectEndpointIfMatching(options.storageDir, finalEndpoint).catch(() => {});
        }
      }
    }
  }
}
