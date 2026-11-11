import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
import { EventQueue } from '../../../src/indexer/event-queue.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { NexusServerFactory, assertPackageModeConstraints } from '../../../src/server/factory.js';
import type { Config } from '../../../src/types/index.js';
import type { PluginRegistry } from '../../../src/plugins/registry.js';
import type { NexusRuntime } from '../../../src/server/index.js';
import { createRuntimeAssembly } from '../../../src/server/runtime-assembly.js';
import { setWriterLeaseLostHandler } from '../../../src/server/runtime/writer-lease-loss.js';
import { createStorageOwnershipAdmissionService, storageOwnershipAdmissionService, type WriterAdmission }
  from '../../../src/server/storage-ownership/admission.js';
import { testCoordinationRoot } from '../../shared/storage-ownership-coordination-setup.js';

interface FactoryInternals {
  setupPluginRegistry(config: Config): PluginRegistry;
}

const internals = NexusServerFactory as unknown as FactoryInternals;

describe('assertPackageModeConstraints', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('does nothing when packageMode is false regardless of provider', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({ projectRoot: tempDir, env: { NEXUS_EMBEDDING_PROVIDER: 'ollama' } });
    expect(() => assertPackageModeConstraints(config)).not.toThrow();
  });

  it('passes when packageMode is true and provider is bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'bedrock', NEXUS_EMBEDDING_DIMENSIONS: '1024' },
    });
    expect(() => assertPackageModeConstraints(config)).not.toThrow();
  });

  it('throws when packageMode is true and provider is not bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'ollama' },
    });
    expect(() => assertPackageModeConstraints(config)).toThrow(/requires embedding\.provider="bedrock"/);
  });
});

describe('NexusServerFactory.setupPluginRegistry', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers the bedrock provider when provider is bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'bedrock',
        NEXUS_EMBEDDING_DIMENSIONS: '1024',
        NEXUS_EMBEDDING_REGION: 'us-east-1',
      },
    });

    const registry = internals.setupPluginRegistry(config);
    expect(registry.getActiveEmbeddingProviderName()).toBe('bedrock');
  });

  it('registers all structured language plugins in the production registry', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'bedrock',
        NEXUS_EMBEDDING_DIMENSIONS: '1024',
        NEXUS_EMBEDDING_REGION: 'us-east-1',
      },
    });

    const registry = internals.setupPluginRegistry(config);

    expect(registry.getLanguagePlugin('src/example.c')?.languageId).toBe('c');
    expect(registry.getLanguagePlugin('src/example.hpp')?.languageId).toBe('cpp');
    expect(registry.getLanguagePlugin('src/example.cs')?.languageId).toBe('csharp');
    expect(registry.getLanguagePlugin('src/example.java')?.languageId).toBe('java');
    expect(registry.getLanguagePlugin('src/example.rs')?.languageId).toBe('rust');
  });

  it('registers the bedrock provider when packageMode is true', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_PACKAGE_MODE: '1',
        NEXUS_EMBEDDING_PROVIDER: 'bedrock',
        NEXUS_EMBEDDING_DIMENSIONS: '1024',
        NEXUS_EMBEDDING_REGION: 'us-east-1',
      },
    });

    const registry = internals.setupPluginRegistry(config);
    expect(registry.getActiveEmbeddingProviderName()).toBe('bedrock');
  });

  it('fails fast in packageMode when provider is not bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'openai-compat' },
    });

    expect(() => internals.setupPluginRegistry(config)).toThrow(/requires embedding\.provider="bedrock"/);
  });
});

