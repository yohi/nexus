import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { access, lstat, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readProjectEndpoint } from '../../src/server/project-endpoint.js';
import { LOCK_FILENAME } from '../../src/server/process-lock.js';
import { DIRECTORY_CLAIM_FILENAME } from '../../src/server/storage-ownership/index.js';
import { PROJECT_LOCK_FILENAME } from '../../src/utils/project-lock.js';
import { createDisposableWorktreeSet, type DisposableWorktreeSet } from '../benchmarks/performance/git-fixture.js';

const cliPath = join(process.cwd(), 'dist', 'bin', 'nexus.js');
// Nexus #297: every spawned CLI (and, through the Bridge's forwarded execArgv/env, every managed child) uses a
// disposable storage-ownership coordination root instead of the real OS-account home.
const coordinationPreload = join(process.cwd(), 'tests', 'fixtures', 'storage-ownership', 'coordination-root-preload.mjs');
let coordinationBase: string | undefined;
let coordinationRoot = '';
const nexusArgs = (args: readonly string[]): string[] => ['--import', coordinationPreload, cliPath, ...args];
const nexusEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  ({ ...process.env, NEXUS_TEST_COORDINATION_ROOT: coordinationRoot, ...extra });
const realHomeCoordinationRoot = join(userInfo().homedir, '.local', 'state', 'nexus-ownership-v1');
/** Recursive snapshot (type, size, mtime) of a tree, or `absent`; used to prove the real home root is untouched. */
const snapshotTree = async (root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    let info;
    try { info = await lstat(path); } catch { out[path] = 'absent'; return; }
    out[path] = `${info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file'}:${info.size}:${info.mtimeMs}`;
    if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
  };
  await walk(root);
  return out;
};
let realHomeCoordinationBefore: Record<string, string> = {};

beforeAll(async () => {
  realHomeCoordinationBefore = await snapshotTree(realHomeCoordinationRoot);
});

beforeEach(async () => {
  coordinationBase = await realpath(await mkdtemp(join(tmpdir(), 'nexus-e2e-coord-')));
  coordinationRoot = join(coordinationBase, 'coord');
});

// File-level afterEach runs after the describe-level process reaping below, so fixtures and the coordination root
// are removed only once every spawned process is gone.
const fixtureCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  if (coordinationBase !== undefined) await rm(coordinationBase, { force: true, recursive: true });
  coordinationBase = undefined;
}, 30_000);

afterAll(async () => {
  // Guard: the e2e run must never create or modify the real account-home coordination root (whether or not it
  // existed before the run).
  expect(await snapshotTree(realHomeCoordinationRoot)).toEqual(realHomeCoordinationBefore);
});
const initializeRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'project-auto-connector-e2e', version: '1.0.0' },
  },
});
const toolsListRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
});

const bridges: ChildProcessWithoutNullStreams[] = [];
const projectRoots: string[] = [];
const managedProcesses: ChildProcessWithoutNullStreams[] = [];
const detachedManagedPids: number[] = [];

const waitFor = async <T>(predicate: () => Promise<T | undefined>, timeoutMs: number): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
};

const startBridge = (projectRoot: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams => {
  const bridge = spawn(process.execPath, nexusArgs(['http-bridge', '--project-root', projectRoot]), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: nexusEnv(extraEnv),
  });
  bridges.push(bridge);
  return bridge;
};

const sendRequest = async (
  bridge: ChildProcessWithoutNullStreams,
  request: string,
  responseId: number,
): Promise<unknown> => {
  let diagnostics = '';
  const response = new Promise<unknown>((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const message: unknown = JSON.parse(line);
          if (
            typeof message === 'object' &&
            message !== null &&
            'id' in message &&
            message.id === responseId
          ) {
            bridge.stdout.off('data', onData);
            bridge.stderr.off('data', onError);
            if ('result' in message) {
              resolve(message.result);
            } else {
              reject(new Error(`JSON-RPC error response: ${JSON.stringify(message)}`));
            }
            return;
          }
        } catch (error) {
          reject(error);
        }
      }
    };
    const onError = (chunk: Buffer): void => {
      diagnostics += chunk.toString('utf8');
    };
    bridge.stdout.on('data', onData);
    bridge.stderr.on('data', onError);
  });

  bridge.stdin.write(`${request}\n`);
  const exited = once(bridge, 'exit').then(([code]) => {
    throw new Error(`Bridge exited with code ${String(code)}: ${diagnostics}`);
  });
  return await Promise.race([response, exited]);
};

