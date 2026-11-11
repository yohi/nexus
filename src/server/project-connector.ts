import { inspectStorageOwnership, storageTargetsFingerprint } from './storage-ownership/index.js';
import {
  INTERNAL_TARGETS_FINGERPRINT_ENV,
  openBridgeStartupCoordination,
  readAttemptLog,
  type BridgeStartupCoordination,
  type StartupAttemptLogs,
} from './storage-ownership/startup-gate.js';
import type { KernelLock } from './storage-ownership/claims.js';
import { canonicalize } from './storage-ownership/targets.js';
import type { ResolvedStorageOwnershipTargets } from './storage-ownership/types.js';
import { readProjectEndpoint, type ProjectEndpoint } from './project-endpoint.js';
import { isProcessAlive } from './process-lock.js';
import type { ChildProcess, StdioOptions } from 'node:child_process';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: StdioOptions },
) => ChildProcess;

export type FetchFn = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

/**
 * Nexus #297 (Design §4.4 F-001): the Connector is discovery-only. It may run the read-only ownership preflight, read
 * the Endpoint and `/health`, and take the external Bridge startup gate in the coordination root. It never creates,
 * writes or deletes anything under Storage (no mkdir, no `endpoint.json` cleanup, no `nexus.pid`, no logs) and never
 * acquires a WriterAdmission; the managed child alone admits itself and handles stale same-owner descriptors.
 */
export interface ProjectConnectorOptions {
  readonly projectRoot: string;
  readonly storageDir: string;
  /** Full effective targets from `resolveStorageOwnershipTargets(loadConfig(...))`; must match projectRoot/storageDir. */
  readonly storageOwnershipTargets: ResolvedStorageOwnershipTargets;
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
    const charBytes = encoder.encode(text[i]).length;
    if (totalBytes + charBytes > maxBytes) {
      break;
    }
    totalBytes += charBytes;
    startIndex = i;
  }
  return text.slice(startIndex);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

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

interface DiscoveryContext {
  readonly projectRoot: string;
  readonly storageDir: string;
  readonly targets: ResolvedStorageOwnershipTargets;
  readonly fingerprint: string;
  readonly fetch: FetchFn;
}

class StorageOwnershipRefusedError extends Error {
  override readonly name = 'StorageOwnershipRefusedError';
}

/**
 * Read-only: returns a reusable endpoint only when a FRESH ownership preflight reports the storage as owned by this
 * project AND the descriptor carries the same internal three-target fingerprint AND URL/PID/instanceId/health match.
 * A legacy descriptor without a fingerprint is never optimistically reused. Throws on a `refuse` preflight. Nothing
 * is ever deleted or written, whatever the descriptor state.
 */
async function findReusableEndpoint(context: DiscoveryContext, timeoutMs: number): Promise<ProjectEndpoint | undefined> {
  const preflight = await inspectStorageOwnership(context.targets);
  if (preflight.disposition === 'refuse') {
    throw new StorageOwnershipRefusedError(
      `Storage ownership preflight refused the managed endpoint: ${preflight.reason ?? 'unknown reason'}`,
    );
  }
  if (preflight.disposition !== 'owned') {
    return undefined;
  }

  let endpoint: ProjectEndpoint | undefined;
  try {
    endpoint = await readProjectEndpoint(context.storageDir);
  } catch {
    return undefined;
  }
  if (
    endpoint === undefined ||
    endpoint.projectRoot !== context.projectRoot ||
    endpoint.storageTargetsFingerprint !== context.fingerprint ||
    // W06: when storage can outlive the worktree, the runtime must have been admitted under THIS incarnation's witness.
    (preflight.worktreeWitness !== undefined && endpoint.worktreeWitness !== preflight.worktreeWitness)
  ) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint.url);
  } catch {
    return undefined;
  }
  if (parsedUrl.hostname !== '127.0.0.1' || !isProcessAlive(endpoint.pid)) {
    return undefined;
  }

  return fetchHealth(endpoint, context.projectRoot, context.fetch, timeoutMs);
}

