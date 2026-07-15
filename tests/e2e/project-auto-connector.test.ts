import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readProjectEndpoint } from '../../src/server/project-endpoint.js';
import { LOCK_FILENAME } from '../../src/server/process-lock.js';

const cliPath = join(process.cwd(), 'dist', 'bin', 'nexus.js');
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

const startBridge = (projectRoot: string): ChildProcessWithoutNullStreams => {
  const bridge = spawn(process.execPath, [cliPath, 'http-bridge', '--project-root', projectRoot], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  bridges.push(bridge);
  return bridge;
};

const sendRequest = async (
  bridge: ChildProcessWithoutNullStreams,
  request: string,
  responseId: number,
): Promise<void> => {
  let diagnostics = '';
  const response = new Promise<void>((resolve, reject) => {
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
              resolve();
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
  await Promise.race([response, exited]);
};

describe('project auto-connector CLI', () => {
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) {
      if (bridge.exitCode === null) {
        bridge.kill();
        await once(bridge, 'exit');
      }
    }
    await Promise.all(projectRoots.splice(0).map(async (projectRoot) => rm(projectRoot, { force: true, recursive: true })));
  });

  afterEach(async () => {
    for (const managed of managedProcesses.splice(0)) {
      if (managed.exitCode === null) {
        managed.kill();
        await once(managed, 'exit');
      }
    }
  });

  afterEach(async () => {
    // Detached managed children spawned indirectly through the bridge (via
    // ensureProjectEndpoint) have no local ChildProcess handle, so they must
    // be reaped by pid instead of through the `managedProcesses` array above.
    for (const pid of detachedManagedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        continue;
      }
      await waitFor(async () => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true as const;
        }
      }, 5_000).catch(() => {});
    }
  });

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
      [cliPath, '--project-root', projectRoot, '--port', '0', '--managed'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
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
});