/** Calls an MCP tool through a Bridge and returns the serialized result for content assertions. */
const callTool = async (bridge: ChildProcessWithoutNullStreams, id: number, name: string, args: Record<string, unknown>): Promise<string> =>
  JSON.stringify(await sendRequest(bridge, JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }), id));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const initialIndexSettled = async (bridge: ChildProcessWithoutNullStreams): Promise<boolean> => {
  const raw: unknown = JSON.parse(await callTool(bridge, 20, 'index_status', {}));
  const result = isRecord(raw) ? raw : undefined;
  const structuredContent = isRecord(result?.structuredContent) ? result.structuredContent : undefined;
  const content = Array.isArray(result?.content) ? result.content : [];
  const textContent = content
    .map((entry) => isRecord(entry) ? entry : undefined)
    .find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
  let textResult: Record<string, unknown> | undefined;
  if (typeof textContent?.text === 'string') {
    const parsedText: unknown = JSON.parse(textContent.text);
    if (isRecord(parsedText)) textResult = parsedText;
  }
  const status = structuredContent ?? textResult;
  const indexStats = isRecord(status?.indexStats) ? status.indexStats : undefined;
  const pipelineProgress = isRecord(status?.pipelineProgress) ? status.pipelineProgress : undefined;
  const settled = indexStats?.lastIndexedAt !== null && indexStats?.lastIndexedAt !== undefined
    || typeof pipelineProgress?.lastError === 'string';
  return pipelineProgress?.status === 'idle' && settled;
};

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Graceful managed shutdown awaits an in-flight startup full index before the process exits (runtime.close() awaits
// it). Measured for the git fixture with the local Ollama provider: ~11 s when SIGTERM arrives during that index,
// ~40 ms once it has finished. Hence a generous bound.
const waitForExit = async (pid: number): Promise<void> => {
  await waitFor(() => Promise.resolve(isAlive(pid) ? undefined : true as const), 30_000);
};

const stopBridge = async (bridge: ChildProcessWithoutNullStreams): Promise<void> => {
  if (bridge.exitCode !== null || bridge.signalCode !== null) return;
  bridge.kill('SIGTERM');
  await once(bridge, 'exit');
};

/**
 * Kernel writer-lease holders per `writer/<resourceKey>.lock` in the disposable coordination root, read from
 * /proc/locks (POSIX WRITE locks by inode). Only locks with at least one live holder are returned.
 */
const heldWriterLeases = async (): Promise<Map<string, Set<number>>> => {
  const dir = join(coordinationRoot, 'writer');
  const procLocks = (await readFile('/proc/locks', 'utf8')).split('\n').filter((line) => !line.includes('->'));
  const held = new Map<string, Set<number>>();
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith('.lock'))) {
    const { ino } = await stat(join(dir, name));
    const holders = new Set<number>();
    for (const line of procLocks) {
      const fields = line.trim().split(/\s+/);
      if (fields[1] === 'POSIX' && fields[3] === 'WRITE' && fields[5]?.split(':')[2] === String(ino)) holders.add(Number(fields[4]));
    }
    if (holders.size > 0) held.set(name, holders);
  }
  return held;
};

const execFileAsync = promisify(execFile);

const worktreeSet = async (skip: (note: string) => never): Promise<DisposableWorktreeSet> => {
  const set = await createDisposableWorktreeSet('smoke', new AbortController().signal);
  if (set.status === 'skipped') skip('environment unavailable: git is missing');
  fixtureCleanups.push(set.dispose);
  return set;
};

