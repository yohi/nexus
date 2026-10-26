import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { NexusServerFactory } from '../../../src/server/factory.js';
import { createRuntimeAssembly } from '../../../src/server/runtime-assembly.js';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import { createBenchmarkRuntimeFactory } from '../../benchmarks/performance/runtime.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from '../../benchmarks/performance/synthetic-provider.js';

describe('shared real-runtime assembly', () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-runtime-assembly-'));
    root = join(directory, 'project');
    await mkdir(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps benchmark construction lazy until factory invocation', async () => {
    const createRuntime = createBenchmarkRuntimeFactory(root);
    await expect(access(join(directory, 'project.nexus-perf-state'))).rejects.toThrow();
    const assembly = await createRuntime(new AbortController().signal);
    try {
      expect(assembly.runtime.orchestrator).toBe(assembly.options.orchestrator);
      expect(assembly.options.metadataStore).toBe(assembly.diagnostics.metadataStore);
      expect(assembly.options.vectorStore).toBe(assembly.diagnostics.vectorStore);
      expect(assembly.options.pluginRegistry.getActiveEmbeddingProviderName()).toBe('test');
      const handlers = buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime));
      const response = await handlers.grep_search({ pattern: 'missing' });
      expect(response.isError).not.toBe(true);
    } finally {
      await assembly.runtime.close();
      await assembly.runtime.close();
    }
  });

  it('rejects production test-provider construction and releases its lock', async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    const fixed = { ...config, embedding: syntheticEmbeddingConfig };
    await expect(NexusServerFactory.createRuntime(fixed)).rejects.toThrow('not supported in production');
    const assembly = await createRuntimeAssembly(fixed, { createEmbeddingProvider: createSyntheticProvider });
    await assembly.runtime.close();
  });

  it('rejects mismatched injection and unexpected provider dimensions', async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    await expect(createRuntimeAssembly({ ...config, embedding: { ...syntheticEmbeddingConfig, model: 'foreign' } },
      { createEmbeddingProvider: createSyntheticProvider })).rejects.toThrow();
    await expect(createRuntimeAssembly({ ...config, embedding: syntheticEmbeddingConfig },
      { createEmbeddingProvider: () => ({ ...createSyntheticProvider(), dimensions: 64 }) })).rejects.toThrow();
  });

  it('excludes a second assembly while the first owns the project lock', async () => {
    const createRuntime = createBenchmarkRuntimeFactory(root);
    const first = await createRuntime(new AbortController().signal);
    try {
      await expect(createRuntime(new AbortController().signal)).rejects.toThrow();
    } finally {
      await first.runtime.close();
    }
    const reopened = await createRuntime(new AbortController().signal);
    await reopened.runtime.close();
  });

  it('closes initialized stores and releases the lock after initialization rejection', async () => {
    const createRuntime = createBenchmarkRuntimeFactory(root);
    const first = await createRuntime(new AbortController().signal);
    const initialize = vi.spyOn(SqliteMetadataStore.prototype, 'initialize').mockRejectedValueOnce(new Error('initialization_failure'));
    await expect(first.runtime.initialize()).rejects.toThrow('initialization_failure');
    expect(() => first.diagnostics.metadataStore.getPragmaValue('user_version')).toThrow();
    await expect(first.diagnostics.vectorStore.initialize()).rejects.toThrow('closed');
    initialize.mockRestore();
    const second = await createRuntime(new AbortController().signal);
    await second.runtime.close();
  });

  it('rejects an aborted factory before acquiring resources', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createBenchmarkRuntimeFactory(root)(controller.signal)).rejects.toThrow();
    await expect(access(join(directory, 'project.nexus-perf-state'))).rejects.toThrow();
  });

  it('rolls back a constructor failure before another runtime acquires the same storage', async () => {
    const config = await loadConfig({ projectRoot: join(directory, 'absent'), env: {} });
    const storage = join(directory, 'separate-state');
    const input = { ...config, embedding: syntheticEmbeddingConfig,
      storage: { ...config.storage, rootDir: storage, metadataDbPath: join(storage, 'metadata.db'),
        vectorDbPath: join(storage, 'vectors') } };
    await expect(createRuntimeAssembly(input, { createEmbeddingProvider: createSyntheticProvider })).rejects.toThrow();
    await mkdir(input.projectRoot);
    const reopened = await createRuntimeAssembly(input, { createEmbeddingProvider: createSyntheticProvider });
    await reopened.runtime.close();
  });

  it('uses the same live stores and grep engine through actual handler construction', async () => {
    await writeFile(join(root, 'fixture.ts'), 'export function identityNeedle() { return 1; }\n');
    const assembly = await createBenchmarkRuntimeFactory(root)(new AbortController().signal);
    try {
      await assembly.runtime.initialize();
      await assembly.options.pipeline.waitForActiveReindex();
      const handlers = buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime));
      const grep = await handlers.grep_search({ pattern: 'identityNeedle', maxResults: 100 });
      const stats = await assembly.diagnostics.vectorStore.getStats();
      expect(grep.isError).not.toBe(true);
      expect(JSON.stringify(grep.structuredContent)).toContain('identityNeedle');
      expect(stats.totalChunks).toBeGreaterThan(0);
      expect(await assembly.diagnostics.metadataStore.getIndexStats()).toMatchObject({ lastError: null });
    } finally {
      await assembly.runtime.close();
    }
  });

  it('preserves retry after a transient initialization rejection in the shared production builder', async () => {
    await writeFile(join(root, 'retry.ts'), 'export function retryIdentity() { return 1; }\n');
    const config = await loadConfig({ projectRoot: root, env: {} });
    const assembly = await createRuntimeAssembly({ ...config, embedding: syntheticEmbeddingConfig },
      { createEmbeddingProvider: createSyntheticProvider });
    try {
      vi.spyOn(SqliteMetadataStore.prototype, 'initialize').mockRejectedValueOnce(new Error('transient_initialize'));
      await expect(assembly.runtime.initialize()).rejects.toThrow('transient_initialize');
      await assembly.runtime.initialize();
      await assembly.options.pipeline.waitForActiveReindex();
      expect((await assembly.diagnostics.vectorStore.getStats()).totalChunks).toBeGreaterThan(0);
    } finally {
      await assembly.runtime.close();
    }
  });

  it('closes the SQLite handle during normal shutdown', async () => {
    const assembly = await createBenchmarkRuntimeFactory(root)(new AbortController().signal);
    await assembly.runtime.close();
    expect(() => assembly.diagnostics.metadataStore.getPragmaValue('user_version')).toThrow();
  });

  it('closes the real SQLite store when vector construction rejects before returning the store bundle', async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    const close = vi.spyOn(SqliteMetadataStore.prototype, 'close');
    await expect(createRuntimeAssembly({ ...config, embedding: { ...syntheticEmbeddingConfig, dimensions: 0 } },
      { createEmbeddingProvider: createSyntheticProvider })).rejects.toThrow('dimensions must be a positive integer');
    expect(close).toHaveBeenCalledOnce();
    const closed = close.mock.contexts[0];
    if (!(closed instanceof SqliteMetadataStore)) throw new Error('closed metadata handle required');
    expect(() => closed.getPragmaValue('user_version')).toThrow();
  });

  it('rejects an invalid metadata batch size before opening its database', async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    await expect(createRuntimeAssembly({ ...config, storage: { ...config.storage, batchSize: 0 } }))
      .rejects.toThrow('batchSize must be a positive integer');
    await expect(access(config.storage.metadataDbPath)).rejects.toThrow();
  });

  it('closes the real vector store even when pipeline shutdown rejects first', async () => {
    const assembly = await createBenchmarkRuntimeFactory(root)(new AbortController().signal);
    await assembly.diagnostics.vectorStore.initialize();
    vi.spyOn(assembly.options.pipeline, 'stop').mockRejectedValueOnce(new Error('pipeline_stop_failure'));
    try {
      await expect(assembly.runtime.close()).rejects.toThrow('pipeline_stop_failure');
      await expect(assembly.diagnostics.vectorStore.initialize()).rejects.toThrow('closed');
      expect(() => assembly.diagnostics.metadataStore.getPragmaValue('user_version')).toThrow();
    } finally {
      await assembly.diagnostics.vectorStore.close();
    }
  });
});
