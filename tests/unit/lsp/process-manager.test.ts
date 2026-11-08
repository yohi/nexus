import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProtocolNode from 'vscode-languageserver-protocol/node';

import type { ILspProvider } from '../../../src/lsp/contracts.js';
import {
  type LspChildProcess,
  type LspSpawnFunction,
  type LspSpawnOptions,
  RuntimeLocalLspManager,
  type RuntimeLocalLspManagerOptions,
} from '../../../src/lsp/process-manager.js';
import { createLspProtocolClient } from '../../../src/lsp/protocol-client.js';
import { resolveApprovedLspLaunch } from '../../../src/lsp/trust-policy.js';
import type { LspConfig } from '../../../src/types/index.js';

// F-007: count every Connection / reader / writer / listen() created through the protocol exports.
// The stub server uses its own independent framing, so all counts belong to Nexus production code.
const transportCounters = vi.hoisted(() => ({ connections: 0, listens: 0, readers: 0, writers: 0 }));

vi.mock('vscode-languageserver-protocol/node', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolNode>();
  class CountingReader extends actual.StreamMessageReader {
    constructor(...args: ConstructorParameters<typeof actual.StreamMessageReader>) {
      super(...args);
      transportCounters.readers += 1;
    }
  }
  class CountingWriter extends actual.StreamMessageWriter {
    constructor(...args: ConstructorParameters<typeof actual.StreamMessageWriter>) {
      super(...args);
      transportCounters.writers += 1;
    }
  }
  const createMessageConnection = ((...args: Parameters<typeof actual.createMessageConnection>) => {
    transportCounters.connections += 1;
    const connection = actual.createMessageConnection(...args);
    const listen = connection.listen.bind(connection);
    connection.listen = () => {
      transportCounters.listens += 1;
      listen();
    };
    return connection;
  }) as typeof actual.createMessageConnection;
  return {
    ...actual,
    StreamMessageReader: CountingReader,
    StreamMessageWriter: CountingWriter,
    createMessageConnection,
  };
});

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
}

interface StubServer {
  received: JsonRpcMessage[];
  messages(method: string): JsonRpcMessage[];
  waitFor(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

interface StubConfig {
  initializeResult?: unknown;
  handlers?: Record<string, (params: unknown, message: JsonRpcMessage) => unknown>;
}

interface StubModule {
  startStubLanguageServer(input: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    config?: StubConfig;
  }): StubServer;
  DEFAULT_INITIALIZE_RESULT: { capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } };
}

const STUB_PATH = new URL('../../fixtures/lsp/stub-language-server.mjs', import.meta.url);
// Loaded at module scope: table-driven cases build initialize results during collection.
const stubModule = (await import(STUB_PATH.href)) as StubModule;

interface FakeChildBehavior {
  stub?: StubConfig;
  /** Child exits by itself when it receives the `exit` notification (a well-behaved server). */
  exitOnExitNotification?: boolean;
  ignoreSigterm?: boolean;
}

