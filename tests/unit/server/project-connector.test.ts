import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

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
  return {
    unref: vi.fn(),
  } as unknown as FakeChildProcess;
}

function createHarness() {
  const fetchImpl = vi.fn<(_url: string) => Promise<Response>>();
  const spawnImpl = vi.fn<(_exec: string, _args: readonly string[], _options: object) => ChildProcess>();

  return { fetchImpl, spawnImpl };
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
    expect(harness.fetchImpl).toHaveBeenCalledWith(new URL('/health', endpoint.url).toString());
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

    // Make the storage directory unreadable so lock acquisition fails with
    // a filesystem error rather than ELOCKED.
    await chmod(storageDir, 0o000);

    try {
      await expect(ensureProjectEndpoint(options)).rejects.toThrow();
      expect(harness.spawnImpl).not.toHaveBeenCalled();
    } finally {
      await chmod(storageDir, 0o755);
    }
  });
});
