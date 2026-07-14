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
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

export interface SpawnFn {
  (
    command: string,
    args: readonly string[],
    options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: 'ignore' },
  ): ChildProcess;
}

export interface FetchFn {
  (url: string, init?: { readonly signal?: AbortSignal }): Promise<Response>;
}

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

function validateTimeout(value: number | undefined, name: string): number {
  if (value === undefined) {
    return name === 'startupTimeoutMs' ? DEFAULT_STARTUP_TIMEOUT_MS : DEFAULT_POLL_INTERVAL_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite, positive number`);
  }
  return value;
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
  const startupTimeoutMs = validateTimeout(options.startupTimeoutMs, 'startupTimeoutMs');
  const pollIntervalMs = validateTimeout(options.pollIntervalMs, 'pollIntervalMs');
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
      { detached: true, env: options.env, stdio: 'ignore' },
    );
    spawned = true;

    // Race the health-check poll against the child's own error/exit events.
    // Without this, a spawn failure (e.g. ENOENT) or a child that crashes
    // immediately would otherwise be masked: waitForHealthyEndpoint() would
    // just keep polling until startupTimeoutMs elapses and report a generic
    // timeout instead of the real failure.
    let rejectChildFailure: (reason: unknown) => void = () => {};
    const childFailure = new Promise<never>((_, reject) => {
      rejectChildFailure = reject;
    });
    const onChildError = (error: Error): void => {
      rejectChildFailure(error);
    };
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      rejectChildFailure(
        new Error(
          `Managed nexus child exited before publishing a healthy endpoint (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      );
    };
    child.once('error', onChildError);
    child.once('exit', onChildExit);
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
      child.removeListener('exit', onChildExit);
    }
  } finally {
    await lockHandle?.release().catch(() => {});
    // If we spawned a child but never saw a healthy descriptor, clean up the
    // stale descriptor left by a crashed or slow-starting child.
    if (spawned && !succeeded) {
      const finalEndpoint = await readProjectEndpoint(options.storageDir);
      if (finalEndpoint !== undefined) {
        const stillHealthy = await validateEndpoint(finalEndpoint, options.projectRoot, options.fetch, startupTimeoutMs);
        if (stillHealthy === undefined) {
          await removeProjectEndpointIfMatching(options.storageDir, finalEndpoint).catch(() => {});
        }
      }
    }
  }
}
