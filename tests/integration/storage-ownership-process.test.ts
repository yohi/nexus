import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BATCH_SIZE } from '../../src/config/index.js';
import { acquireProcessLock, LOCK_FILENAME } from '../../src/server/process-lock.js';
import { PROJECT_ENDPOINT_FILENAME } from '../../src/server/project-endpoint.js';
import { ensureProjectEndpoint } from '../../src/server/project-connector.js';
import type { SpawnFn } from '../../src/server/project-connector.js';
import { createRuntimeAssembly } from '../../src/server/runtime-assembly.js';
import type { RuntimeAssembly } from '../../src/server/runtime/assembly-types.js';
import type { Config } from '../../src/types/index.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from '../benchmarks/performance/synthetic-provider.js';

// Red collision evidence for Nexus #297. Everything lives in disposable temp directories. Each test asserts that a
// foreign owner's bytes survive a colliding startup attempt, and that the colliding attempt is refused. A failure
// here is an OBSERVED safety gap in the unchanged implementation, not a flaky test.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });

interface Targets { readonly root: string; readonly metadataDbPath: string; readonly vectorDbPath: string }

async function sandbox(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-ownership-')));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function project(base: string, name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'owner.ts'), `export const owner = '${name}';\n`);
  return root;
}

const targetsFor = (storage: string): Targets =>
  ({ root: storage, metadataDbPath: join(storage, 'metadata.db'), vectorDbPath: join(storage, 'vectors') });

function configFor(projectRoot: string, targets: Targets): Config {
  return {
    projectRoot, projectName: 'ownership-fixture', packageMode: false,
    storage: { rootDir: targets.root, metadataDbPath: targets.metadataDbPath, vectorDbPath: targets.vectorDbPath,
      batchSize: DEFAULT_BATCH_SIZE },
    embedding: syntheticEmbeddingConfig,
    indexing: { maxFileBytes: 1_048_576, maxChunkChars: 4096, chunkConcurrency: 1, embedBatchWindowSize: 16 },
    watcher: { debounceMs: 100, maxQueueSize: 10_000, fullScanThreshold: 5_000, ignorePaths: ['.git', '.nexus', 'node_modules'] },
    lsp: { enabled: false, typescript: { executable: null, args: ['--stdio'] },
      startupTimeoutMs: 10_000, requestTimeoutMs: 10_000, idleTimeoutMs: 60_000 },
  };
}

async function open(config: Config): Promise<RuntimeAssembly> {
  const assembly = await createRuntimeAssembly(config, { createEmbeddingProvider: createSyntheticProvider });
  cleanups.push(async () => { await assembly.runtime.close(); });
  return assembly;
}

