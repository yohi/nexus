import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';

describe('loadConfig', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await import('node:fs/promises').then(({ rm }) => rm(tempDir!, { recursive: true, force: true }));
      tempDir = undefined;
    }
  });

  it('loads defaults when no config file or env vars are present', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({ projectRoot: tempDir, env: {} });

    expect(config.projectRoot).toBe(tempDir);
    expect(config.storage.rootDir).toBe(path.join(tempDir, '.nexus'));
    expect(config.embedding.provider).toBe('ollama');
    expect(config.watcher.debounceMs).toBe(100);
  });

  it('prefers environment variables over .nexus.json values', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({
        watcher: { debounceMs: 250 },
        embedding: { provider: 'test', model: 'file-model', dimensions: 16 },
      }),
      'utf8',
    );

    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_WATCHER_DEBOUNCE_MS: '500',
        NEXUS_EMBEDDING_PROVIDER: 'ollama',
        NEXUS_EMBEDDING_MODEL: 'env-model',
      },
    });

    expect(config.watcher.debounceMs).toBe(500);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('env-model');
    expect(config.embedding.dimensions).toBe(16);
  });

  it('falls back to defaults when env values are invalid', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_WATCHER_DEBOUNCE_MS: 'abc',
        NEXUS_EMBEDDING_PROVIDER: 'invalid-provider',
        NEXUS_EMBEDDING_DIMENSIONS: '-1',
      },
    });

    expect(config.watcher.debounceMs).toBe(100);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.dimensions).toBe(768);
  });

  it('rejects integers with trailing characters in environment variables', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_WATCHER_DEBOUNCE_MS: '250abc',
        NEXUS_EMBEDDING_BATCH_SIZE: 'abc100',
      },
    });

    expect(config.watcher.debounceMs).toBe(100); // Should fallback to default 100, not use 250
    expect(config.embedding.batchSize).toBe(32); // Should fallback to default 32
  });

  it('uses 768 as default dimensions', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    const config = await loadConfig({ projectRoot: tempDir, env: {} });
    expect(config.embedding.dimensions).toBe(768);
  });

  it('re-throws JSON parse errors', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(path.join(tempDir, '.nexus.json'), '{ "invalid": ', 'utf8');

    await expect(loadConfig({ projectRoot: tempDir, env: {} })).rejects.toThrow();
  });

  it('ignores invalid types in .nexus.json and uses defaults', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({
        embedding: { dimensions: 'invalid', batchSize: -1 },
        watcher: { debounceMs: 'very-slow' },
      }),
      'utf8',
    );

    const config = await loadConfig({ projectRoot: tempDir, env: {} });

    expect(config.embedding.dimensions).toBe(768);
    expect(config.embedding.batchSize).toBe(32);
    expect(config.watcher.debounceMs).toBe(100);
  });

  it('rejects config files with top-level arrays', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(path.join(tempDir, '.nexus.json'), '[1, 2, 3]', 'utf8');

    await expect(loadConfig({ projectRoot: tempDir, env: {} })).rejects.toThrow(/must contain a top-level object/);
  });

  it('rejects config files that are null', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(path.join(tempDir, '.nexus.json'), 'null', 'utf8');

    await expect(loadConfig({ projectRoot: tempDir, env: {} })).rejects.toThrow(/must contain a top-level object/);
  });

  it('falls back to defaults when storage paths in .nexus.json are not strings', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({
        storage: { rootDir: 123, metadataDbPath: true, vectorDbPath: null },
      }),
      'utf8',
    );

    const config = await loadConfig({ projectRoot: tempDir, env: {} });

    expect(config.storage.rootDir).toBe(path.join(tempDir, '.nexus'));
    expect(config.storage.metadataDbPath).toBe(path.join(tempDir, '.nexus', 'metadata.db'));
    expect(config.storage.vectorDbPath).toBe(path.join(tempDir, '.nexus', 'vectors'));
  });

  it('trims string values from environment variables and config files', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({
        embedding: { apiKey: '  secret-key  ' },
      }),
      'utf8',
    );

    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_EMBEDDING_PROVIDER: '  test  ',
        NEXUS_EMBEDDING_MODEL: '  nomic-embed-text  ',
      },
    });

    expect(config.embedding.provider).toBe('test');
    expect(config.embedding.model).toBe('nomic-embed-text');
    expect(config.embedding.apiKey).toBe('secret-key');
  });
});