describe('NexusServerFactory.createRuntime', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers the runtime event queue with the index pipeline', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({ projectRoot: tempDir });
    const setEventQueueSpy = vi.spyOn(IndexPipeline.prototype, 'setEventQueue');
    let runtime: Awaited<ReturnType<typeof NexusServerFactory.createRuntime>> | undefined;

    try {
      runtime = await NexusServerFactory.createRuntime(config);

      expect(setEventQueueSpy).toHaveBeenCalledOnce();
      expect(setEventQueueSpy.mock.calls[0]?.[0]).toBeInstanceOf(EventQueue);
    } finally {
      setEventQueueSpy.mockRestore();
      if (runtime) {
        await runtime.close();
      }
    }
  });

  it('creates independent MCP servers over one shared runtime resource set', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({ projectRoot: tempDir });
    let runtime: Awaited<ReturnType<typeof NexusServerFactory.createRuntime>> | undefined;

    try {
      runtime = await NexusServerFactory.createRuntime(config);
      const first = runtime.createServer();
      const second = runtime.createServer();

      expect(first).not.toBe(second);
      expect(runtime.orchestrator).toBeDefined();
      expect(runtime.sanitizer).toBeDefined();

      await first.close();
      await second.close();
    } finally {
      await runtime?.close();
    }
  });
});


