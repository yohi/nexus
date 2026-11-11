import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

import { loadConfig } from '../../../src/config/index.js';
import {
  ensureProjectEndpoint,
  type ProjectConnectorOptions,
} from '../../../src/server/project-connector.js';
import {
  PROJECT_ENDPOINT_FILENAME,
  readProjectEndpoint,
  writeProjectEndpoint,
  type ProjectEndpoint,
} from '../../../src/server/project-endpoint.js';
import {
  admitStorageWriter,
  assertExpectedStorageTargetsFingerprint,
  INTERNAL_TARGETS_FINGERPRINT_ENV,
  openBridgeStartupCoordination,
  resolveStorageOwnershipTargets,
  STARTUP_LOGS_DIR,
  storageTargetsFingerprint,
  type ResolvedStorageOwnershipTargets,
} from '../../../src/server/storage-ownership/index.js';
import { testCoordinationRoot } from '../../shared/storage-ownership-coordination-setup.js';

interface FakeChildProcess extends ChildProcess {
  unref: ReturnType<typeof vi.fn>;
  stdout: Readable | null;
  stderr: Readable | null;
}

function createFakeChildProcess(): FakeChildProcess {
  // A real EventEmitter so production code can safely register `error`/`close`
  // listeners on it (mirrors the real ChildProcess API).
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    unref: vi.fn(),
    stdout: null,
    stderr: null,
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

const spawnEnv = (options: object): Record<string, string> => (options as { env: Record<string, string> }).env;
const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/** Byte-level snapshot of a directory tree (absent -> 'absent'). */
async function snapshot(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    let info;
    try { info = await lstat(current); } catch { out[current] = 'absent'; return; }
    if (info.isDirectory()) {
      out[`${current}/`] = 'dir';
      for (const entry of (await readdir(current)).sort()) await walk(join(current, entry));
    } else {
      out[current] = await readFile(current, 'utf8');
    }
  };
  await walk(path);
  return out;
}