/** In-process child double: real byte streams wired to the independent-framing stub server. */
class FakeChild extends EventEmitter implements LspChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  readonly stub: StubServer;

  constructor(
    private readonly behavior: FakeChildBehavior,
    private readonly events: string[],
  ) {
    super();
    this.stub = stubModule.startStubLanguageServer({
      input: this.stdin,
      output: this.stdout,
      config: behavior.stub ?? {},
    });
    this.stdin.on('data', () => undefined);
    void this.stub.waitFor((message) => message.method === 'exit').then(() => {
      this.events.push('exit-notification');
      if (behavior.exitOnExitNotification !== false) this.exitNow(0, null);
    });
  }

  get exited(): boolean {
    return this.exitCode !== null || this.signalCode !== null;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false;
    this.signals.push(signal);
    this.events.push(signal);
    if (signal === 'SIGTERM' && this.behavior.ignoreSigterm === true) return true;
    this.exitNow(null, signal);
    return true;
  }

  crash(): void {
    this.exitNow(1, null);
  }

  private exitNow(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stub.close();
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: LspSpawnOptions;
}

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('RuntimeLocalLspManager', () => {
  let base: string;
  let projectRoot: string;
  let exe: string;
  let storePath: string;
  let env: NodeJS.ProcessEnv;
  let events: string[];
  let children: FakeChild[];
  let spawnCalls: SpawnCall[];
  let behaviors: FakeChildBehavior[];
  let managers: RuntimeLocalLspManager[];
  let createdClients: { input: Parameters<typeof createLspProtocolClient>[0]; provider: ILspProvider }[];

  const EXE_BYTES = '#!/bin/sh\nexit 0\n';
  const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const lspFor = (overrides: Partial<LspConfig> = {}): LspConfig => ({
    enabled: true,
    typescript: { executable: exe, args: ['--stdio'] },
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    idleTimeoutMs: 60_000,
    ...overrides,
  });
  const approval = (overrides: Record<string, unknown> = {}) => ({
    projectRoot,
    executable: exe,
    executableSha256: sha(EXE_BYTES),
    args: ['--stdio'],
    serverVersion: '6.0.2',
    ...overrides,
  });
  const writeStore = async (approvals: unknown[], mode = 0o600) => {
    await writeFile(storePath, JSON.stringify({ version: 1, approvals }), 'utf8');
    await chmod(storePath, mode);
  };

  const fakeSpawn: LspSpawnFunction = (command, args, options) => {
    spawnCalls.push({ command, args: [...args], options });
    events.push('spawn');
    const child = new FakeChild(behaviors.shift() ?? {}, events);
    children.push(child);
    return child;
  };

  const resolveSpy = vi.fn(resolveApprovedLspLaunch);
  const createClientSpy = vi.fn((input: Parameters<typeof createLspProtocolClient>[0]) => {
    const provider = createLspProtocolClient(input);
    vi.spyOn(provider, 'start');
    createdClients.push({ input, provider });
    return provider;
  });

  const makeManager = (overrides: Partial<RuntimeLocalLspManagerOptions> = {}): RuntimeLocalLspManager => {
    const manager = new RuntimeLocalLspManager({
      projectRoot,
      lsp: lspFor(),
      env,
      resolveLaunch: resolveSpy,
      spawnProcess: fakeSpawn,
      createProtocolClient: createClientSpy,
      shutdownGraceMs: 500,
      killGraceMs: 50,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  };

  const initializeResultWith = (overrides: Record<string, unknown>, serverInfo?: unknown): unknown => ({
    capabilities: { ...stubModule.DEFAULT_INITIALIZE_RESULT.capabilities, ...overrides },
    ...(serverInfo === undefined ? {} : { serverInfo }),
  });

  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  const navigationMessages = (child: FakeChild) =>
    child.stub.received.filter((m) => typeof m.method === 'string' && m.method.startsWith('textDocument/'));

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-lsp-pm-')));
    projectRoot = path.join(base, 'project');
    await mkdir(projectRoot);
    exe = path.join(base, 'bin-lsp');
    await writeFile(exe, EXE_BYTES, 'utf8');
    await chmod(exe, 0o755);
    const xdg = path.join(base, 'xdg');
    const storeDir = path.join(xdg, 'nexus');
    await mkdir(storeDir, { recursive: true });
    await chmod(xdg, 0o700);
    await chmod(storeDir, 0o700);
    storePath = path.join(storeDir, 'lsp-trust.json');
    env = {
      XDG_CONFIG_HOME: xdg,
      HOME: base,
      TMPDIR: '/tmp',
      LANG: 'C',
      NODE_OPTIONS: '--require evil',
      NODE_PATH: '/evil',
      AWS_SECRET_ACCESS_KEY: 'secret-aws',
      GH_TOKEN: 'secret-gh',
      HTTPS_PROXY: 'http://proxy',
      NEXUS_EMBEDDING_API_KEY: 'secret-nexus',
    };
    events = [];
    children = [];
    spawnCalls = [];
    behaviors = [];
    managers = [];
    createdClients = [];
    resolveSpy.mockClear();
    createClientSpy.mockClear();
    transportCounters.connections = 0;
    transportCounters.listens = 0;
    transportCounters.readers = 0;
    transportCounters.writers = 0;
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.close();
    for (const child of children) expect(child.exited).toBe(true);
    await rm(base, { recursive: true, force: true });
  });

  describe('launch gate: zero spawned children without an Owner-approved launch', () => {
    it.each([
      ['enabled:false', async () => makeManager({ lsp: lspFor({ enabled: false }) }), 'LSP_NOT_CONFIGURED'],
      [
        'no executable configured',
        async () => makeManager({ lsp: lspFor({ typescript: { executable: null, args: ['--stdio'] } }) }),
        'LSP_NOT_CONFIGURED',
      ],
      [
        'invalid LSP config',
        async () => makeManager({ configError: 'LSP_CONFIG_INVALID' }),
        'LSP_CONFIG_INVALID',
      ],
      ['missing trust store', async () => makeManager(), 'LSP_TRUST_REQUIRED'],
      [
        'unsafe (group/world-readable) trust store',
        async () => {
          await writeStore([approval()], 0o644);
          return makeManager();
        },
        'LSP_TRUST_REQUIRED',
      ],
      [
        'untrusted worktree root',
        async () => {
          await writeStore([approval({ projectRoot: path.join(base, 'other') })]);
          return makeManager();
        },
        'LSP_TRUST_REQUIRED',
      ],
      [
        'executable digest mismatch',
        async () => {
          await writeStore([approval({ executableSha256: sha('different bytes') })]);
          return makeManager();
        },
        'LSP_EXECUTABLE_NOT_APPROVED',
      ],
      [
        'Owner version metadata mismatch',
        async () => {
          await writeStore([approval({ serverVersion: '6.0.1' })]);
          return makeManager();
        },
        'LSP_EXECUTABLE_NOT_APPROVED',
      ],
      [
        'missing Owner version metadata',
        async () => {
          const { serverVersion: _omit, ...rest } = approval();
          await writeStore([rest]);
          return makeManager();
        },
        'LSP_EXECUTABLE_NOT_APPROVED',
      ],
      [
        'args mismatch',
        async () => {
          await writeStore([approval({ args: ['--stdio', '--log-level', '4'] })]);
          return makeManager();
        },
        'LSP_EXECUTABLE_NOT_APPROVED',
      ],
    ])('%s => unavailable/%s with no spawn', async (_label, setup, reasonCode) => {
      const manager = await setup();
      expect(await manager.acquire()).toEqual({ status: 'unavailable', reasonCode });
      expect(spawnCalls).toHaveLength(0);
      expect(createClientSpy).not.toHaveBeenCalled();
    });

    it('spawns only the approved absolute executable/argv with shell:false, canonical cwd and allowlisted env', async () => {
      await writeStore([approval()]);
      const manager = makeManager();
      const result = await manager.acquire();
      expect(result.status).toBe('ok');

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.command).toBe(exe);
      expect(path.isAbsolute(call.command)).toBe(true);
      expect(call.args).toEqual(['--stdio']);
      expect(call.options.shell).toBe(false);
      expect(call.options.cwd).toBe(projectRoot);
      expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(Object.keys(call.options.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
      const serializedEnv = JSON.stringify(call.options.env);
      for (const forbidden of ['NODE_OPTIONS', 'NODE_PATH', 'secret-aws', 'secret-gh', 'HTTPS_PROXY', 'secret-nexus']) {
        expect(serializedEnv).not.toContain(forbidden);
      }
    });

    it('re-resolves approval on every new launch and spawns nothing after trust is revoked', async () => {
      await writeStore([approval()]);
      const manager = makeManager();
      expect((await manager.acquire()).status).toBe('ok');
      expect(resolveSpy).toHaveBeenCalledTimes(1);

      children[0]!.crash();
      await vi.waitFor(() => expect(manager.hasLiveProcess()).toBe(false));

      await writeStore([]);
      expect(await manager.acquire()).toEqual({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
      expect(resolveSpy).toHaveBeenCalledTimes(2);
      expect(spawnCalls).toHaveLength(1);
    });
  });

  describe('Owner-approved version value flow (three manager-boundary cases)', () => {
    beforeEach(async () => {
      await writeStore([approval()]);
    });

    it('forwards ApprovedLspLaunch.serverVersion unchanged as expectedServerVersion with rootUri and signal', async () => {
      const manager = makeManager();
      await manager.acquire();
      const start = vi.mocked(createdClients[0]!.provider.start);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({
        rootUri: pathToFileURL(projectRoot).href,
        expectedServerVersion: '6.0.2',
        signal: expect.any(AbortSignal),
      });
    });

    it('(a) matching reported serverInfo.version 6.0.2 acquires after protocol/UTF-16/capability checks', async () => {
      behaviors.push({
        stub: {
          initializeResult: initializeResultWith(
            { positionEncoding: 'utf-16' },
            { name: 'typescript-language-server', version: '6.0.2' },
          ),
        },
      });
      const manager = makeManager();
      const result = await manager.acquire();
      expect(result).toMatchObject({
        status: 'ok',
        capabilities: { definition: true, references: true, implementations: true, positionEncoding: 'utf-16' },
      });
    });

    it('(b) reported mismatch 6.0.1 => unavailable/LSP_EXECUTABLE_NOT_APPROVED, closed child, no navigation', async () => {
      behaviors.push({
        stub: { initializeResult: initializeResultWith({}, { name: 'typescript-language-server', version: '6.0.1' }) },
      });
      const manager = makeManager();
      const result = await manager.acquire();
      expect(result).toEqual({ status: 'unavailable', reasonCode: 'LSP_EXECUTABLE_NOT_APPROVED' });
      expect(JSON.stringify(result)).not.toContain('6.0.1');
      const child = children[0]!;
      await vi.waitFor(() => expect(child.exited).toBe(true));
      expect(child.stub.messages('exit')).toHaveLength(1);
      expect(navigationMessages(child)).toHaveLength(0);
      expect(manager.hasLiveProcess()).toBe(false);
    });

    it('(c) absent serverInfo.version is accepted after the same protocol/UTF-16/capability checks', async () => {
      behaviors.push({ stub: { initializeResult: initializeResultWith({}) } });
      const manager = makeManager();
      const result = await manager.acquire();
      expect(result).toMatchObject({ status: 'ok', capabilities: { positionEncoding: 'utf-16' } });
    });

    it('(c) absent version still rejects a non-UTF-16 position encoding as error/LSP_PROTOCOL_ERROR', async () => {
      behaviors.push({ stub: { initializeResult: initializeResultWith({ positionEncoding: 'utf-8' }) } });
      const manager = makeManager();
      expect(await manager.acquire()).toEqual({ status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' });
      await vi.waitFor(() => expect(children[0]!.exited).toBe(true));
    });
  });

  describe('connection boundary (F-007) and document sync support', () => {
    beforeEach(async () => {
      await writeStore([approval()]);
    });

    it('hands the child stdin/stdout to exactly one Protocol Client; one Connection, one listen()', async () => {
      const manager = makeManager({ lsp: lspFor({ requestTimeoutMs: 4321 }) });
      await Promise.all([manager.acquire(), manager.acquire()]);
      expect(createClientSpy).toHaveBeenCalledTimes(1);
      const input = createdClients[0]!.input;
      expect(input.stdin).toBe(children[0]!.stdin);
      expect(input.stdout).toBe(children[0]!.stdout);
      expect(input.rootUri).toBe(pathToFileURL(projectRoot).href);
      expect(input.requestTimeoutMs).toBe(4321);
      expect(transportCounters).toEqual({ connections: 1, listens: 1, readers: 1, writers: 1 });
    });

    it.each([
      ['missing', initializeResultWith({ textDocumentSync: undefined })],
      ['None (0)', initializeResultWith({ textDocumentSync: 0 })],
      ['openClose omitted', initializeResultWith({ textDocumentSync: { change: 1 } })],
    ])('textDocumentSync %s => unavailable/LSP_SYNC_UNSUPPORTED, closed child, zero navigation', async (_l, init) => {
      behaviors.push({ stub: { initializeResult: init } });
      const manager = makeManager();
      expect(await manager.acquire()).toEqual({ status: 'unavailable', reasonCode: 'LSP_SYNC_UNSUPPORTED' });
      const child = children[0]!;
      await vi.waitFor(() => expect(child.exited).toBe(true));
      expect(navigationMessages(child)).toHaveLength(0);
    });
  });

  describe('per-runtime process lifecycle', () => {
    beforeEach(async () => {
      await writeStore([approval()]);
    });

    it('concurrent first use starts exactly one process and returns the same provider', async () => {
      const manager = makeManager();
      const results = await Promise.all([manager.acquire(), manager.acquire(), manager.acquire()]);
      expect(spawnCalls).toHaveLength(1);
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.status === 'ok')).toBe(true);
      const providers = new Set(results.map((r) => (r.status === 'ok' ? r.provider : null)));
      expect(providers.size).toBe(1);
      expect((await manager.acquire()).status).toBe('ok');
      expect(spawnCalls).toHaveLength(1);
    });

    it('isolates processes by canonical project root (no cross-worktree sharing)', async () => {
      const otherRoot = path.join(base, 'other-worktree');
      await mkdir(otherRoot);
      await writeStore([approval(), approval({ projectRoot: otherRoot })]);
      const managerA = makeManager();
      const managerB = makeManager({ projectRoot: path.join(otherRoot, '.') });
      const [a, b] = await Promise.all([managerA.acquire(), managerB.acquire()]);
      expect(a.status).toBe('ok');
      expect(b.status).toBe('ok');
      expect(spawnCalls.map((call) => call.options.cwd).sort()).toEqual([otherRoot, projectRoot].sort());
      expect(createdClients.map((c) => c.input.rootUri).sort()).toEqual(
        [pathToFileURL(otherRoot).href, pathToFileURL(projectRoot).href].sort(),
      );
      if (a.status === 'ok' && b.status === 'ok') expect(a.provider).not.toBe(b.provider);
    });

    it('startup timeout => timeout/LSP_REQUEST_TIMEOUT and the child is reclaimed', async () => {
      const never = deferred<unknown>();
      behaviors.push({ stub: { handlers: { initialize: () => never.promise } } });
      const manager = makeManager({ lsp: lspFor({ startupTimeoutMs: 50 }) });
      expect(await manager.acquire()).toEqual({ status: 'timeout', reasonCode: 'LSP_REQUEST_TIMEOUT' });
      await vi.waitFor(() => expect(children[0]!.exited).toBe(true));
      expect(manager.hasLiveProcess()).toBe(false);
      never.resolve(stubModule.DEFAULT_INITIALIZE_RESULT);
    });

    it('a delayed initialize reply from a timed-out process cannot affect the later session', async () => {
      const late = deferred<unknown>();
      behaviors.push({ stub: { handlers: { initialize: () => late.promise } } }, {});
      const manager = makeManager({ lsp: lspFor({ startupTimeoutMs: 50 }) });
      expect((await manager.acquire()).status).toBe('timeout');

      const second = await manager.acquire();
      expect(second.status).toBe('ok');
      expect(spawnCalls).toHaveLength(2);
      expect(createdClients).toHaveLength(2);
      expect(createdClients[1]!.input.stdout).toBe(children[1]!.stdout);

      // The first process's late reply arrives after the new session started.
      late.resolve(initializeResultWith({}, { name: 'x', version: '6.0.1' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const third = await manager.acquire();
      expect(third.status).toBe('ok');
      if (second.status === 'ok' && third.status === 'ok') expect(third.provider).toBe(second.provider);
      expect(spawnCalls).toHaveLength(2);
    });

    it('cancellation before readiness => cancelled/REQUEST_CANCELLED and the process is reclaimed', async () => {
      const never = deferred<unknown>();
      behaviors.push({ stub: { handlers: { initialize: () => never.promise } } });
      const manager = makeManager();
      const controller = new AbortController();
      const pending = manager.acquire({ signal: controller.signal });
      await vi.waitFor(() => expect(children[0]?.stub.messages('initialize')).toHaveLength(1));
      controller.abort();
      expect(await pending).toEqual({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' });
      await vi.waitFor(() => expect(children[0]!.exited).toBe(true));
      never.resolve(stubModule.DEFAULT_INITIALIZE_RESULT);
    });

    it('one caller cancelling does not abort a startup another caller still awaits', async () => {
      const release = deferred<unknown>();
      behaviors.push({ stub: { handlers: { initialize: () => release.promise } } });
      const manager = makeManager();
      const controller = new AbortController();
      const cancelled = manager.acquire({ signal: controller.signal });
      const kept = manager.acquire();
      await vi.waitFor(() => expect(children[0]?.stub.messages('initialize')).toHaveLength(1));
      controller.abort();
      expect(await cancelled).toEqual({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' });
      release.resolve(stubModule.DEFAULT_INITIALIZE_RESULT);
      expect((await kept).status).toBe('ok');
      expect(spawnCalls).toHaveLength(1);
    });

    it('an already-aborted signal returns cancelled without spawning', async () => {
      const manager = makeManager();
      expect(await manager.acquire({ signal: AbortSignal.abort() })).toEqual({
        status: 'cancelled',
        reasonCode: 'REQUEST_CANCELLED',
      });
      expect(spawnCalls).toHaveLength(0);
    });

    it('crash during startup => unavailable/LSP_START_FAILED', async () => {
      behaviors.push({
        stub: {
          handlers: {
            initialize: () => {
              setImmediate(() => children[0]!.crash());
              return new Promise(() => undefined);
            },
          },
        },
      });
      const manager = makeManager();
      expect(await manager.acquire()).toEqual({ status: 'unavailable', reasonCode: 'LSP_START_FAILED' });
      expect(manager.hasLiveProcess()).toBe(false);
    });

    it('spawn failure => unavailable/LSP_START_FAILED with a sanitized reason', async () => {
      const manager = makeManager({
        spawnProcess: () => {
          throw new Error(`spawn ${exe} EACCES secret-detail`);
        },
      });
      const result = await manager.acquire();
      expect(result).toEqual({ status: 'unavailable', reasonCode: 'LSP_START_FAILED' });
    });

    it('child error event during startup => unavailable/LSP_START_FAILED', async () => {
      behaviors.push({ stub: { handlers: { initialize: () => new Promise(() => undefined) } } });
      const manager = makeManager();
      const pending = manager.acquire();
      await vi.waitFor(() => expect(children[0]?.stub.messages('initialize')).toHaveLength(1));
      children[0]!.emit('error', new Error(`ENOENT ${exe}`));
      children[0]!.crash();
      expect(await pending).toEqual({ status: 'unavailable', reasonCode: 'LSP_START_FAILED' });
    });

    it('crash after readiness restarts with a fresh Protocol Client and no previous document state', async () => {
      const manager = makeManager();
      const first = await manager.acquire();
      if (first.status !== 'ok') throw new Error('expected ok');
      const uri = pathToFileURL(path.join(projectRoot, 'a.ts')).href;
      await first.provider.syncDocument({ uri, languageId: 'typescript', text: 'export const a = 1;\n' });
      expect(first.provider.listOpenDocumentUris()).toEqual([uri]);

      children[0]!.crash();
      await vi.waitFor(() => expect(manager.hasLiveProcess()).toBe(false));

      const second = await manager.acquire();
      if (second.status !== 'ok') throw new Error('expected ok');
      expect(spawnCalls).toHaveLength(2);
      expect(createClientSpy).toHaveBeenCalledTimes(2);
      expect(second.provider).not.toBe(first.provider);
      expect(second.provider.listOpenDocumentUris()).toEqual([]);
      await second.provider.syncDocument({ uri, languageId: 'typescript', text: 'export const a = 1;\n' });
      const didOpen = children[1]!.stub.messages('textDocument/didOpen')[0];
      expect((didOpen?.params as { textDocument: { version: number } }).textDocument.version).toBe(1);
      // A stale provider from the crashed session cannot reach the new process.
      await expect(
        first.provider.navigate({ kind: 'definition', uri, position: { line: 0, character: 13 } }),
      ).rejects.toThrow();
      expect(children[1]!.stub.messages('textDocument/definition')).toHaveLength(0);
    });

    it('a sync-send failure terminates the unusable session; the next acquire gets a fresh process', async () => {
      const manager = makeManager();
      const first = await manager.acquire();
      if (first.status !== 'ok') throw new Error('expected ok');
      children[0]!.stdin.destroy();
      const uri = pathToFileURL(path.join(projectRoot, 'a.ts')).href;
      await expect(
        first.provider.syncDocument({ uri, languageId: 'typescript', text: 'x' }),
      ).rejects.toMatchObject({ reasonCode: 'LSP_PROTOCOL_ERROR' });
      await vi.waitFor(() => expect(children[0]!.exited).toBe(true));
      expect(manager.hasLiveProcess()).toBe(false);

      const second = await manager.acquire();
      expect(second.status).toBe('ok');
      expect(spawnCalls).toHaveLength(2);
      if (second.status === 'ok') expect(second.provider.listOpenDocumentUris()).toEqual([]);
    });

    it('idle timeout closes documents, sends shutdown/exit and reclaims the process', async () => {
      const manager = makeManager({ lsp: lspFor({ idleTimeoutMs: 60 }) });
      const result = await manager.acquire();
      if (result.status !== 'ok') throw new Error('expected ok');
      const uri = pathToFileURL(path.join(projectRoot, 'a.ts')).href;
      await result.provider.syncDocument({ uri, languageId: 'typescript', text: 'x' });
      const child = children[0]!;
      await vi.waitFor(() => expect(child.exited).toBe(true), { timeout: 2000 });
      const methods = child.stub.received.map((m) => m.method).filter((m) => m !== undefined);
      expect(methods.slice(-3)).toEqual(['textDocument/didClose', 'shutdown', 'exit']);
      expect(manager.hasLiveProcess()).toBe(false);
    });

    it('an active request defers idle close until it settles', async () => {
      const release = deferred<unknown>();
      behaviors.push({ stub: { handlers: { 'textDocument/definition': () => release.promise } } });
      const manager = makeManager({ lsp: lspFor({ idleTimeoutMs: 40 }) });
      const result = await manager.acquire();
      if (result.status !== 'ok') throw new Error('expected ok');
      const uri = pathToFileURL(path.join(projectRoot, 'a.ts')).href;
      await result.provider.syncDocument({ uri, languageId: 'typescript', text: 'const a = 1;' });
      const navigation = result.provider.navigate({ kind: 'definition', uri, position: { line: 0, character: 6 } });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(children[0]!.exited).toBe(false);
      release.resolve(null);
      expect(await navigation).toBeNull();
      await vi.waitFor(() => expect(children[0]!.exited).toBe(true), { timeout: 2000 });
    });

    it('close() emits didClose, shutdown, exit before any bounded kill', async () => {
      behaviors.push({ exitOnExitNotification: false, ignoreSigterm: true });
      const manager = makeManager();
      const result = await manager.acquire();
      if (result.status !== 'ok') throw new Error('expected ok');
      const uri = pathToFileURL(path.join(projectRoot, 'a.ts')).href;
      await result.provider.syncDocument({ uri, languageId: 'typescript', text: 'x' });

      const startedAt = Date.now();
      await manager.close();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const child = children[0]!;
      const methods = child.stub.received.map((m) => m.method).filter((m) => m !== undefined);
      expect(methods.slice(-3)).toEqual(['textDocument/didClose', 'shutdown', 'exit']);
      expect(events.slice(-3)).toEqual(['exit-notification', 'SIGTERM', 'SIGKILL']);
      expect(child.exited).toBe(true);
    });

    it('close() does not signal a child that exited after the exit notification', async () => {
      const manager = makeManager();
      await manager.acquire();
      await manager.close();
      expect(children[0]!.signals).toEqual([]);
      expect(children[0]!.exitCode).toBe(0);
    });

    it('close() during startup reclaims the process and later acquires never spawn', async () => {
      const never = deferred<unknown>();
      behaviors.push({ stub: { handlers: { initialize: () => never.promise } } });
      const manager = makeManager();
      const pending = manager.acquire();
      await vi.waitFor(() => expect(children[0]?.stub.messages('initialize')).toHaveLength(1));
      await manager.close();
      expect((await pending).status).not.toBe('ok');
      expect(children[0]!.exited).toBe(true);
      expect(await manager.acquire()).toEqual({ status: 'unavailable', reasonCode: 'LSP_START_FAILED' });
      expect(spawnCalls).toHaveLength(1);
      never.resolve(stubModule.DEFAULT_INITIALIZE_RESULT);
    });
  });

  describe('bounded and sanitized child output', () => {
    beforeEach(async () => {
      await writeStore([approval()]);
    });

    it('drains stderr with bounded, sanitized retention and never surfaces it in results', async () => {
      const manager = makeManager();
      const pending = manager.acquire();
      await vi.waitFor(() => expect(children).toHaveLength(1));
      const noisy = `\u001b[31mFATAL token=secret-gh ${exe}\u0000\n`;
      children[0]!.stderr.write(noisy.repeat(20_000));
      const result = await pending;
      expect(result.status).toBe('ok');
      expect(JSON.stringify(result)).not.toContain('secret-gh');

      const diagnostics = manager.diagnostics();
      expect(diagnostics.stderrBytesSeen).toBeGreaterThan(100_000);
      expect(diagnostics.stderrTail.length).toBeLessThanOrEqual(2048);
      // eslint-disable-next-line no-control-regex
      expect(diagnostics.stderrTail).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    });

    it('terminates a session whose stdout exceeds the per-session byte budget', async () => {
      const manager = makeManager({ maxStdoutBytes: 4096 });
      const result = await manager.acquire();
      expect(result.status).toBe('ok');
      children[0]!.stub.notify('window/logMessage', { type: 3, message: 'x'.repeat(8192) });
      await vi.waitFor(() => expect(children[0]!.exited).toBe(true));
      expect(manager.hasLiveProcess()).toBe(false);
    });
  });

  describe('real child process integration', () => {
    it('spawns via the seam, acquires against a real stub process and reclaims it on close', async () => {
      await writeStore([approval()]);
      let child: LspChildProcess | undefined;
      const realStubSpawn: LspSpawnFunction = (command, args, options) => {
        spawnCalls.push({ command, args: [...args], options });
        // Test-only redirection: launch the fixture stub instead of the dummy approved file.
        child = nodeSpawn(process.execPath, [path.normalize(decodeURIComponent(STUB_PATH.pathname))], {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return child;
      };
      const manager = makeManager({ spawnProcess: realStubSpawn });
      const result = await manager.acquire();
      expect(result.status).toBe('ok');
      expect(manager.hasLiveProcess()).toBe(true);
      await manager.close();
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      expect(manager.hasLiveProcess()).toBe(false);
    });
  });
});
