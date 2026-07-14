import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  ensureProjectEndpoint,
  type ProjectConnectorOptions,
} from '../../../src/server/project-connector.js';
import {
  readProjectEndpoint,
  writeProjectEndpoint,
  type ProjectEndpoint,
} from '../../../src/server/project-endpoint.js';

interface FakeChildProcess extends ChildProcess {
  unref: ReturnType<typeof vi.fn>;
}

function createFakeChildProcess(): FakeChildProcess {
  // A real EventEmitter so production code can safely register `error`/`exit`
  // listeners on it (mirrors the real ChildProcess API), while still letting
  // tests that never emit those events behave exactly as before.
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    unref: vi.fn(),
  }) as unknown as FakeChildProcess;
}

function createHarness() {
  const fetchImpl = vi.fn<(_url: string) => Promise<Response>>();
  const spawnImpl = vi.fn<(_exec: string, _args: readonly string[], _options: object) => ChildProcess>();

  return { fetchImpl, spawnImpl };
}

async function waitForSpawnCall(spawnImpl: ReturnType<typeof createHarness>['spawnImpl']): Promise<void> {
  while (spawnImpl.mock.calls.length === 0) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

describe('project-connector', () => {
  let projectRoot: string;
  let storageDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'nexus-connector-root-'));
    storageDir = join(projectRoot, '.nexus');
    await mkdir(storageDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { force: true, recursive: true });
  });

  const healthyEndpoint = (instanceId: string, port: number): ProjectEndpoint => ({
    instanceId,
    pid: process.pid,
    projectRoot,
    url: `http://127.0.0.1:${port}`,
  });

  it('reuses a healthy endpoint without spawning a child', async () => {
    const endpoint = healthyEndpoint('instance-healthy', 43123);
    await writeProjectEndpoint(storageDir, endpoint);

    const harness = createHarness();
    harness.fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ instanceId: endpoint.instanceId, projectRoot }), { status: 200 }),
    );

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: '/not-used',
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
    };

    const url = await ensureProjectEndpoint(options);

    expect(url.href).toBe(`${endpoint.url}/`);
    expect(harness.spawnImpl).not.toHaveBeenCalled();
    expect(harness.fetchImpl).toHaveBeenCalledWith(
      new URL('/health', endpoint.url).toString(),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('spawns once when two connectors race without an endpoint', async () => {
    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43124;
    let spawnCount = 0;

    harness.spawnImpl.mockImplementation((_exec: string, _args: readonly string[], _options: object) => {
      spawnCount += 1;
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });

    harness.fetchImpl.mockImplementation(async (url: string) => {
      const endpoint = await readProjectEndpoint(storageDir);
      if (endpoint !== undefined && url === new URL('/health', endpoint.url).toString()) {
        return new Response(JSON.stringify({ instanceId: endpoint.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2000,
      pollIntervalMs: 25,
    };

    const [first, second] = await Promise.all([
      ensureProjectEndpoint(options),
      ensureProjectEndpoint(options),
    ]);

    expect(first.href).toBe(second.href);
    expect(spawnCount).toBe(1);
  });

  it('creates a missing storage directory before acquiring the startup lock', async () => {
    await rm(storageDir, { force: true, recursive: true });
    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43125;
    harness.spawnImpl.mockImplementation((_exec: string, _args: readonly string[], _options: object) => {
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });
    harness.fetchImpl.mockImplementation(async (url: string) => {
      const endpoint = await readProjectEndpoint(storageDir);
      if (endpoint !== undefined && url === new URL('/health', endpoint.url).toString()) {
        return new Response(JSON.stringify({ instanceId: endpoint.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const url = await ensureProjectEndpoint({
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 25,
    });

    expect(url.port).toBe(String(port));
    expect(harness.spawnImpl).toHaveBeenCalledOnce();
  });

  it('reuses the endpoint published by an actual managed child process', async () => {
    const childScript = join(projectRoot, 'managed-child.mjs');
    await writeFile(
      childScript,
      [
        `#!${process.execPath}`,
        "import { createServer } from 'node:http';",
        "import { writeFile } from 'node:fs/promises';",
        "import { join } from 'node:path';",
        "const rootIndex = process.argv.indexOf('--project-root');",
        "const projectRoot = process.argv[rootIndex + 1];",
        "const storageDir = process.env.NEXUS_TEST_STORAGE_DIR;",
        "if (projectRoot === undefined || storageDir === undefined) process.exit(1);",
        "const server = createServer((request, response) => {",
        "  if (request.url === '/health') {",
        "    response.end(JSON.stringify({ instanceId: 'child-instance', projectRoot }));",
        "    return;",
        "  }",
        "  response.statusCode = 404;",
        "  response.end();",
        "});",
        "server.listen(0, '127.0.0.1', async () => {",
        "  const address = server.address();",
        "  if (address === null || typeof address === 'string') process.exit(1);",
        "  await writeFile(join(storageDir, 'endpoint.json'), JSON.stringify({",
        "    instanceId: 'child-instance', pid: process.pid, projectRoot,",
        "    url: `http://127.0.0.1:${address.port}`",
        "  }));",
        "});",
      ].join('\n'),
    );
    await chmod(childScript, 0o755);

    let child: ChildProcess | undefined;
    const spawnChild = (...args: Parameters<typeof spawn>): ChildProcess => {
      child = spawn(...args);
      return child;
    };
    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: childScript,
      env: { NEXUS_TEST_STORAGE_DIR: storageDir },
      spawn: spawnChild,
      fetch: globalThis.fetch,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 25,
    };

    try {
      const [first, second] = await Promise.all([
        ensureProjectEndpoint(options),
        ensureProjectEndpoint(options),
      ]);

      expect(first.href).toBe(second.href);
      expect(await readProjectEndpoint(storageDir)).toMatchObject({
        instanceId: 'child-instance',
        projectRoot,
      });
    } finally {
      child?.kill();
    }
  });

  it('removes a stale descriptor whose health check fails and spawns a new child', async () => {
    const staleEndpoint = healthyEndpoint('instance-stale', 43125);
    await writeProjectEndpoint(storageDir, staleEndpoint);

    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43126;

    harness.fetchImpl.mockImplementation(async (url: string) => {
      const endpoint = await readProjectEndpoint(storageDir);
      if (endpoint !== undefined && url === new URL('/health', endpoint.url).toString()) {
        if (endpoint.instanceId === staleEndpoint.instanceId) {
          return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify({ instanceId: endpoint.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    harness.spawnImpl.mockImplementation((_exec: string, _args: readonly string[], _options: object) => {
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2000,
      pollIntervalMs: 25,
    };

    const url = await ensureProjectEndpoint(options);

    expect(url.port).toBe(String(port));
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(await readProjectEndpoint(storageDir)).toMatchObject({ instanceId });
  });

  it('rejects a localhost descriptor and spawns a loopback-managed child', async () => {
    const endpoint: ProjectEndpoint = {
      instanceId: 'instance-localhost',
      pid: process.pid,
      projectRoot,
      url: 'http://localhost:43127',
    };
    await writeProjectEndpoint(storageDir, endpoint);

    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43130;
    harness.spawnImpl.mockImplementation((_exec: string, _args: readonly string[], _options: object) => {
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });
    harness.fetchImpl.mockImplementation(async (url: string) => {
      const current = await readProjectEndpoint(storageDir);
      if (current !== undefined && url === new URL('/health', current.url).toString()) {
        return new Response(JSON.stringify({ instanceId: current.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const url = await ensureProjectEndpoint({
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2000,
      pollIntervalMs: 25,
    });

    expect(url.port).toBe(String(port));
    expect(harness.spawnImpl).toHaveBeenCalledOnce();
  });

  it('throws when no healthy endpoint appears within the startup timeout', async () => {
    const harness = createHarness();
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));
    harness.spawnImpl.mockImplementation(() => createFakeChildProcess());

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 150,
      pollIntervalMs: 25,
    };

    await expect(ensureProjectEndpoint(options)).rejects.toThrow(
      'Timed out waiting for a healthy project endpoint',
    );
  });

  it('rejects immediately when the spawned child reports an error instead of waiting for the startup timeout', async () => {
    const harness = createHarness();
    let fakeChild: FakeChildProcess | undefined;
    harness.spawnImpl.mockImplementation(() => {
      fakeChild = createFakeChildProcess();
      return fakeChild;
    });
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: '/does/not/exist',
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      // Much longer than the spawn failure below, so a passing test proves
      // the rejection came from the child's `error` event rather than from
      // the startup timeout elapsing.
      startupTimeoutMs: 60_000,
      pollIntervalMs: 25,
    };

    const pending = ensureProjectEndpoint(options);
    await waitForSpawnCall(harness.spawnImpl);
    fakeChild!.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(pending).rejects.toThrow('spawn ENOENT');
  });

  it('rejects immediately when the spawned child exits before publishing a healthy endpoint', async () => {
    const harness = createHarness();
    let fakeChild: FakeChildProcess | undefined;
    harness.spawnImpl.mockImplementation(() => {
      fakeChild = createFakeChildProcess();
      return fakeChild;
    });
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 60_000,
      pollIntervalMs: 25,
    };

    const pending = ensureProjectEndpoint(options);
    await waitForSpawnCall(harness.spawnImpl);
    fakeChild!.emit('exit', 1, null);

    await expect(pending).rejects.toThrow(
      'Managed nexus child exited before publishing a healthy endpoint (code=1, signal=null)',
    );
  });

  it('spawns a new child when the descriptor projectRoot does not match', async () => {
    const endpoint: ProjectEndpoint = {
      instanceId: 'instance-root-mismatch',
      pid: process.pid,
      projectRoot: '/other/project',
      url: 'http://127.0.0.1:43127',
    };
    await writeProjectEndpoint(storageDir, endpoint);

    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43130;

    harness.fetchImpl.mockImplementation(async (url: string) => {
      const current = await readProjectEndpoint(storageDir);
      if (current !== undefined && url === new URL('/health', current.url).toString()) {
        return new Response(JSON.stringify({ instanceId: current.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    harness.spawnImpl.mockImplementation((_exec: string, _args: readonly string[], _options: object) => {
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2000,
      pollIntervalMs: 25,
    };

    const url = await ensureProjectEndpoint(options);

    expect(url.port).toBe(String(port));
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(await readProjectEndpoint(storageDir)).toMatchObject({ instanceId, projectRoot });
  });

  it('spawns a new child when the descriptor health instanceId does not match', async () => {
    const endpoint = healthyEndpoint('instance-a', 43128);
    await writeProjectEndpoint(storageDir, endpoint);

    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43131;

    harness.fetchImpl.mockImplementation(async (url: string) => {
      const current = await readProjectEndpoint(storageDir);
      if (current !== undefined && url === new URL('/health', current.url).toString()) {
        if (current.instanceId === endpoint.instanceId) {
          return new Response(JSON.stringify({ instanceId: 'instance-b', projectRoot }), { status: 200 });
        }
        return new Response(JSON.stringify({ instanceId: current.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    harness.spawnImpl.mockImplementation((_exec: string, _args: readonly string[], _options: object) => {
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: process.execPath,
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2000,
      pollIntervalMs: 25,
    };

    const url = await ensureProjectEndpoint(options);

    expect(url.port).toBe(String(port));
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(await readProjectEndpoint(storageDir)).toMatchObject({ instanceId, projectRoot });
  });

  it('rejects invalid startupTimeoutMs before attempting work', async () => {
    const harness = createHarness();
    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: '/not-used',
      env: {},
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: Number.NaN,
    };

    await expect(ensureProjectEndpoint(options)).rejects.toThrow(
      'startupTimeoutMs must be a finite, positive number',
    );
    expect(harness.spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns the provided child executable with managed mode arguments', async () => {
    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const port = 43129;

    harness.spawnImpl.mockImplementation((exec: string, args: readonly string[], options: object) => {
      expect(exec).toBe('/test/nexus.js');
      expect(args).toEqual([
        '--project-root',
        projectRoot,
        '--port',
        '0',
        '--managed',
      ]);
      expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
      setTimeout(() => {
        void writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      }, 25);
      return createFakeChildProcess();
    });

    harness.fetchImpl.mockImplementation(async (url: string) => {
      const endpoint = await readProjectEndpoint(storageDir);
      if (endpoint !== undefined && url === new URL('/health', endpoint.url).toString()) {
        return new Response(JSON.stringify({ instanceId: endpoint.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const options: ProjectConnectorOptions = {
      projectRoot,
      storageDir,
      childExecutable: '/test/nexus.js',
      env: { NEXUS_FOO: 'bar' },
      spawn: harness.spawnImpl,
      fetch: harness.fetchImpl,
      startupTimeoutMs: 2000,
      pollIntervalMs: 25,
    };

    await ensureProjectEndpoint(options);
  });

  it('rethrows filesystem errors from the startup lock acquisition', async () => {
    // Simulate a filesystem error surfacing from the startup lock
    // acquisition path (e.g. a permission-denied realpath() or lockfile
    // write) deterministically, via a scoped module mock, rather than
    // relying on chmod(storageDir, 0o000). chmod-based permission denial
    // does not reliably fail when tests run as root (common in CI
    // containers) or on Windows, which made this test flaky.
    vi.resetModules();
    const fsError = Object.assign(new Error('Simulated filesystem failure'), { code: 'EACCES' });

    vi.doMock('../../../src/utils/global-lock.js', () => ({
      acquireGlobalLock: vi.fn().mockRejectedValue(fsError),
      GlobalLockHeldError: class GlobalLockHeldError extends Error {},
      projectStartupLockName: vi.fn().mockResolvedValue('mocked-lock-name'),
    }));

    try {
      const { ensureProjectEndpoint: isolatedEnsureProjectEndpoint } = await import(
        '../../../src/server/project-connector.js'
      );

      const harness = createHarness();
      const options: ProjectConnectorOptions = {
        projectRoot,
        storageDir,
        childExecutable: '/not-used',
        env: {},
        spawn: harness.spawnImpl,
        fetch: harness.fetchImpl,
        startupTimeoutMs: 150,
        pollIntervalMs: 25,
      };

      await expect(isolatedEnsureProjectEndpoint(options)).rejects.toBe(fsError);
      expect(harness.spawnImpl).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../../src/utils/global-lock.js');
      vi.resetModules();
    }
  });
});