describe('project-connector', () => {
  let projectRoot: string;
  let storageDir: string;
  let targets: ResolvedStorageOwnershipTargets;
  let fingerprint: string;

  beforeEach(async () => {
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'nexus-connector-root-')));
    storageDir = join(projectRoot, '.nexus');
    targets = await resolveStorageOwnershipTargets(await loadConfig({ projectRoot, env: {} }));
    fingerprint = storageTargetsFingerprint(targets);
  });

  afterEach(async () => {
    await rm(projectRoot, { force: true, recursive: true });
  });

  /** What an admitted managed child does before publishing: claim the full target set (then release here). */
  const claimStorage = async (): Promise<void> => {
    const admission = await admitStorageWriter(targets);
    await admission.release();
  };

  /** `fp: null` builds a legacy descriptor without the internal fingerprint. */
  const healthyEndpoint = (instanceId: string, port: number, fp: string | null = fingerprint): ProjectEndpoint => ({
    instanceId,
    pid: process.pid,
    projectRoot,
    url: `http://127.0.0.1:${port}`,
    ...(fp === null ? {} : { storageTargetsFingerprint: fp }),
  });

  const baseOptions = (
    harness: ReturnType<typeof createHarness>,
    overrides: Partial<ProjectConnectorOptions> = {},
  ): ProjectConnectorOptions => ({
    projectRoot,
    storageDir,
    storageOwnershipTargets: targets,
    childExecutable: process.execPath,
    env: {},
    spawn: harness.spawnImpl,
    fetch: harness.fetchImpl,
    startupTimeoutMs: 2_000,
    pollIntervalMs: 25,
    ...overrides,
  });

  /** Health responder for whatever descriptor is currently published. */
  const healthFromCurrentDescriptor = (harness: ReturnType<typeof createHarness>, unhealthyInstance?: string): void => {
    harness.fetchImpl.mockImplementation(async (url: string) => {
      const current = await readProjectEndpoint(storageDir);
      if (current !== undefined && url === new URL('/health', current.url).toString() && current.instanceId !== unhealthyInstance) {
        return new Response(JSON.stringify({ instanceId: current.instanceId, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
  };

  /** Fake managed child: admits (claims) and then publishes its own fingerprinted Endpoint. */
  const admittedChild = (harness: ReturnType<typeof createHarness>, instanceId: string, port: number, onSpawn?: () => Promise<void> | void): void => {
    harness.spawnImpl.mockImplementation(() => {
      void (async () => {
        await onSpawn?.();
        await claimStorage();
        await writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, port));
      })();
      return createFakeChildProcess();
    });
  };

  it('same_owner_healthy_endpoint_reused', async () => {
    await claimStorage();
    const endpoint = healthyEndpoint('instance-healthy', 43123);
    await writeProjectEndpoint(storageDir, endpoint);

    const harness = createHarness();
    harness.fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ instanceId: endpoint.instanceId, projectRoot }), { status: 200 }),
    );

    const url = await ensureProjectEndpoint(baseOptions(harness, { childExecutable: '/not-used' }));

    expect(url.href).toBe(`${endpoint.url}/`);
    expect(harness.spawnImpl).not.toHaveBeenCalled();
    expect(harness.fetchImpl).toHaveBeenCalledWith(
      new URL('/health', endpoint.url).toString(),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('S13_internal_endpoint_fingerprint_prevents_wrong_reuse', async () => {
    await claimStorage();
    const memoryTargets = await resolveStorageOwnershipTargets(
      await loadConfig({ projectRoot, env: { NEXUS_STORAGE_VECTOR_DB_PATH: 'memory://' } }),
    );
    const wrongFingerprint = storageTargetsFingerprint(memoryTargets);
    expect(wrongFingerprint).not.toBe(fingerprint);

    for (const stale of [healthyEndpoint('instance-other-targets', 43140, wrongFingerprint), healthyEndpoint('instance-legacy', 43141, null)]) {
      await writeProjectEndpoint(storageDir, stale);
      const harness = createHarness();
      healthFromCurrentDescriptor(harness);
      const instanceId = `instance-${randomUUID()}`;
      admittedChild(harness, instanceId, 43142);

      const url = await ensureProjectEndpoint(baseOptions(harness));

      expect(url.port).toBe('43142');
      expect(harness.spawnImpl).toHaveBeenCalledOnce();
    }
  });

  it('W06_external_storage_endpoint_is_reused_only_with_the_current_worktree_witness', async () => {
    const external = await realpath(await mkdtemp(join(tmpdir(), 'nexus-connector-external-')));
    try {
      const externalTargets = await resolveStorageOwnershipTargets(await loadConfig({ projectRoot, env: {
        NEXUS_STORAGE_ROOT_DIR: external, NEXUS_STORAGE_METADATA_DB_PATH: join(external, 'metadata.db'),
        NEXUS_STORAGE_VECTOR_DB_PATH: join(external, 'vectors'),
      } }));
      const admission = await admitStorageWriter(externalTargets);
      const witness = admission.worktreeWitness;
      await admission.release();
      expect(witness).toMatch(/^[0-9a-f]{64}$/);
      const externalOptions = (harness: ReturnType<typeof createHarness>): ProjectConnectorOptions =>
        baseOptions(harness, { storageDir: external, storageOwnershipTargets: externalTargets, startupTimeoutMs: 300 });
      const publish = (worktreeWitness: string | undefined): Promise<void> => writeProjectEndpoint(external, {
        ...healthyEndpoint('instance-external', 43150, storageTargetsFingerprint(externalTargets)),
        ...(worktreeWitness === undefined ? {} : { worktreeWitness }),
      });
      const healthy = (harness: ReturnType<typeof createHarness>): void => {
        harness.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ instanceId: 'instance-external', projectRoot }), { status: 200 }));
      };

      await publish(witness);
      const reuse = createHarness();
      healthy(reuse);
      expect((await ensureProjectEndpoint(externalOptions(reuse))).port).toBe('43150');
      expect(reuse.spawnImpl).not.toHaveBeenCalled();

      // A descriptor from another incarnation, or one without a witness, is never reused and never removed.
      for (const foreign of ['e'.repeat(64), undefined]) {
        await publish(foreign);
        const before = await snapshot(external);
        const harness = createHarness();
        healthy(harness);
        await expect(ensureProjectEndpoint(externalOptions(harness))).rejects.toThrow();
        expect(await snapshot(external)).toEqual(before);
      }
    } finally {
      await rm(external, { force: true, recursive: true });
    }
  });

  it('spawns once when two connectors race without an endpoint', async () => {
    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    let spawnCount = 0;
    harness.spawnImpl.mockImplementation(() => {
      spawnCount += 1;
      setTimeout(() => {
        void (async () => {
          await claimStorage();
          await writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, 43124));
        })();
      }, 25);
      return createFakeChildProcess();
    });
    healthFromCurrentDescriptor(harness);

    const options = baseOptions(harness);
    const [first, second] = await Promise.all([ensureProjectEndpoint(options), ensureProjectEndpoint(options)]);

    expect(first.href).toBe(second.href);
    expect(spawnCount).toBe(1);
  });

  it('S13_absent_storage_dir_uses_external_startup_gate', async () => {
    expect(await exists(storageDir)).toBe(false);
    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    const coordination = await openBridgeStartupCoordination(targets);
    const atSpawn: { storageExists?: boolean; gateHeldByBridge?: boolean } = {};
    admittedChild(harness, instanceId, 43125, async () => {
      atSpawn.storageExists = await exists(storageDir);
      const probe = coordination.tryAcquireGate();
      atSpawn.gateHeldByBridge = probe === null;
      probe?.release();
    });
    healthFromCurrentDescriptor(harness);

    const url = await ensureProjectEndpoint(baseOptions(harness));

    expect(url.port).toBe('43125');
    expect(atSpawn).toEqual({ storageExists: false, gateHeldByBridge: true });
    expect(coordination.gatePath.startsWith(join(testCoordinationRoot(), 'startup'))).toBe(true);
    // Released after the verified healthy endpoint.
    const after = coordination.tryAcquireGate();
    expect(after).not.toBeNull();
    after?.release();
  });

  it('S13_bridge_never_mutates_unclaimed_storage', async () => {
    // Unclaimed, non-empty Storage Root (someone else's bytes): preflight refuses, nothing is spawned or touched.
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, 'foreign-data.bin'), 'foreign');
    await writeFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), JSON.stringify(healthyEndpoint('foreign', 9, null)));
    const before = await snapshot(storageDir);
    const harness = createHarness();
    harness.fetchImpl.mockRejectedValue(new Error('no network'));

    await expect(ensureProjectEndpoint(baseOptions(harness))).rejects.toThrow(/preflight refused/);
    expect(harness.spawnImpl).not.toHaveBeenCalled();
    expect(await snapshot(storageDir)).toEqual(before);

    // Absent Storage Root + a child that never starts: the Bridge itself still creates nothing under Storage.
    await rm(storageDir, { recursive: true });
    const failing = createHarness();
    failing.spawnImpl.mockImplementation(() => {
      const child = createFakeChildProcess();
      setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    });
    await expect(ensureProjectEndpoint(baseOptions(failing))).rejects.toThrow('spawn ENOENT');
    expect(await exists(storageDir)).toBe(false);
  });

  it('S13_foreign_endpoint_not_deleted', async () => {
    await claimStorage();
    const foreign: ProjectEndpoint = {
      instanceId: 'instance-root-mismatch', pid: process.pid, projectRoot: '/other/project', url: 'http://127.0.0.1:43127',
      storageTargetsFingerprint: fingerprint,
    };
    await writeProjectEndpoint(storageDir, foreign);
    const foreignBytes = await readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8');

    const harness = createHarness();
    healthFromCurrentDescriptor(harness);
    let bytesAtSpawn: string | undefined;
    const child = createFakeChildProcess();
    harness.spawnImpl.mockImplementation(() => {
      void readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8').then((bytes) => {
        bytesAtSpawn = bytes;
        child.emit('close', 1, null); // the admitted child refuses a foreign descriptor
      });
      return child;
    });

    await expect(ensureProjectEndpoint(baseOptions(harness))).rejects.toThrow('Managed nexus child exited');
    expect(bytesAtSpawn).toBe(foreignBytes);
    expect(await readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8')).toBe(foreignBytes);
  });

  it('same_owner_stale_endpoint_cleanup_is_child_writer_only', async () => {
    await claimStorage();
    const staleEndpoint = healthyEndpoint('instance-stale', 43125);
    await writeProjectEndpoint(storageDir, staleEndpoint);
    const staleBytes = await readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8');

    const harness = createHarness();
    healthFromCurrentDescriptor(harness, staleEndpoint.instanceId);
    const instanceId = `instance-${randomUUID()}`;
    let bytesAtSpawn: string | undefined;
    // The admitted child (not the Bridge) replaces the stale same-owner descriptor.
    admittedChild(harness, instanceId, 43126, async () => {
      bytesAtSpawn = await readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8');
    });

    const url = await ensureProjectEndpoint(baseOptions(harness));

    expect(url.port).toBe('43126');
    expect(bytesAtSpawn).toBe(staleBytes);
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(await readProjectEndpoint(storageDir)).toMatchObject({ instanceId });
  });

  it('S13_timeout_does_not_cleanup_foreign_descriptor', async () => {
    await claimStorage();
    const foreign: ProjectEndpoint = {
      instanceId: 'foreign-instance', pid: 2_147_483_000, projectRoot: '/other/project', url: 'http://127.0.0.1:9/',
    };
    await writeProjectEndpoint(storageDir, foreign);
    const foreignBytes = await readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8');
    const harness = createHarness();
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));
    let env: Record<string, string> = {};
    harness.spawnImpl.mockImplementation((_exec, _args, options) => {
      env = spawnEnv(options);
      return createFakeChildProcess(); // never becomes healthy, never exits
    });

    await expect(ensureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: 150 }))).rejects.toThrow(
      'Timed out waiting for a healthy project endpoint',
    );
    expect(await readFile(join(storageDir, PROJECT_ENDPOINT_FILENAME), 'utf8')).toBe(foreignBytes);
    // Liveness is uncertain after a timeout: the attempt logs are retained, not deleted.
    expect(await exists(env.NEXUS_STARTUP_STDOUT_LOG!)).toBe(true);
    expect(await exists(env.NEXUS_STARTUP_STDERR_LOG!)).toBe(true);
  });

  it('S13_attempt_logs_live_outside_storage_and_are_owner_cleaned', async () => {
    const logsDir = join(testCoordinationRoot(), STARTUP_LOGS_DIR);
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const unrelated = join(logsDir, `${'f'.repeat(32)}-stderr.log`);
    await writeFile(unrelated, 'another attempt', { mode: 0o600 });

    const harness = createHarness();
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));
    let fakeChild: FakeChildProcess | undefined;
    let env: Record<string, string> = {};
    harness.spawnImpl.mockImplementation((_exec, _args, options) => {
      env = spawnEnv(options);
      fakeChild = createFakeChildProcess();
      return fakeChild;
    });

    const pending = ensureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: 60_000 }));
    await waitForSpawnCall(harness.spawnImpl);
    const stdoutLog = env.NEXUS_STARTUP_STDOUT_LOG!;
    const stderrLog = env.NEXUS_STARTUP_STDERR_LOG!;
    for (const log of [stdoutLog, stderrLog]) {
      expect(log.startsWith(`${logsDir}/`)).toBe(true);
      expect(log.startsWith(storageDir)).toBe(false);
      expect(log).toMatch(/\/[0-9a-f]{32}-(stdout|stderr)\.log$/);
      expect((await stat(log)).mode & 0o777).toBe(0o600);
    }
    expect(stdoutLog.slice(0, -'-stdout.log'.length)).toBe(stderrLog.slice(0, -'-stderr.log'.length));
    expect(await exists(storageDir)).toBe(false);
    await writeFile(stderrLog, 'refused before admission\n', { flag: 'a' });
    fakeChild!.emit('close', 1, null);

    await expect(pending).rejects.toThrow('Child stderr:\nrefused before admission');
    // Definite outcome: only this attempt's token-owned logs are removed.
    expect(await exists(stdoutLog)).toBe(false);
    expect(await exists(stderrLog)).toBe(false);
    expect(await readFile(unrelated, 'utf8')).toBe('another attempt');
  });

  it('S13_child_revalidates_config_change', async () => {
    const harness = createHarness();
    let env: Record<string, string> = {};
    harness.spawnImpl.mockImplementation((_exec, _args, options) => {
      env = spawnEnv(options);
      const child = createFakeChildProcess();
      setImmediate(() => child.emit('close', 1, null));
      return child;
    });
    await expect(ensureProjectEndpoint(baseOptions(harness, { env: { [INTERNAL_TARGETS_FINGERPRINT_ENV]: 'spoofed' } })))
      .rejects.toThrow('Managed nexus child exited');
    // The Bridge hands the fingerprint of exactly the targets it inspected to the child (internal spawn channel).
    expect(env[INTERNAL_TARGETS_FINGERPRINT_ENV]).toBe(fingerprint);

    // The child re-resolves its own effective config: a changed config (here the vector target) refuses before
    // admission; a match authorizes nothing by itself.
    const changed = await resolveStorageOwnershipTargets(
      await loadConfig({ projectRoot, env: { NEXUS_STORAGE_VECTOR_DB_PATH: join(projectRoot, 'other-vectors') } }),
    );
    expect(() => assertExpectedStorageTargetsFingerprint(storageTargetsFingerprint(changed), fingerprint))
      .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
    expect(() => assertExpectedStorageTargetsFingerprint(fingerprint, fingerprint)).not.toThrow();
    expect(() => assertExpectedStorageTargetsFingerprint(fingerprint, undefined)).not.toThrow();
  });

  it('rejects options whose storage targets do not match projectRoot/storageDir', async () => {
    const harness = createHarness();
    await expect(ensureProjectEndpoint(baseOptions(harness, { storageDir: join(projectRoot, 'elsewhere') })))
      .rejects.toThrow('do not match the resolved storage ownership targets');
    expect(harness.spawnImpl).not.toHaveBeenCalled();
  });

  it('reuses the endpoint published by an actual managed child process', async () => {
    await claimStorage();
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
        `const fingerprint = process.env.${INTERNAL_TARGETS_FINGERPRINT_ENV};`,
        "if (projectRoot === undefined || storageDir === undefined || fingerprint === undefined) process.exit(1);",
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
        "    url: `http://127.0.0.1:${address.port}`, storageTargetsFingerprint: fingerprint",
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
      storageOwnershipTargets: targets,
      childExecutable: childScript,
      env: { NEXUS_TEST_STORAGE_DIR: storageDir },
      spawn: spawnChild,
      fetch: globalThis.fetch,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 25,
    };

    try {
      const [first, second] = await Promise.all([ensureProjectEndpoint(options), ensureProjectEndpoint(options)]);

      expect(first.href).toBe(second.href);
      expect(await readProjectEndpoint(storageDir)).toMatchObject({
        instanceId: 'child-instance',
        projectRoot,
        storageTargetsFingerprint: fingerprint,
      });
    } finally {
      child?.kill();
    }
  });

  it('rejects a localhost descriptor and spawns a loopback-managed child', async () => {
    await claimStorage();
    await writeProjectEndpoint(storageDir, { ...healthyEndpoint('instance-localhost', 43127), url: 'http://localhost:43127' });

    const harness = createHarness();
    admittedChild(harness, `instance-${randomUUID()}`, 43130);
    healthFromCurrentDescriptor(harness);

    const url = await ensureProjectEndpoint(baseOptions(harness));

    expect(url.port).toBe('43130');
    expect(harness.spawnImpl).toHaveBeenCalledOnce();
  });

  it('spawns a new child when the descriptor health instanceId does not match', async () => {
    await claimStorage();
    const endpoint = healthyEndpoint('instance-a', 43128);
    await writeProjectEndpoint(storageDir, endpoint);

    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    harness.fetchImpl.mockImplementation(async (url: string) => {
      const current = await readProjectEndpoint(storageDir);
      if (current !== undefined && url === new URL('/health', current.url).toString()) {
        const reported = current.instanceId === endpoint.instanceId ? 'instance-b' : current.instanceId;
        return new Response(JSON.stringify({ instanceId: reported, projectRoot }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    admittedChild(harness, instanceId, 43131);

    const url = await ensureProjectEndpoint(baseOptions(harness));

    expect(url.port).toBe('43131');
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1);
    expect(await readProjectEndpoint(storageDir)).toMatchObject({ instanceId, projectRoot });
  });

  it('rejects immediately when the spawned child reports an error instead of waiting for the startup timeout', async () => {
    const harness = createHarness();
    let fakeChild: FakeChildProcess | undefined;
    harness.spawnImpl.mockImplementation(() => {
      fakeChild = createFakeChildProcess();
      return fakeChild;
    });
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));

    // Much longer than the spawn failure below, so a passing test proves the rejection came from the child's
    // `error` event rather than from the startup timeout elapsing.
    const pending = ensureProjectEndpoint(baseOptions(harness, { childExecutable: '/does/not/exist', startupTimeoutMs: 60_000 }));
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

    const pending = ensureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: 60_000 }));
    await waitForSpawnCall(harness.spawnImpl);
    fakeChild!.emit('exit', 1, null);
    fakeChild!.emit('close', 1, null);
    await expect(pending).rejects.toThrow(
      'Managed nexus child exited before publishing a healthy endpoint (code=1, signal=null)',
    );
  });

  it('includes captured child output when the child exits before publishing a healthy endpoint', async () => {
    const harness = createHarness();
    let fakeChild: FakeChildProcess | undefined;
    let env: Record<string, string> = {};
    harness.spawnImpl.mockImplementation((_exec, _args, options) => {
      fakeChild = createFakeChildProcess();
      env = spawnEnv(options);
      return fakeChild;
    });
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));

    const pending = ensureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: 60_000 }));
    await waitForSpawnCall(harness.spawnImpl);
    const stdoutLog = env.NEXUS_STARTUP_STDOUT_LOG!;
    const stderrLog = env.NEXUS_STARTUP_STDERR_LOG!;
    await writeFile(stderrLog, 'already running\n');
    await writeFile(stdoutLog, 'ignored stdout\n');
    fakeChild!.emit('exit', 1, null);
    // Verify output written between exit and close is still captured.
    await writeFile(stderrLog, 'post-exit diagnostic\n', { flag: 'a' });
    await writeFile(stdoutLog, 'post-exit stdout\n', { flag: 'a' });
    fakeChild!.emit('close', 1, null);
    await expect(pending).rejects.toThrow(
      'Managed nexus child exited before publishing a healthy endpoint (code=1, signal=null)',
    );
    await expect(pending).rejects.toThrow('Child stderr:\nalready running\npost-exit diagnostic');
    await expect(pending).rejects.toThrow('Child stdout:\nignored stdout\npost-exit stdout');
  });

  it('reports child exit even when a startup log cannot be read for a non-ENOENT reason', async () => {
    const harness = createHarness();
    let fakeChild: FakeChildProcess | undefined;
    let env: Record<string, string> = {};
    harness.spawnImpl.mockImplementation((_exec, _args, options) => {
      fakeChild = createFakeChildProcess();
      env = spawnEnv(options);
      return fakeChild;
    });
    harness.fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));

    const pending = ensureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: 60_000 }));
    await waitForSpawnCall(harness.spawnImpl);
    // Force a non-ENOENT read failure (EISDIR) on the stdout log, while stderr reads normally. Reading a startup log
    // must never throw out of the synchronous 'close' handler.
    await rm(env.NEXUS_STARTUP_STDOUT_LOG!);
    await mkdir(env.NEXUS_STARTUP_STDOUT_LOG!);
    await writeFile(env.NEXUS_STARTUP_STDERR_LOG!, 'boot failure\n');
    fakeChild!.emit('exit', 1, null);
    fakeChild!.emit('close', 1, null);

    await expect(pending).rejects.toThrow(
      'Managed nexus child exited before publishing a healthy endpoint (code=1, signal=null)',
    );
    await expect(pending).rejects.toThrow('[Unable to read stdout startup log:');
    await expect(pending).rejects.toThrow('Child stderr:\nboot failure');
  });

  it('rejects invalid startupTimeoutMs before attempting work', async () => {
    const harness = createHarness();
    await expect(ensureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: Number.NaN }))).rejects.toThrow(
      'startupTimeoutMs must be a finite, positive number',
    );
    expect(harness.spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns the provided child executable with managed mode arguments', async () => {
    const harness = createHarness();
    const instanceId = `instance-${randomUUID()}`;
    let observed: { exec: string; args: readonly string[]; options: object } | undefined;
    harness.spawnImpl.mockImplementation((exec: string, args: readonly string[], options: object) => {
      observed = { exec, args, options };
      void (async () => {
        await claimStorage();
        await writeProjectEndpoint(storageDir, healthyEndpoint(instanceId, 43129));
      })();
      return createFakeChildProcess();
    });
    healthFromCurrentDescriptor(harness);

    await ensureProjectEndpoint(baseOptions(harness, { childExecutable: '/test/nexus.js', env: { NEXUS_FOO: 'bar' } }));

    expect(observed?.exec).toBe('/test/nexus.js');
    expect(observed?.args).toEqual(['--project-root', projectRoot, '--port', '0', '--managed']);
    expect(observed?.options).toMatchObject({
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { NEXUS_FOO: 'bar', [INTERNAL_TARGETS_FINGERPRINT_ENV]: fingerprint },
    });
  });

  it('rethrows coordination failures from the startup gate without spawning', async () => {
    vi.resetModules();
    const gateError = Object.assign(new Error('Simulated coordination failure'), { code: 'lock_unavailable' });
    vi.doMock('../../../src/server/storage-ownership/startup-gate.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../src/server/storage-ownership/startup-gate.js')>()),
      openBridgeStartupCoordination: vi.fn().mockRejectedValue(gateError),
    }));

    try {
      const { ensureProjectEndpoint: isolatedEnsureProjectEndpoint } = await import(
        '../../../src/server/project-connector.js'
      );
      const harness = createHarness();
      await expect(isolatedEnsureProjectEndpoint(baseOptions(harness, { startupTimeoutMs: 150 }))).rejects.toBe(gateError);
      expect(harness.spawnImpl).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../../src/server/storage-ownership/startup-gate.js');
      vi.resetModules();
    }
  });
});