describe('NexusServerFactory language registration', () => {
  it('routes every supported extension through the factory-created registry', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-routing-'));
    try {
      const config = await loadConfig({
        projectRoot,
        env: {
          NEXUS_EMBEDDING_PROVIDER: 'bedrock',
          NEXUS_EMBEDDING_DIMENSIONS: '1024',
          NEXUS_EMBEDDING_REGION: 'us-east-1',
        },
      });
      const registry = internals.setupPluginRegistry(config);
      const routes: ReadonlyArray<readonly [string, string]> = [
        ['.pyi', 'python'],
        ['.rs', 'rust'],
        ['.java', 'java'],
        ['.cs', 'csharp'],
        ['.c', 'c'],
        ['.h', 'cpp'],
        ['.cc', 'cpp'],
        ['.cpp', 'cpp'],
        ['.cxx', 'cpp'],
        ['.hh', 'cpp'],
        ['.hpp', 'cpp'],
        ['.hxx', 'cpp'],
      ];
      for (const [extension, languageId] of routes) {
        expect(registry.getLanguagePlugin(`src/example${extension}`)?.languageId).toBe(languageId);
      }
      expect(registry.getLanguagePlugin('src/example.txt')).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Nexus #297 Task 4: authenticated writer admission gates every runtime construction path.
// ---------------------------------------------------------------------------------------------------------------
describe('NexusServerFactory writer admission gate (Nexus #297)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined); });

  async function fixture(): Promise<{ base: string; config: Config }> {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-admission-')));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const projectRoot = path.join(base, 'project');
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, 'a.ts'), 'export const a = 1;\n');
    const loaded = await loadConfig({ projectRoot });
    const storage = path.join(base, 'storage');
    const config: Config = { ...loaded, storage: { ...loaded.storage, rootDir: storage,
      metadataDbPath: path.join(storage, 'metadata.db'), vectorDbPath: path.join(storage, 'vectors') } };
    return { base, config };
  }

  const admit = async (config: Config, service = storageOwnershipAdmissionService): Promise<WriterAdmission> =>
    await service.admitStorageWriter(await service.resolveStorageOwnershipTargets(config));
  const contender = () => createStorageOwnershipAdmissionService({ coordinationRoot: testCoordinationRoot(), lockWaitMs: 200 });
  const exists = async (p: string) => await lstat(p).then(() => true, () => false);
  const track = (runtime: NexusRuntime): NexusRuntime => { cleanups.push(() => runtime.close()); return runtime; };

  it('direct_factory_cannot_bypass_admission', async () => {
    const { base, config } = await fixture();
    const foreignRoot = path.join(base, 'foreign');
    await mkdir(foreignRoot);
    const foreign = await admit({ ...config, projectRoot: foreignRoot });
    await foreign.release(); // durable foreign claims remain
    const before = await readdir(config.storage.rootDir);
    await expect(NexusServerFactory.createRuntime(config)).rejects.toMatchObject({ code: 'owner_conflict' });
    expect(await readdir(config.storage.rootDir)).toEqual(before);
    expect(await exists(config.storage.metadataDbPath)).toBe(false);
  });

  it('forged_writer_admission_is_rejected', async () => {
    const { config } = await fixture();
    const targets = await storageOwnershipAdmissionService.resolveStorageOwnershipTargets(config);
    const forged = { targets, release: () => Promise.resolve() } as unknown as WriterAdmission;
    await expect(NexusServerFactory.createRuntime(config, forged)).rejects.toMatchObject({ code: 'invalid_writer_admission' });
    await expect(createRuntimeAssembly(config, { writerAdmission: forged })).rejects.toMatchObject({ code: 'invalid_writer_admission' });
    expect(await exists(config.storage.rootDir)).toBe(false); // nothing mutated before the rejection
  });

  it('cast_or_cloned_handle_is_rejected', async () => {
    const { config } = await fixture();
    const other = contender();
    const foreignIssued = await admit(config, other);
    cleanups.push(() => foreignIssued.release());
    const before = await readdir(config.storage.rootDir);
    for (const candidate of [{ ...foreignIssued }, Object.create(foreignIssued) as unknown, foreignIssued]) {
      await expect(NexusServerFactory.createRuntime(config, candidate as WriterAdmission))
        .rejects.toMatchObject({ code: 'invalid_writer_admission' });
    }
    expect(await readdir(config.storage.rootDir)).toEqual(before);
    expect(await exists(config.storage.metadataDbPath)).toBe(false);
    // The foreign issuer's lease was never released by the rejected attempts.
    await expect(admit(config, contender())).rejects.toMatchObject({ code: 'writer_busy' });
  });

  it('released_handle_cannot_be_reused', async () => {
    const { config } = await fixture();
    const handle = await admit(config);
    await handle.release();
    await expect(NexusServerFactory.createRuntime(config, handle)).rejects.toMatchObject({ code: 'invalid_writer_admission' });
    expect(await exists(config.storage.metadataDbPath)).toBe(false);
  });

  it('consumed_handle_cannot_initialize_second_runtime', async () => {
    const { config } = await fixture();
    const handle = await admit(config);
    track(await NexusServerFactory.createRuntime(config, handle));
    await expect(NexusServerFactory.createRuntime(config, handle)).rejects.toMatchObject({ code: 'invalid_writer_admission' });
    await expect(createRuntimeAssembly(config, { writerAdmission: handle })).rejects.toMatchObject({ code: 'invalid_writer_admission' });
  });

  it('handle_rejects_different_metadata_or_ephemeral_vector_config', async () => {
    const { base, config } = await fixture();
    const handle = await admit(config);
    cleanups.push(() => handle.release());
    const otherMeta: Config = { ...config, storage: { ...config.storage, metadataDbPath: path.join(base, 'other', 'metadata.db') } };
    const ephemeral: Config = { ...config, storage: { ...config.storage, vectorDbPath: 'memory://' } };
    for (const mismatched of [otherMeta, ephemeral]) {
      await expect(NexusServerFactory.createRuntime(mismatched, handle)).rejects.toMatchObject({ code: 'target_mismatch' });
    }
    expect(await exists(path.join(base, 'other'))).toBe(false);
    expect(await exists(config.storage.metadataDbPath)).toBe(false);
    track(await NexusServerFactory.createRuntime(config, handle)); // still ISSUED: exact config transfers once
  });

  it('valid_cli_transfer_is_single_use', async () => {
    const { config } = await fixture();
    const handle = await admit(config);
    const runtime = track(await NexusServerFactory.createRuntime(config, handle));
    expect(runtime.orchestrator).toBeDefined();
    await handle.release(); // no-op after transfer
    await expect(NexusServerFactory.createRuntime(config, handle)).rejects.toMatchObject({ code: 'invalid_writer_admission' });
  });

  it('post_transfer_cli_release_cannot_drop_live_runtime_lease', async () => {
    const { config } = await fixture();
    const handle = await admit(config);
    const runtime = await NexusServerFactory.createRuntime(config, handle);
    await handle.release();
    await expect(admit(config, contender())).rejects.toMatchObject({ code: 'writer_busy' });
    await runtime.close();
    const next = await admit(config, contender()); // runtime close released the lease last
    await next.release();
  });

  it('release_is_idempotent', async () => {
    const { config } = await fixture();
    const issued = await admit(config);
    await issued.release();
    await issued.release();
    const handle = await admit(config);
    const runtime = await NexusServerFactory.createRuntime(config, handle);
    await runtime.close();
    await runtime.close();
    await handle.release();
    const next = await admit(config, contender());
    await next.release();
  });

  const replaceWriterLockInodes = async (): Promise<void> => {
    const writerDir = path.join(testCoordinationRoot(), 'writer');
    for (const name of (await readdir(writerDir)).filter((n) => n.endsWith('.lock'))) {
      await writeFile(path.join(writerDir, `${name}.replacement`), '');
      await rename(path.join(writerDir, `${name}.replacement`), path.join(writerDir, name)); // inode substitution
    }
  };

  it('lost_writer_lease_closes_runtime_fail_closed', async () => {
    const { config } = await fixture();
    const onWriterLeaseLost = vi.fn();
    const assembly = await createRuntimeAssembly(config, { writerLeaseCheckIntervalMs: 20, onWriterLeaseLost });
    cleanups.push(() => assembly.runtime.close());
    const close = vi.spyOn(assembly.runtime, 'close');
    const stop = vi.spyOn(assembly.options.pipeline, 'stop');
    const watcherStop = vi.spyOn(assembly.options.watcher, 'stop');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onWriterLeaseLost).not.toHaveBeenCalled(); // healthy lease: keeps serving
    await replaceWriterLockInodes();
    await vi.waitFor(() => expect(onWriterLeaseLost).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(onWriterLeaseLost.mock.calls[0]?.[0]).toMatchObject({ code: 'invalid_writer_admission' });
    // The pipeline is aborted synchronously BEFORE the fail-fast hook; no graceful close (no awaited startup writes,
    // no metrics-port removal) runs on the lease-lost path.
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(onWriterLeaseLost.mock.invocationCallOrder[0] ?? 0);
    expect(watcherStop).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onWriterLeaseLost).toHaveBeenCalledOnce(); // monitor stopped after the first detection
  });

  it('lost writer lease invokes the process-level fail-fast handler registered by entry points', async () => {
    const { config } = await fixture();
    const processHandler = vi.fn();
    const previous = setWriterLeaseLostHandler(processHandler);
    cleanups.push(() => { setWriterLeaseLostHandler(previous); return Promise.resolve(); });
    const assembly = await createRuntimeAssembly(config, { writerLeaseCheckIntervalMs: 20 });
    cleanups.push(() => assembly.runtime.close());
    const close = vi.spyOn(assembly.runtime, 'close');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await replaceWriterLockInodes();
    await vi.waitFor(() => expect(processHandler).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(close).not.toHaveBeenCalled();
  });

  it('serve_uses_guarded_factory', async () => {
    const { base, config } = await fixture();
    const foreignRoot = path.join(base, 'foreign');
    await mkdir(foreignRoot);
    await (await admit({ ...config, projectRoot: foreignRoot })).release();
    const errors: string[] = [];
    const exit = vi.fn();
    const { runServeCli } = await import('../../../src/bin/commands/serve.js');
    const startServer = vi.fn();
    await runServeCli([], {}, {
      output: new PassThrough(), errorOutput: new Writable({ write(chunk, _e, cb) { errors.push(String(chunk)); cb(); } }),
      exit, signalSource: new EventEmitter(),
      loadConfig: () => Promise.resolve({ ...config, http: { host: '127.0.0.1', port: 0, maxTopK: 10, maxResultsLimit: 10 } } as Config),
      startServer,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('')).toMatch(/owner_conflict/);
    expect(startServer).not.toHaveBeenCalled();
    expect(await exists(config.storage.metadataDbPath)).toBe(false);
  });
});
