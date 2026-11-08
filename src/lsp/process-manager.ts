import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import type { LspConfig } from '../types/index.js';
import type { ILspProvider, LspCapabilities } from './contracts.js';
import {
  createLspProtocolClient,
  LspProtocolError,
  LspRequestCancelledError,
  LspRequestTimeoutError,
  LspServerVersionMismatchError,
  LspSyncUnsupportedError,
} from './protocol-client.js';
import { resolveApprovedLspLaunch } from './trust-policy.js';
import type { ApprovedLspLaunch } from './trust-policy.js';

export type LspProviderAcquisition =
  | {
      readonly status: 'ok';
      readonly provider: ILspProvider;
      readonly capabilities: Awaited<ReturnType<ILspProvider['start']>>;
    }
  | { readonly status: 'unavailable' | 'timeout' | 'cancelled' | 'error'; readonly reasonCode: string };

/** Spawn options the Manager always uses; never a shell, never inherited stdio or raw env. */
export interface LspSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ['pipe', 'pipe', 'pipe'];
  readonly windowsHide: true;
}

/** Minimal child-process surface used by the Manager (`node:child_process` ChildProcess satisfies it). */
export interface LspChildProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

/** Typed process-spawn seam. Receives only the Owner-approved absolute executable and argv. */
export type LspSpawnFunction = (command: string, args: readonly string[], options: LspSpawnOptions) => LspChildProcess;

export interface RuntimeLocalLspManagerOptions {
  /** Canonical project root of the owning NexusRuntime (re-canonicalized by the trust policy). */
  readonly projectRoot: string;
  readonly lsp: LspConfig;
  readonly configError?: 'LSP_CONFIG_INVALID';
  /** Source environment for the trust-store location and child allowlist (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit test seams; production uses the Task 2 resolver, `child_process.spawn` and the Task 5 client. */
  readonly resolveLaunch?: typeof resolveApprovedLspLaunch;
  readonly spawnProcess?: LspSpawnFunction;
  readonly createProtocolClient?: typeof createLspProtocolClient;
  /** Bound for the graceful didClose/shutdown/exit phase (default 2000ms). */
  readonly shutdownGraceMs?: number;
  /** Bound for each wait-for-exit stage before escalating SIGTERM -> SIGKILL (default 1000ms). */
  readonly killGraceMs?: number;
  /** Per-session stdout byte budget; exceeding it terminates the session (default 64 MiB). */
  readonly maxStdoutBytes?: number;
}

export interface LspManagerDiagnostics {
  /** Total stderr bytes drained from the current/last child. */
  readonly stderrBytesSeen: number;
  /** Bounded, control-character-free tail. Internal diagnostics only; never put in public results. */
  readonly stderrTail: string;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_MAX_CHARS = 2_048;
const CRASH_CLASSIFY_MS = 100;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

type Failure = Extract<LspProviderAcquisition, { status: 'unavailable' | 'timeout' | 'cancelled' | 'error' }>;
type StartupAbortReason = 'timeout' | 'cancelled' | 'closed';
type SessionFailure = 'exit' | 'output-limit';

const fail = (status: Failure['status'], reasonCode: string): Failure => Object.freeze({ status, reasonCode });

const START_FAILED = fail('unavailable', 'LSP_START_FAILED');
const PROTOCOL_ERROR = fail('error', 'LSP_PROTOCOL_ERROR');
const REQUEST_TIMEOUT = fail('timeout', 'LSP_REQUEST_TIMEOUT');
const REQUEST_CANCELLED = fail('cancelled', 'REQUEST_CANCELLED');

interface Session {
  readonly child: LspChildProcess;
  readonly provider: ILspProvider;
  readonly lease: ILspProvider;
  capabilities: LspCapabilities | null;
  exited: boolean;
  failure: SessionFailure | null;
  readonly failed: AbortController;
  active: number;
  idleTimer: NodeJS.Timeout | undefined;
  retired: boolean;
  teardown: Promise<void> | null;
  readonly detach: () => void;
}

interface Startup {
  readonly controller: AbortController;
  reason: StartupAbortReason | null;
  waiters: number;
  settled: boolean;
  promise: Promise<LspProviderAcquisition>;
}

/**
 * Lazy, runtime-local owner of one Owner-approved TypeScript/JavaScript language-server process
 * per NexusRuntime/projectRoot (TS and JS share it; no cross-worktree or global sharing).
 *
 * Owns only: launch gating (re-resolving Owner approval before every new launch), the approved
 * `shell:false` spawn, handing child stdin/stdout to exactly one Protocol Client, process
 * lifetime (coalesced startup, idle close, crash/cancel/timeout reclamation, bounded kill), and
 * stable LSP-local failure mapping. It never creates a MessageConnection, stream reader/writer
 * or `listen()`, and never processes LSP messages; the Protocol Client owns all of that.
 */
export class RuntimeLocalLspManager {
  private readonly projectRoot: string;
  private readonly lsp: LspConfig;
  private readonly configError: 'LSP_CONFIG_INVALID' | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolveLaunch: typeof resolveApprovedLspLaunch;
  private readonly spawnProcess: LspSpawnFunction;
  private readonly createProtocolClient: typeof createLspProtocolClient;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly maxStdoutBytes: number;