/** git against the disposable fixture repository with the fixture's isolated (non-user) git configuration. */
const fixtureGit = async (set: DisposableWorktreeSet, args: readonly string[]): Promise<void> => {
  await execFileAsync('git', [...args], { cwd: set.primary,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirname(set.primary), 'git-config') } });
};

const recreateWorktree = async (set: DisposableWorktreeSet, oldPath: string, newPath: string): Promise<void> => {
  await fixtureGit(set, ['worktree', 'remove', '--force', oldPath]);
  await expect(lstat(oldPath)).rejects.toThrow();
  await fixtureGit(set, ['worktree', 'add', '--quiet', '--detach', newPath, 'HEAD']);
};

const OLD_FILE = 'old-incarnation.ts';
const OLD_SYMBOL = 'oldIncarnationOnlyMarker';
const NEW_FILE = 'new-incarnation.ts';
const NEW_SYMBOL = 'newIncarnationOnlyMarker';
const writeOld = async (root: string): Promise<void> => writeFile(join(root, OLD_FILE), `export const ${OLD_SYMBOL} = 'old';\n`);
const writeNew = async (root: string): Promise<void> => writeFile(join(root, NEW_FILE), `export const ${NEW_SYMBOL} = 'new';\n`);

const endpointOf = async (storageDir: string) => waitFor(async () => readProjectEndpoint(storageDir), 15_000);

