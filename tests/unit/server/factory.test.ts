import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
import { EventQueue } from '../../../src/indexer/event-queue.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { NexusServerFactory, assertPackageModeConstraints } from '../../../src/server/factory.js';
import type { Config } from '../../../src/types/index.js';
import type { PluginRegistry } from '../../../src/plugins/registry.js';

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
