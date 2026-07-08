import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
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

  it('fails fast in packageMode when provider is not bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'openai-compat' },
    });

    expect(() => internals.setupPluginRegistry(config)).toThrow(/requires embedding\.provider="bedrock"/);
  });
});