/** Starts the runtime and drives a real full index so that stores are genuinely written (or refused). */
async function startAndIndex(assembly: RuntimeAssembly): Promise<void> {
  await assembly.runtime.initialize();
  await assembly.runtime.reindex(true);
  await assembly.options.pipeline.waitForActiveReindex();
  const deadline = Date.now() + 30_000;
  while (assembly.options.pipeline.getProgress().status !== 'idle' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function attempt(config: Config, index = false): Promise<{ admitted: boolean; error?: unknown }> {
  try {
    const assembly = await open(config);
    if (index) await startAndIndex(assembly);
    return { admitted: true };
  } catch (error) { return { admitted: false, error }; }
}

/** Opens owner A and drives a real index so its stores hold data; A stays live (holding its locks). */
async function liveOwner(config: Config): Promise<void> {
  const assembly = await open(config);
  await startAndIndex(assembly);
}

/** Byte-level digest of every file below each path (SQLite sidecars and Lance tables included). */
async function digest(...paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    let info;
    try { info = await lstat(path); } catch { out[path] = 'absent'; return; }
    if (info.isDirectory()) {
      out[`${path}/`] = 'dir';
      for (const entry of (await readdir(path)).sort()) {
        if (entry === '.nexus-lock') continue; // lock directory carries mtime updates by design
        await walk(join(path, entry));
      }
    } else if (info.isSymbolicLink()) out[path] = 'symlink';
    else out[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  };
  for (const path of paths) await walk(path);
  return out;
}

const foreignEndpoint = (projectRoot: string, pid: number) =>
  `${JSON.stringify({ instanceId: 'foreign-instance', pid, projectRoot, url: 'http://127.0.0.1:9/' })}\n`;
const DEAD_PID = 2_147_483_000;

describe('storage ownership collisions (red evidence against unchanged implementation)', () => {
  // CONTROL, not a red gap: the pre-existing proper-lockfile project lock on rootDir already refuses a second owner of
  // the same root. The foreign endpoint.json/nexus.pid below are test-seeded bytes (assembly itself never writes them),
  // so this passes because of the lock, not because of ownership logic. The red S01 cases are the two stale-foreign
  // descriptor/PID tests that follow.
  it('S01_red_shared_root', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const shared = targetsFor(join(base, 'shared-storage'));
    const a = await attempt(configFor(rootA, shared));
    expect(a.admitted).toBe(true);
    await writeFile(join(shared.root, PROJECT_ENDPOINT_FILENAME), foreignEndpoint(rootA, process.pid));
    await writeFile(join(shared.root, LOCK_FILENAME), `${process.pid}\n`);
    const before = await digest(join(shared.root, PROJECT_ENDPOINT_FILENAME), join(shared.root, LOCK_FILENAME),
      shared.metadataDbPath, `${shared.metadataDbPath}-wal`, `${shared.metadataDbPath}-shm`, shared.vectorDbPath);
    const b = await attempt(configFor(rootB, shared));
    const after = await digest(join(shared.root, PROJECT_ENDPOINT_FILENAME), join(shared.root, LOCK_FILENAME),
      shared.metadataDbPath, `${shared.metadataDbPath}-wal`, `${shared.metadataDbPath}-shm`, shared.vectorDbPath);
    expect(after).toEqual(before);
    expect(b.admitted).toBe(false);
    expect(String((b.error as Error | undefined)?.message)).toMatch(/Another Nexus process is already running/); // lock, not ownership
  });

  it('S01_red_shared_root_stale_foreign_descriptor_via_bridge', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const storageDir = join(base, 'shared-storage');
    await mkdir(storageDir, { recursive: true });
    const endpointPath = join(storageDir, PROJECT_ENDPOINT_FILENAME);
    await writeFile(endpointPath, foreignEndpoint(rootA, DEAD_PID));
    const before = await digest(endpointPath);
    const spawn: SpawnFn = () => {
      const child = new EventEmitter() as unknown as ReturnType<SpawnFn>;
      (child as unknown as { unref: () => void }).unref = () => undefined;
      setImmediate(() => child.emit('error', new Error('fixture_spawn_refused')));
      return child;
    };
    const outcome = await ensureProjectEndpoint({ projectRoot: rootB, storageDir, childExecutable: 'unused', env: {},
      spawn, fetch: () => Promise.reject(new Error('fixture_no_network')), startupTimeoutMs: 1_000, pollIntervalMs: 20 })
      .then(() => 'resolved', () => 'rejected');
    expect(outcome).toBe('rejected');
    expect(await digest(endpointPath)).toEqual(before); // foreign descriptor bytes must survive
  });

  it('S01_red_shared_root_stale_foreign_pid_file', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const storageDir = join(base, 'shared-storage');
    await mkdir(storageDir, { recursive: true });
    const pidPath = join(storageDir, LOCK_FILENAME);
    await writeFile(pidPath, `${DEAD_PID}\n`);
    const before = await digest(pidPath);
    const lock = await acquireProcessLock(storageDir); // second owner has no ownership information to compare
    expect(lock.acquired).toBe(false);
    expect(await digest(pidPath)).toEqual(before); // foreign PID bytes must survive a refused startup
  });

  it('S02_red_shared_metadata', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const sharedMetadata = join(base, 'shared-meta', 'metadata.db');
    const a = targetsFor(join(base, 'storage-a'));
    const b = targetsFor(join(base, 'storage-b'));
    await liveOwner(configFor(rootA, { ...a, metadataDbPath: sharedMetadata }));
    const files = [sharedMetadata, `${sharedMetadata}-wal`, `${sharedMetadata}-shm`, a.vectorDbPath];
    const before = await digest(...files);
    const second = await attempt(configFor(rootB, { ...b, metadataDbPath: sharedMetadata }), true);
    expect(await digest(...files)).toEqual(before);
    expect(second.admitted).toBe(false);
  });

  it('S03_red_shared_vector', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const sharedVectors = join(base, 'shared-vectors');
    const a = targetsFor(join(base, 'storage-a'));
    const b = targetsFor(join(base, 'storage-b'));
    await liveOwner(configFor(rootA, { ...a, vectorDbPath: sharedVectors }));
    const before = await digest(sharedVectors, a.metadataDbPath, b.metadataDbPath);
    const second = await attempt(configFor(rootB, { ...b, vectorDbPath: sharedVectors }), true);
    expect(await digest(sharedVectors, a.metadataDbPath)).toEqual(
      Object.fromEntries(Object.entries(before).filter(([key]) => !key.startsWith(b.metadataDbPath))));
    expect(second.admitted).toBe(false);
  });

  describe('S04_red_symlink_alias', () => {
    it.each(['root', 'metadata', 'vector'] as const)('S04_red_symlink_alias_%s', { timeout: 60_000 }, async (target) => {
      const base = await sandbox();
      const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
      const a = targetsFor(join(base, 'storage-a'));
      const b = targetsFor(join(base, 'storage-b'));
      await liveOwner(configFor(rootA, a));
      const alias = join(base, `alias-${target}`);
      let colliding: Targets;
      if (target === 'root') { await symlink(a.root, alias, 'dir'); colliding = { ...b, root: alias }; }
      else if (target === 'metadata') { await symlink(a.root, alias, 'dir'); colliding = { ...b, metadataDbPath: join(alias, 'metadata.db') }; }
      else { await symlink(a.vectorDbPath, alias, 'dir'); colliding = { ...b, vectorDbPath: alias }; }
      const before = await digest(a.root);
      const second = await attempt(configFor(rootB, colliding), true);
      const after = await digest(a.root);
      expect(after).toEqual(before);
      expect(second.admitted).toBe(false); // collision must follow real paths, not lexical spelling
    });
  });

  it('S12_red_memory_vector_shared_metadata', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const sharedMetadata = join(base, 'shared-meta', 'metadata.db');
    const a = { ...targetsFor(join(base, 'storage-a')), metadataDbPath: sharedMetadata, vectorDbPath: 'memory://' };
    const b = { ...targetsFor(join(base, 'storage-b')), metadataDbPath: sharedMetadata, vectorDbPath: 'memory://' };
    await liveOwner(configFor(rootA, a));
    const files = [sharedMetadata, `${sharedMetadata}-wal`, `${sharedMetadata}-shm`];
    const before = await digest(...files);
    const second = await attempt(configFor(rootB, b), true);
    expect(await digest(...files)).toEqual(before);
    expect(second.admitted).toBe(false); // ephemeral vectors must not mask a shared persistent metadata store
  });

  it('S12_control_memory_vector_shared_root', { timeout: 60_000 }, async () => {
    const base = await sandbox();
    const [rootA, rootB] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const shared = { ...targetsFor(join(base, 'shared-storage')), vectorDbPath: 'memory://' };
    expect((await attempt(configFor(rootA, shared))).admitted).toBe(true);
    expect((await attempt(configFor(rootB, shared))).admitted).toBe(false);
  });
});