async function assertConsistentTargets(options: ProjectConnectorOptions): Promise<void> {
  const targets = options.storageOwnershipTargets;
  const [owner, root] = await Promise.all([
    canonicalize(options.projectRoot, 'projectRoot'),
    canonicalize(options.storageDir, 'storage.rootDir'),
  ]);
  if (owner !== targets.ownerProjectRoot || root !== targets.rootDir.path) {
    throw new Error('Project connector options do not match the resolved storage ownership targets');
  }
}

/**
 * Acquire the Bridge startup gate. While another Bridge holds it, keep polling for a reusable endpoint published by
 * that winner; never spawn without the gate.
 */
async function acquireStartupGate(
  coordination: BridgeStartupCoordination,
  context: DiscoveryContext,
  deadline: number,
  pollIntervalMs: number,
): Promise<{ readonly gate: KernelLock } | { readonly endpoint: ProjectEndpoint }> {
  while (true) {
    const gate = coordination.tryAcquireGate();
    if (gate !== null) {
      return { gate };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Timed out waiting for a healthy project endpoint');
    }
    const winner = await findReusableEndpoint(context, remainingMs);
    if (winner !== undefined) {
      return { endpoint: winner };
    }
    const remainingAfterCheck = deadline - Date.now();
    if (remainingAfterCheck <= 0) {
      throw new Error('Timed out waiting for a healthy project endpoint');
    }
    await sleep(Math.min(pollIntervalMs, remainingAfterCheck));
  }
}

async function waitForHealthyEndpoint(
  context: DiscoveryContext,
  deadline: number,
  pollIntervalMs: number,
): Promise<ProjectEndpoint> {
  let lastOwnershipRefusal: StorageOwnershipRefusedError | undefined;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      if (lastOwnershipRefusal !== undefined) throw lastOwnershipRefusal;
      throw new Error('Timed out waiting for a healthy project endpoint');
    }

    try {
      const validated = await findReusableEndpoint(context, remainingMs);
      if (validated !== undefined) {
        return validated;
      }
      lastOwnershipRefusal = undefined;
    } catch (error) {
      if (!(error instanceof StorageOwnershipRefusedError)) throw error;
      // The spawned child may be between creating a storage directory and publishing its ownership claim.
      // Continue read-only discovery while it starts; the child failure/timeout path remains authoritative.
      lastOwnershipRefusal = error;
    }

    const remainingAfterCheck = deadline - Date.now();
    if (remainingAfterCheck <= 0) {
      if (lastOwnershipRefusal !== undefined) throw lastOwnershipRefusal;
      throw new Error('Timed out waiting for a healthy project endpoint');
    }
    await sleep(Math.min(pollIntervalMs, remainingAfterCheck));
  }
}

type SpawnOutcome = 'healthy' | 'definite-failure' | 'uncertain';

