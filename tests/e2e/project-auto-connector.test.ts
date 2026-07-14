import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readProjectEndpoint } from '../../src/server/project-endpoint.js';

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
        try {
          const message: unknown = JSON.parse(line);
          if (
            typeof message === 'object' &&
            message !== null &&
            'id' in message &&
            message.id === responseId &&
            'result' in message
          ) {
            bridge.stdout.off('data', onData);
            bridge.stderr.off('data', onError);
            resolve();
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
});