  private session: Session | null = null;
  private startup: Startup | null = null;
  private readonly teardowns = new Set<Promise<void>>();
  private readonly startups = new Set<Promise<LspProviderAcquisition>>();
  private closed = false;
  private stderrBytesSeen = 0;
  private stderrTail = '';

  constructor(options: RuntimeLocalLspManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.lsp = options.lsp;
    this.configError = options.configError;
    this.env = options.env ?? process.env;
    this.resolveLaunch = options.resolveLaunch ?? resolveApprovedLspLaunch;
    this.spawnProcess =
      options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.createProtocolClient = options.createProtocolClient ?? createLspProtocolClient;
    this.shutdownGraceMs = positiveOr(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
    this.killGraceMs = positiveOr(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.maxStdoutBytes = positiveOr(options.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
  }

  async acquire(input: { signal?: AbortSignal } = {}): Promise<LspProviderAcquisition> {
    const { signal } = input;
    if (this.closed) return START_FAILED;
    if (signal?.aborted === true) return REQUEST_CANCELLED;

    const current = this.session;
    if (current !== null && this.isUsable(current) && current.capabilities !== null) {
      this.scheduleIdle(current);
      return Object.freeze({ status: 'ok', provider: current.lease, capabilities: current.capabilities });
    }

    const startup = this.startup ?? this.beginStartup();
    startup.waiters += 1;
    if (signal === undefined) {
      try {
        return await startup.promise;
      } finally {
        startup.waiters -= 1;
      }
    }

    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<Failure>((resolve) => {
      onAbort = () => resolve(REQUEST_CANCELLED);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([startup.promise, cancelled]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
      startup.waiters -= 1;
      // The last interested caller withdrew: abandon the startup and reclaim its process.
      if (signal.aborted && startup.waiters === 0 && !startup.settled) this.abortStartup(startup, 'cancelled');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.startup !== null) this.abortStartup(this.startup, 'closed');
    if (this.session !== null) void this.retire(this.session, true);
    while (this.startups.size > 0 || this.teardowns.size > 0) {
      await Promise.allSettled([...this.startups, ...this.teardowns]);
    }
  }

  /** True while a spawned child for this runtime has not been reclaimed. */
  hasLiveProcess(): boolean {
    return this.session !== null || this.startup !== null || this.teardowns.size > 0;
  }

  diagnostics(): LspManagerDiagnostics {
    return { stderrBytesSeen: this.stderrBytesSeen, stderrTail: this.stderrTail };
  }

  private beginStartup(): Startup {
    const startup: Startup = {
      controller: new AbortController(),
      reason: null,
      waiters: 0,
      settled: false,
      promise: Promise.resolve(START_FAILED),
    };
    const promise = this.launch(startup).finally(() => {
      startup.settled = true;
      if (this.startup === startup) this.startup = null;
      this.startups.delete(promise);
    });
    startup.promise = promise;
    this.startups.add(promise);
    this.startup = startup;
    return startup;
  }

  private abortStartup(startup: Startup, reason: StartupAbortReason): void {
    if (startup.reason === null) startup.reason = reason;
    if (this.startup === startup) this.startup = null; // later callers begin a fresh startup
    startup.controller.abort();
  }

  private async launch(startup: Startup): Promise<LspProviderAcquisition> {
    const signal = startup.controller.signal;
    const timer = setTimeout(() => this.abortStartup(startup, 'timeout'), this.lsp.startupTimeoutMs);
    try {
      // Owner approval is re-resolved for every new launch; nothing is cached across launches.
      const decision = await this.resolveLaunch({
        projectRoot: this.projectRoot,
        lsp: this.lsp,
        env: this.env,
        ...(this.configError === undefined ? {} : { configError: this.configError }),
      });
      if (signal.aborted) return abortFailure(startup.reason);
      if (decision.status !== 'ok') return fail(decision.status, decision.reasonCode);

      const session = this.spawnSession(decision.launch);
      if (session === null) return START_FAILED;
      try {
        const capabilities = await raceAbort(
          session.provider.start({
            rootUri: pathToFileURL(decision.launch.cwd).href,
            expectedServerVersion: decision.launch.serverVersion,
            signal,
          }),
          [signal, session.failed.signal],
        );
        if (signal.aborted || !this.isUsable(session)) throw new LspProtocolError();
        session.capabilities = capabilities;
        this.session = session;
        this.scheduleIdle(session);
        return Object.freeze({ status: 'ok', provider: session.lease, capabilities });
      } catch (error) {
        if (isUntypedStartError(error) && startup.reason === null && session.failure === null) {
          // A crashing child usually closes stdout before 'exit' is observed; give the exit a
          // short bounded window so a crash maps to LSP_START_FAILED rather than a protocol error.
          await waitForExit(session.child, Math.min(this.killGraceMs, CRASH_CLASSIFY_MS), () => session.exited);
        }
        const failure = this.mapStartFailure(error, startup, session);
        // The failed child is reclaimed (bounded) before the failure is reported.
        await this.retire(session, true);
        return failure;
      }
    } catch {
      return startup.reason !== null ? abortFailure(startup.reason) : START_FAILED;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapStartFailure(error: unknown, startup: Startup, session: Session): Failure {
    if (error instanceof LspServerVersionMismatchError) return fail('unavailable', error.reasonCode);
    if (error instanceof LspSyncUnsupportedError) return fail('unavailable', error.reasonCode);
    if (startup.reason !== null) return abortFailure(startup.reason);
    if (session.failure === 'exit' || session.exited || hasExited(session.child)) return START_FAILED;
    if (session.failure === 'output-limit') return PROTOCOL_ERROR;
    if (error instanceof LspRequestTimeoutError) return REQUEST_TIMEOUT;
    if (error instanceof LspRequestCancelledError) return REQUEST_CANCELLED;
    return PROTOCOL_ERROR;
  }

  /** Spawns the approved launch and hands stdin/stdout to exactly one Protocol Client. */
  private spawnSession(launch: ApprovedLspLaunch): Session | null {
    let child: LspChildProcess;
    try {
      child = this.spawnProcess(launch.executable, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return null; // raw spawn errors (paths, errno text) are never surfaced
    }

    const failed = new AbortController();
    const markFailed = (failure: SessionFailure) => {
      if (session.failure === null) session.failure = failure;
      failed.abort();
    };
    // Always observe child errors so a failed spawn can never become an unhandled 'error'.
    child.on('error', () => markFailed('exit'));
    child.once('exit', () => {
      session.exited = true;
      markFailed('exit');
      if (!session.retired) void this.retire(session, false);
    });

    const { stdin, stdout, stderr } = child;
    const onStderr = (chunk: Buffer | string) => this.recordStderr(chunk);
    stderr?.on('data', onStderr);
    stderr?.on('error', noop);
    stdin?.on('error', noop);
    stdout?.on('error', noop);

    let provider: ILspProvider | null = null;
    if (stdin !== null && stdout !== null) {
      try {
        provider = this.createProtocolClient({
          stdin,
          stdout,
          rootUri: pathToFileURL(launch.cwd).href,
          requestTimeoutMs: this.lsp.requestTimeoutMs,
        });
      } catch {
        provider = null;
      }
    }
    if (provider === null) {
      void terminate(child, this.killGraceMs);
      stderr?.removeListener('data', onStderr);
      return null;
    }

    // Attached after the Protocol Client's reader so no frame is consumed before it listens.
    let stdoutBytes = 0;
    const onStdout = (chunk: Buffer | string) => {
      stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (stdoutBytes > this.maxStdoutBytes && session.failure === null) {
        markFailed('output-limit');
        void this.retire(session, false);
      }
    };
    stdout?.on('data', onStdout);

    this.stderrBytesSeen = 0;
    this.stderrTail = '';
    const session: Session = {
      child,
      provider,
      lease: this.createLease(() => session),
      capabilities: null,
      exited: child.exitCode !== null || child.signalCode !== null,
      failure: null,
      failed,
      active: 0,
      idleTimer: undefined,
      retired: false,
      teardown: null,
      detach: () => {
        stdout?.removeListener('data', onStdout);
        stderr?.removeListener('data', onStderr);
        // Keep draining so a lingering child never blocks on a full stderr pipe.
        stderr?.resume();
      },
    };
    return session;
  }

  /**
   * Provider handed to callers: delegates to the session's Protocol Client while tracking active
   * operations (idle close never interrupts one) and retiring the session when a document
   * synchronization send fails, so the next acquire gets a fresh process and client.
   */
  private createLease(getSession: () => Session): ILspProvider {
    const track = async <T>(operation: (provider: ILspProvider) => Promise<T>, poisonsOnFailure: boolean) => {
      const session = getSession();
      session.active += 1;
      this.clearIdle(session);
      try {
        return await operation(session.provider);
      } catch (error) {
        if (poisonsOnFailure && error instanceof LspProtocolError) void this.retire(session, true);
        throw error;
      } finally {
        session.active -= 1;
        if (this.session === session) this.scheduleIdle(session);
      }
    };
    return Object.freeze({
      start: (input: Parameters<ILspProvider['start']>[0]) => track((p) => p.start(input), false),
      syncDocument: (input: Parameters<ILspProvider['syncDocument']>[0]) => track((p) => p.syncDocument(input), true),
      closeDocument: (input: Parameters<ILspProvider['closeDocument']>[0]) =>
        track((p) => p.closeDocument(input), true),
      listOpenDocumentUris: () => getSession().provider.listOpenDocumentUris(),
      navigate: (input: Parameters<ILspProvider['navigate']>[0]) => track((p) => p.navigate(input), false),
      shutdown: () => this.retire(getSession(), true),
    });
  }

  private isUsable(session: Session): boolean {
    return !session.retired && !session.exited && session.failure === null;
  }

  private clearIdle(session: Session): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  private scheduleIdle(session: Session): void {
    this.clearIdle(session);
    if (session.active > 0 || !this.isUsable(session)) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      if (session.active === 0) void this.retire(session, true);
    }, this.lsp.idleTimeoutMs);
    session.idleTimer.unref();
  }

  /** Idempotent, never-rejecting session teardown with bounded termination. */
  private retire(session: Session, graceful: boolean): Promise<void> {
    if (session.teardown !== null) return session.teardown;
    session.retired = true;
    this.clearIdle(session);
    if (this.session === session) this.session = null;
    const teardown = this.performTeardown(session, graceful).finally(() => {
      session.detach();
      this.teardowns.delete(teardown);
    });
    session.teardown = teardown;
    this.teardowns.add(teardown);
    return teardown;
  }

  private async performTeardown(session: Session, graceful: boolean): Promise<void> {
    const { provider, child } = session;
    if (graceful && !session.exited) {
      // didClose (where possible) -> shutdown -> exit, all inside one bounded window.
      await withTimeout(
        (async () => {
          for (const uri of provider.listOpenDocumentUris()) {
            await provider.closeDocument({ uri }).catch(noop);
          }
          await provider.shutdown().catch(noop);
        })(),
        this.shutdownGraceMs,
      );
    } else {
      // Disposes the Connection; sends nothing over a dead transport.
      void provider.shutdown().catch(noop);
    }
    await terminate(child, this.killGraceMs, () => session.exited);
    void provider.shutdown().catch(noop);
  }

  private recordStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stderrBytesSeen += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    const sanitized = text.slice(-STDERR_TAIL_MAX_CHARS).replace(CONTROL_CHARACTERS, '');
    this.stderrTail = (this.stderrTail + sanitized).slice(-STDERR_TAIL_MAX_CHARS);
  }
}

const noop = (): void => undefined;

const positiveOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;

const abortFailure = (reason: StartupAbortReason | null): Failure => {
  switch (reason) {
    case 'timeout':
      return REQUEST_TIMEOUT;
    case 'cancelled':
      return REQUEST_CANCELLED;
    default:
      return START_FAILED;
  }
};

/** Rejects as soon as any signal aborts, without waiting for the underlying promise. */
const raceAbort = <T>(promise: Promise<T>, signals: readonly AbortSignal[]): Promise<T> => {
  if (signals.some((s) => s.aborted)) {
    promise.catch(noop);
    return Promise.reject(new LspProtocolError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new LspProtocolError());
    };
    const cleanup = () => {
      for (const s of signals) s.removeEventListener('abort', onAbort);
    };
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new LspProtocolError());
      },
    );
  });
};

const withTimeout = async (promise: Promise<unknown>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.catch(noop),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const isUntypedStartError = (error: unknown): boolean =>
  !(error instanceof LspServerVersionMismatchError) &&
  !(error instanceof LspSyncUnsupportedError) &&
  !(error instanceof LspRequestTimeoutError) &&
  !(error instanceof LspRequestCancelledError);

const hasExited = (child: LspChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child: LspChildProcess, ms: number, exited: () => boolean): Promise<boolean> => {
  if (exited() || hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(exited() || hasExited(child));
    }, ms);
    child.once('exit', onExit);
  });
};

/** Bounded termination: wait for a voluntary exit, then SIGTERM, then SIGKILL. */
const terminate = async (child: LspChildProcess, graceMs: number, exited: () => boolean = () => false) => {
  if (await waitForExit(child, graceMs, exited)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  if (await waitForExit(child, graceMs, exited)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
  await waitForExit(child, graceMs, exited);
};