async function spawnManagedChild(
  options: ProjectConnectorOptions,
  context: DiscoveryContext,
  logs: StartupAttemptLogs,
  deadline: number,
  pollIntervalMs: number,
): Promise<{ readonly outcome: SpawnOutcome; readonly endpoint?: ProjectEndpoint; readonly error?: unknown }> {
  let child: ChildProcess;
  try {
    child = options.spawn(
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
          NEXUS_STARTUP_STDOUT_LOG: logs.stdoutPath,
          NEXUS_STARTUP_STDERR_LOG: logs.stderrPath,
          [INTERNAL_TARGETS_FINGERPRINT_ENV]: context.fingerprint,
        },
        stdio: ['ignore', 'ignore', 'ignore'] as const,
      },
    );
  } catch (error) {
    return { outcome: 'definite-failure', error };
  }

  // Race the health-check poll against the child's own error/close events, so a spawn failure (e.g. ENOENT) or a
  // child that exits immediately is reported as the real failure instead of a generic timeout. Diagnostics come from
  // the attempt logs (stdio is detached so the child can outlive the Bridge).
  let rejectChildFailure: (reason: unknown) => void = () => {};
  const childFailure = new Promise<never>((_, reject) => {
    rejectChildFailure = reject;
  });
  const buildFailureError = (code: number | null, signal: NodeJS.Signals | null): Error => {
    const readLog = (path: string, label: string): string => {
      try {
        return readAttemptLog(path);
      } catch (error) {
        return `[Unable to read ${label} startup log: ${(error as Error).message}]`;
      }
    };
    const outputPreview = buildOutputPreview(
      tailBytes(readLog(logs.stdoutPath, 'stdout'), MAX_STARTUP_LOG_BYTES),
      tailBytes(readLog(logs.stderrPath, 'stderr'), MAX_STARTUP_LOG_BYTES),
    );
    return new Error(
      `Managed nexus child exited before publishing a healthy endpoint (code=${code ?? 'null'}, signal=${signal ?? 'null'})${outputPreview}`,
    );
  };
  let childSettled = false;
  const onChildError = (error: Error): void => {
    childSettled = true;
    rejectChildFailure(error);
  };
  const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    childSettled = true;
    rejectChildFailure(buildFailureError(code, signal));
  };
  child.once('error', onChildError);
  child.once('close', onChildClose);
  child.unref();

  try {
    const endpoint = await Promise.race([waitForHealthyEndpoint(context, deadline, pollIntervalMs), childFailure]);
    return { outcome: 'healthy', endpoint };
  } catch (error) {
    // `close`/`error` from the child is a definite outcome; a timeout or preflight refusal while the child may still
    // be running is not, so its logs are retained for owner-directed cleanup.
    return { outcome: childSettled ? 'definite-failure' : 'uncertain', error };
  } finally {
    child.removeListener('error', onChildError);
    child.removeListener('close', onChildClose);
  }
}

export async function ensureProjectEndpoint(options: ProjectConnectorOptions): Promise<URL> {
  const startupTimeoutMs = validateTimeout(
    options.startupTimeoutMs,
    'startupTimeoutMs',
    DEFAULT_STARTUP_TIMEOUT_MS,
  );
  const pollIntervalMs = validateTimeout(options.pollIntervalMs, 'pollIntervalMs', DEFAULT_POLL_INTERVAL_MS);
  await assertConsistentTargets(options);
  const context: DiscoveryContext = {
    projectRoot: options.projectRoot,
    storageDir: options.storageDir,
    targets: options.storageOwnershipTargets,
    fingerprint: storageTargetsFingerprint(options.storageOwnershipTargets),
    fetch: options.fetch,
  };
  const deadline = Date.now() + startupTimeoutMs;

  // 1. Read-only preflight + reuse of an eligible healthy same-owner runtime (refuse stops here, mutating nothing).
  const initial = await findReusableEndpoint(context, startupTimeoutMs);
  if (initial !== undefined) {
    return new URL(initial.url);
  }

  // 2. External startup gate in the coordination root (valid even when the Storage Root does not exist yet).
  const coordination = await openBridgeStartupCoordination(context.targets);
  const acquired = await acquireStartupGate(coordination, context, deadline, pollIntervalMs);
  if ('endpoint' in acquired) {
    return new URL(acquired.endpoint.url);
  }

  try {
    // 3. Under the gate: repeat preflight and endpoint/health inspection before requesting a spawn.
    const winner = await findReusableEndpoint(context, Math.max(1, deadline - Date.now()));
    if (winner !== undefined) {
      return new URL(winner.url);
    }

    // 4. Spawn request. The child re-resolves its own config and acquires WriterAdmission before touching Storage;
    // it alone may replace a stale same-owner descriptor. The Bridge never cleans descriptors, on any outcome.
    const logs = coordination.createAttemptLogs();
    const result = await spawnManagedChild(options, context, logs, deadline, pollIntervalMs);
    if (result.outcome !== 'uncertain') {
      logs.remove(); // definite outcome: remove only this attempt's token-owned logs
    }
    if (result.outcome === 'healthy' && result.endpoint !== undefined) {
      return new URL(result.endpoint.url);
    }
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  } finally {
    acquired.gate.release();
  }
}
