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
  (url: string): Promise<Response>;
}

export interface ProjectConnectorOptions {
  readonly projectRoot: string;
  readonly storageDir: string;
  readonly childExecutable: string;
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
): Promise<ProjectEndpoint | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/health', endpoint.url).toString());
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
}

async function validateEndpoint(
  endpoint: ProjectEndpoint | undefined,
  projectRoot: string,
  fetchImpl: FetchFn,
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

  return fetchHealth(endpoint, projectRoot, fetchImpl);
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
    const endpoint = await readProjectEndpoint(storageDir);
    const validated = await validateEndpoint(endpoint, projectRoot, fetchImpl);
    if (validated !== undefined) {
      return validated;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out waiting for a healthy project endpoint');
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, remainingMs));
    });
  }
}

export async function ensureProjectEndpoint(options: ProjectConnectorOptions): Promise<URL> {
  const startupTimeoutMs = validateTimeout(options.startupTimeoutMs, 'startupTimeoutMs');
  const pollIntervalMs = validateTimeout(options.pollIntervalMs, 'pollIntervalMs');
  await mkdir(options.storageDir, { recursive: true });

  const initialEndpoint = await readProjectEndpoint(options.storageDir);
  const validated = await validateEndpoint(initialEndpoint, options.projectRoot, options.fetch);
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
    );
    if (winnerEndpoint !== undefined) {
      succeeded = true;
      return new URL(winnerEndpoint.url);
    }

    const child = options.spawn(
      options.childExecutable,
      [
        '--project-root',
        options.projectRoot,
        '--port',
        '0',
        '--managed',
      ],
      { detached: true, env: options.env, stdio: 'ignore' },
    );
    child.unref();
    spawned = true;

    const managedEndpoint = await waitForHealthyEndpoint(
      options.storageDir,
      options.projectRoot,
      options.fetch,
      startupTimeoutMs,
      pollIntervalMs,
    );
    succeeded = true;
    return new URL(managedEndpoint.url);
  } finally {
    await lockHandle?.release().catch(() => {});
    // If we spawned a child but never saw a healthy descriptor, clean up the
    // stale descriptor left by a crashed or slow-starting child.
    if (spawned && !succeeded) {
      const finalEndpoint = await readProjectEndpoint(options.storageDir);
      if (finalEndpoint !== undefined) {
        const stillHealthy = await validateEndpoint(finalEndpoint, options.projectRoot, options.fetch);
        if (stillHealthy === undefined) {
          await removeProjectEndpointIfMatching(options.storageDir, finalEndpoint).catch(() => {});
        }
      }
    }
  }
}