describe('project auto-connector CLI', () => {
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) {
      if (bridge.exitCode === null && bridge.signalCode === null) {
        bridge.kill();
        await once(bridge, 'exit');
      }
    }
    await Promise.all(projectRoots.splice(0).map(async (projectRoot) => rm(projectRoot, { force: true, recursive: true })));
  });

  afterEach(async () => {
    for (const managed of managedProcesses.splice(0)) {
      if (managed.exitCode === null && managed.signalCode === null) {
        managed.kill();
        await once(managed, 'exit');
      }
    }
  });

  afterEach(async () => {
    // Detached managed children spawned indirectly through the bridge (via
    // ensureProjectEndpoint) have no local ChildProcess handle, so they must
    // be reaped by pid instead of through the `managedProcesses` array above.
    // Signal all first, then wait in parallel (several children per test for the #297 worktree cases). Graceful
    // managed shutdown awaits an in-flight startup full index (runtime.close() awaits it; measured ~11 s for the git
    // fixture with the local Ollama provider), hence the 30 s bound. A child that is still alive after that is
    // SIGKILLed and the hook FAILS, so a leaked child (and its writer leases) can never silently affect later tests.
    const pids = detachedManagedPids.splice(0).filter((pid) => {
      try {
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    });
    const leaked: number[] = [];
    await Promise.all(pids.map(async (pid) => {
      const exited = await waitFor(() => Promise.resolve(isAlive(pid) ? undefined : true as const), 30_000)
        .then(() => true, () => false);
      if (exited) return;
      leaked.push(pid);
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      await waitFor(() => Promise.resolve(isAlive(pid) ? undefined : true as const), 5_000).catch(() => undefined);
    }));
    expect(leaked, `managed children did not exit within 30 s of SIGTERM (SIGKILLed): ${leaked.join(', ')}`).toEqual([]);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
  }, 45_000);

  it('shares one managed endpoint and removes it after both bridge clients disconnect', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-auto-connector-e2e-'));
    projectRoots.push(projectRoot);
    const storageDir = join(projectRoot, '.nexus');
    const firstBridge = startBridge(projectRoot);
    const secondBridge = startBridge(projectRoot);

    await Promise.all([
      sendRequest(firstBridge, initializeRequest, 1),
      sendRequest(secondBridge, initializeRequest, 1),
    ]);
    await Promise.all([
      sendRequest(firstBridge, toolsListRequest, 2),
      sendRequest(secondBridge, toolsListRequest, 2),
    ]);

    const endpoint = await waitFor(
      async () => readProjectEndpoint(storageDir),
      5_000,
    );
    expect(endpoint.projectRoot).toBe(projectRoot);

    firstBridge.stdin.end();
    secondBridge.stdin.end();
    await Promise.all([once(firstBridge, 'exit'), once(secondBridge, 'exit')]);

    await waitFor(async () => {
      const current = await readProjectEndpoint(storageDir);
      return current === undefined ? true : undefined;
    }, 5_000);
  });

  it('releases both the endpoint descriptor and the process lock when a managed server receives SIGTERM', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-auto-connector-e2e-'));
    projectRoots.push(projectRoot);
    const storageDir = join(projectRoot, '.nexus');
    const lockPath = join(storageDir, LOCK_FILENAME);

    const managed = spawn(
      process.execPath,
      nexusArgs(['--project-root', projectRoot, '--port', '0', '--managed']),
      { stdio: ['pipe', 'pipe', 'pipe'], env: nexusEnv() },
    );
    managedProcesses.push(managed);

    const endpoint = await waitFor(async () => readProjectEndpoint(storageDir), 10_000);
    expect(endpoint.pid).toBe(managed.pid);

    await waitFor(
      async () => access(lockPath).then(() => true as const, () => undefined),
      5_000,
    );

    managed.kill('SIGTERM');
    const [exitCode] = await once(managed, 'exit');
    expect(exitCode).toBe(0);

    // Regression guard: the managed server must release nexus.pid (via
    // releaseProcessLock) *and* remove endpoint.json before it exits, even
    // though it shuts down through process.exit(0) (exitOnShutdown: true).
    // See src/server/managed-http-server.ts close().
await expect(access(lockPath)).rejects.toThrow();
await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('S13_child_revalidates_config_change', async () => {
    // Nexus #297: the managed child re-resolves its own effective targets and refuses BEFORE writer admission when
    // they differ from the fingerprint the Bridge inspected (internal spawn channel). Nothing is created under Storage
    // and no coordination-root lock is taken, because the refusal precedes admission.
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-auto-connector-e2e-'));
    projectRoots.push(projectRoot);
    const storageDir = join(projectRoot, '.nexus');
    const child = spawn(process.execPath, nexusArgs(['--project-root', projectRoot, '--port', '0', '--managed']), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: nexusEnv({ NEXUS_INTERNAL_STORAGE_TARGETS_FINGERPRINT: 'f'.repeat(64) }),
    });
    managedProcesses.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('target_mismatch');
    await expect(lstat(storageDir)).rejects.toThrow();
  });

  it('keeps the detached managed child running after the spawning bridge process receives SIGTERM', async () => {
    // Regression guard for the http-bridge/project-connector detached child
    // contract: project-connector.ts spawns the managed nexus server with
    // `detached: true, stdio: ['ignore', 'ignore', 'ignore']` specifically so
    // it can outlive the bridge process that spawned it (e.g. the bridge's
    // stdio-based MCP transport disconnecting, or the bridge itself being
    // terminated). This test spawns a real bridge, drives it far enough to
    // spawn the detached managed child via ensureProjectEndpoint, kills only
    // the bridge with SIGTERM, and asserts the managed child is still alive
    // afterward.
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-auto-connector-e2e-'));
    projectRoots.push(projectRoot);
    const storageDir = join(projectRoot, '.nexus');

    const bridge = startBridge(projectRoot);
    await sendRequest(bridge, initializeRequest, 1);
    await sendRequest(bridge, toolsListRequest, 2);

    const endpoint = await waitFor(async () => readProjectEndpoint(storageDir), 10_000);
    detachedManagedPids.push(endpoint.pid);

    // Sanity check: the managed child must be a distinct, live process from
    // the bridge before we kill the bridge below.
    expect(endpoint.pid).not.toBe(bridge.pid);
    expect(() => process.kill(endpoint.pid, 0)).not.toThrow();

    bridge.kill('SIGTERM');
    await once(bridge, 'exit');

    // The bridge is gone, but the detached managed child must still be
    // running: killing it here (not throwing ESRCH) proves it survived the
    // bridge's termination instead of dying alongside it.
    expect(() => process.kill(endpoint.pid, 0)).not.toThrow();
});

  // Nexus #297 W04: two sibling worktrees, each through its own Bridge, launched concurrently as real processes.
  it('W04_concurrent_sibling_runtimes_and_bridges_are_independent', { timeout: 90_000 }, async (ctx) => {
    const set = await worktreeSet((note) => ctx.skip(note));
    const roots = [set.primary, set.linkedA] as const;
    const files = ['sentinel-primary.ts', 'sentinel-linkedA.ts'] as const;
    const symbols = ['w04SentinelPrimaryMarker', 'w04SentinelLinkedAMarker'] as const;
    await Promise.all(roots.map(async (root, i) => writeFile(join(root, files[i]!), `export const ${symbols[i]!} = ${i};\n`)));
    const pair = roots.map((root) => startBridge(root));
    const endpoints: Awaited<ReturnType<typeof endpointOf>>[] = [];
    try {
      await Promise.all(pair.map(async (bridge) => sendRequest(bridge, initializeRequest, 1)));
    } finally {
      endpoints.push(...(await Promise.all(roots.map(async (root) =>
        await endpointOf(join(root, '.nexus')).catch(() => undefined)))).filter((endpoint) => endpoint !== undefined));
      detachedManagedPids.push(...endpoints.map((endpoint) => endpoint.pid));
    }
    const [first, second] = endpoints as [typeof endpoints[0], typeof endpoints[0]];
    expect(first.pid).not.toBe(second.pid);
    expect(first.url).not.toBe(second.url);
    expect(first.instanceId).not.toBe(second.instanceId);
    for (const [i, root] of roots.entries()) {
      const endpoint = endpoints[i]!;
      expect(endpoint.projectRoot).toBe(root);
      expect(endpoint.pid).not.toBe(pair[i]!.pid); // a managed child, not the Bridge
      expect((await readFile(join(root, '.nexus', LOCK_FILENAME), 'utf8')).trim()).toBe(String(endpoint.pid));
      await access(join(root, '.nexus', PROJECT_LOCK_FILENAME)); // independent per-root project lock
    }
    // Independent writer leases: 3 persistent targets per runtime, each held by exactly its own managed child.
    const held = await heldWriterLeases();
    expect(held.size).toBe(6);
    const holderPids = new Set<number>();
    for (const holders of held.values()) { expect(holders.size).toBe(1); for (const pid of holders) holderPids.add(pid); }
    expect([...holderPids].sort()).toEqual(endpoints.map((endpoint) => endpoint.pid).sort());
    // No cross-routing: each Bridge sees only its own worktree's sentinel.
    for (const [i, bridge] of pair.entries()) {
      const other = 1 - i;
      expect(await callTool(bridge, 10, 'grep_search', { pattern: symbols[i] })).toContain(files[i]);
      expect(await callTool(bridge, 11, 'grep_search', { pattern: symbols[other] })).not.toContain(files[other]);
    }
  });

  // Nexus #297 W05: one linked worktree, two Bridges launched concurrently, reuse one healthy managed runtime.
  it('W05_same_worktree_two_bridges_reuse_one_managed_runtime', { timeout: 90_000 }, async (ctx) => {
    const set = await worktreeSet((note) => ctx.skip(note));
    await writeFile(join(set.linkedB, 'sentinel-linkedB.ts'), 'export const w05SentinelLinkedBMarker = 1;\n');
    const pair = [startBridge(set.linkedB), startBridge(set.linkedB)];
    await Promise.all(pair.map(async (bridge) => sendRequest(bridge, initializeRequest, 1)));
    const endpoint = await endpointOf(join(set.linkedB, '.nexus'));
    detachedManagedPids.push(endpoint.pid);
    for (const bridge of pair) {
      expect(await callTool(bridge, 10, 'grep_search', { pattern: 'w05SentinelLinkedBMarker' })).toContain('sentinel-linkedB.ts');
    }
    // Exactly one writer: the three target leases are all held by the single published managed child.
    const held = await heldWriterLeases();
    expect(held.size).toBe(3);
    for (const holders of held.values()) expect([...holders]).toEqual([endpoint.pid]);
    expect((await readProjectEndpoint(join(set.linkedB, '.nexus')))?.pid).toBe(endpoint.pid);
  });

  // Nexus #297 W06: delete/recreate with a surviving old managed child, default storage.
  it('W06_different_path_recreation_with_surviving_old_child', { timeout: 90_000 }, async (ctx) => {
    const set = await worktreeSet((note) => ctx.skip(note));
    await writeOld(set.linkedA);
    const oldBridge = startBridge(set.linkedA);
    await sendRequest(oldBridge, initializeRequest, 1);
    const old = await endpointOf(join(set.linkedA, '.nexus'));
    detachedManagedPids.push(old.pid);
    await stopBridge(oldBridge);
    const moved = join(dirname(set.linkedA), 'linkedA-recreated');
    await recreateWorktree(set, set.linkedA, moved);
    await writeNew(moved);
    const bridge = startBridge(moved);
    await sendRequest(bridge, initializeRequest, 1);
    const fresh = await endpointOf(join(moved, '.nexus'));
    detachedManagedPids.push(fresh.pid);
    expect(isAlive(old.pid)).toBe(true); // the old incarnation's runtime survived the deletion
    expect(fresh.pid).not.toBe(old.pid);
    expect(fresh.projectRoot).toBe(moved);
    expect(await callTool(bridge, 10, 'grep_search', { pattern: NEW_SYMBOL })).toContain(NEW_FILE);
    expect(await callTool(bridge, 11, 'grep_search', { pattern: OLD_SYMBOL })).not.toContain(OLD_FILE);
  });

  it('W06_same_path_recreation_default_storage_never_attaches_to_surviving_old_child', { timeout: 120_000 }, async (ctx) => {
    const set = await worktreeSet((note) => ctx.skip(note));
    await writeOld(set.linkedA);
    const oldBridge = startBridge(set.linkedA);
    await sendRequest(oldBridge, initializeRequest, 1);
    const old = await endpointOf(join(set.linkedA, '.nexus'));
    detachedManagedPids.push(old.pid);
    await waitFor(() => initialIndexSettled(oldBridge).then((settled) => settled ? true : undefined), 90_000);
    expect(await callTool(oldBridge, 21, 'grep_search', { pattern: OLD_SYMBOL })).toContain(OLD_FILE);
    await stopBridge(oldBridge);
    await recreateWorktree(set, set.linkedA, set.linkedA);
    // The old descriptor went away with the old checkout and the old child still holds the path-keyed writer leases:
    // the recreated incarnation's Bridge neither reaches the old runtime nor gets a second writer.
    const blocked = startBridge(set.linkedA);
    const outcome = await sendRequest(blocked, initializeRequest, 1).then(() => 'connected', (error: unknown) => String(error));
    expect(outcome).not.toBe('connected');
    expect(outcome).toContain('writer_busy');
    expect(isAlive(old.pid)).toBe(true);
    expect(await readProjectEndpoint(join(set.linkedA, '.nexus'))).toBeUndefined();
    process.kill(old.pid, 'SIGTERM');
    await waitForExit(old.pid);
    await writeNew(set.linkedA);
    const bridge = startBridge(set.linkedA);
    await sendRequest(bridge, initializeRequest, 1);
    const fresh = await endpointOf(join(set.linkedA, '.nexus'));
    detachedManagedPids.push(fresh.pid);
    expect(fresh.pid).not.toBe(old.pid);
    expect(await callTool(bridge, 10, 'grep_search', { pattern: NEW_SYMBOL })).toContain(NEW_FILE);
    expect(await callTool(bridge, 11, 'grep_search', { pattern: OLD_SYMBOL })).not.toContain(OLD_FILE);
  });

  // Nexus #297 W06-A/B/C (witness): external custom storage and its Endpoint survive a same-path worktree recreation,
  // but the recreated incarnation must neither attach to the old runtime nor adopt the old store.
  it('W06_same_path_recreation_external_storage_must_not_reattach_or_reuse_old_incarnation', { timeout: 150_000 }, async (ctx) => {
    const set = await worktreeSet((note) => ctx.skip(note));
    const storage = join(dirname(set.primary), 'external-storage');
    const env = { NEXUS_STORAGE_ROOT_DIR: storage, NEXUS_STORAGE_METADATA_DB_PATH: join(storage, 'metadata.db'),
      NEXUS_STORAGE_VECTOR_DB_PATH: join(storage, 'vectors') };
    await writeOld(set.linkedA);
    const oldBridge = startBridge(set.linkedA, env);
    await sendRequest(oldBridge, initializeRequest, 1);
    const old = await endpointOf(storage);
    detachedManagedPids.push(old.pid);
    expect(old.worktreeWitness).toMatch(/^[0-9a-f]{64}$/);
    await stopBridge(oldBridge);
    const claimBefore = await readFile(join(storage, DIRECTORY_CLAIM_FILENAME));
    const endpointBefore = await readFile(join(storage, 'endpoint.json'));
    await recreateWorktree(set, set.linkedA, set.linkedA);
    await writeNew(set.linkedA);
    // W06-A: the old runtime is alive; the recreated incarnation's Bridge must not attach to it.
    const reattached = startBridge(set.linkedA, env);
    const attachOutcome = await sendRequest(reattached, initializeRequest, 1).then(() => 'connected', (error: unknown) => String(error));
    expect(attachOutcome).not.toBe('connected');
    expect(attachOutcome).toContain('worktree incarnation');
    expect(isAlive(old.pid)).toBe(true);
    expect((await readProjectEndpoint(storage))?.pid).toBe(old.pid); // Bridge never removed/replaced the old descriptor
    expect(await readFile(join(storage, 'endpoint.json'))).toEqual(endpointBefore);
    expect(await readFile(join(storage, DIRECTORY_CLAIM_FILENAME))).toEqual(claimBefore);
    await stopBridge(reattached);
    // W06-B: once the old runtime stops, the recreated incarnation is still refused and the claim stays untouched.
    process.kill(old.pid, 'SIGTERM');
    await waitForExit(old.pid);
    const blocked = startBridge(set.linkedA, env);
    const blockedOutcome = await sendRequest(blocked, initializeRequest, 1).then(() => 'connected', (error: unknown) => String(error));
    expect(blockedOutcome).not.toBe('connected');
    expect(blockedOutcome).toContain('worktree incarnation');
    expect(await readFile(join(storage, DIRECTORY_CLAIM_FILENAME))).toEqual(claimBefore);
    await stopBridge(blocked);
    // A new, empty external storage works for the recreated worktree and never serves the old incarnation.
    const storage2 = join(dirname(set.primary), 'external-storage-new');
    const env2 = { NEXUS_STORAGE_ROOT_DIR: storage2, NEXUS_STORAGE_METADATA_DB_PATH: join(storage2, 'metadata.db'),
      NEXUS_STORAGE_VECTOR_DB_PATH: join(storage2, 'vectors') };
    const bridge = startBridge(set.linkedA, env2);
    await sendRequest(bridge, initializeRequest, 1);
    const fresh = await endpointOf(storage2);
    detachedManagedPids.push(fresh.pid);
    expect(fresh.pid).not.toBe(old.pid);
    expect(await callTool(bridge, 10, 'grep_search', { pattern: NEW_SYMBOL })).toContain(NEW_FILE);
    expect(await callTool(bridge, 11, 'grep_search', { pattern: OLD_SYMBOL })).not.toContain(OLD_FILE);
  });

  // W06-C: the same worktree's Bridge reattaches to its own healthy runtime on external storage (same witness).
  it('W06_same_worktree_external_storage_bridge_reuses_own_runtime', { timeout: 90_000 }, async (ctx) => {
    const set = await worktreeSet((note) => ctx.skip(note));
    const storage = join(dirname(set.primary), 'external-storage');
    const env = { NEXUS_STORAGE_ROOT_DIR: storage, NEXUS_STORAGE_METADATA_DB_PATH: join(storage, 'metadata.db'),
      NEXUS_STORAGE_VECTOR_DB_PATH: join(storage, 'vectors') };
    const first = startBridge(set.linkedA, env);
    await sendRequest(first, initializeRequest, 1);
    const endpoint = await endpointOf(storage);
    detachedManagedPids.push(endpoint.pid);
    const witness = await readFile(join(set.linkedA, '.nexus', 'worktree-witness'));
    await stopBridge(first);
    const second = startBridge(set.linkedA, env);
    await sendRequest(second, initializeRequest, 1);
    expect((await readProjectEndpoint(storage))?.pid).toBe(endpoint.pid);
    expect(await readFile(join(set.linkedA, '.nexus', 'worktree-witness'))).toEqual(witness);
  });

  // Nexus #297: a real managed process whose writer lease is lost (lock-file inode replaced in the coordination
  // root, so /proc/locks no longer attests it) fails fast with exit status 75 within the lease polling window.
  it('lease_loss_real_managed_process_exits_75', { timeout: 60_000 }, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-auto-connector-e2e-'));
    projectRoots.push(projectRoot);
    const managed = spawn(process.execPath, nexusArgs(['--project-root', projectRoot, '--port', '0', '--managed']),
      { stdio: ['pipe', 'pipe', 'pipe'], env: nexusEnv() });
    managedProcesses.push(managed);
    let stderr = '';
    managed.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exited = once(managed, 'exit');
    await endpointOf(join(projectRoot, '.nexus'));
    const writerDir = join(coordinationRoot, 'writer');
    const locks = (await readdir(writerDir)).filter((entry) => entry.endsWith('.lock'));
    expect(locks).toHaveLength(3);
    const replacedAt = Date.now();
    for (const name of locks) {
      const replacement = join(writerDir, `${name}.replacement`);
      await writeFile(replacement, '', { mode: 0o600 });
      await rename(replacement, join(writerDir, name));
    }
    const [code] = (await exited) as [number | null];
    const elapsedMs = Date.now() - replacedAt;
    console.info(`[lease_loss] exit ${String(code)} after ${elapsedMs} ms`);
    expect(code).toBe(75);
    expect(elapsedMs).toBeLessThan(15_000); // default 5 s lease polling plus process exit
    expect(stderr).toMatch(/lease/i);
  });

  // Nexus #297: after a crash the kernel writer lease is released (admission succeeds), but the pre-existing
  // mtime-based project lock on storage.rootDir still refuses an immediate successor until its stale window passes.
  it('crash_leaves_project_lock_refusing_an_immediate_successor', { timeout: 60_000 }, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'nexus-auto-connector-e2e-'));
    projectRoots.push(projectRoot);
    const args = nexusArgs(['--project-root', projectRoot, '--port', '0', '--managed']);
    const first = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: nexusEnv() });
    managedProcesses.push(first);
    await endpointOf(join(projectRoot, '.nexus'));
    first.kill('SIGKILL');
    await once(first, 'exit');
    const successor = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: nexusEnv() });
    managedProcesses.push(successor);
    let stderr = '';
    successor.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const [code] = (await once(successor, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(stderr).toContain('Another Nexus process is already running');
    expect(stderr).not.toContain('writer_busy');
    expect(stderr).not.toContain('owner_');
  });
});
