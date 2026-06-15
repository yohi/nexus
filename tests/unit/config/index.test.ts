import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, SECRET_IGNORE_PATHS } from '../../../src/config/index.js';

describe('loadConfig', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
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
    expect(config.embedding.batchSize).toBe(4); // Should fallback to default 4
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
    expect(config.embedding.batchSize).toBe(4);
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

  it('includes lockfile entries and the secret denylist in the default ignorePaths', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({ projectRoot: tempDir, env: {} });
    const ignorePaths = config.watcher.ignorePaths ?? [];

    for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', '*.lock']) {
      expect(ignorePaths).toContain(lockfile);
    }
    for (const secret of SECRET_IGNORE_PATHS) {
      expect(ignorePaths).toContain(secret);
    }
    expect(SECRET_IGNORE_PATHS).toEqual(['.env', '.env.*']);
  });

  it('always merges the secret denylist when .nexus.json overrides ignorePaths without secrets', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({
        watcher: { ignorePaths: ['node_modules', 'custom_dir'] },
      }),
      'utf8',
    );

    const config = await loadConfig({ projectRoot: tempDir, env: {} });
    const ignorePaths = config.watcher.ignorePaths ?? [];

    expect(ignorePaths).toContain('node_modules');
    expect(ignorePaths).toContain('custom_dir');
    expect(ignorePaths).toContain('.env');
    expect(ignorePaths).toContain('.env.*');
  });

  it('always merges the secret denylist when NEXUS_WATCHER_IGNORE_PATHS overrides ignorePaths', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_WATCHER_IGNORE_PATHS: 'node_modules,tmp',
      },
    });
    const ignorePaths = config.watcher.ignorePaths ?? [];

    expect(ignorePaths).toContain('node_modules');
    expect(ignorePaths).toContain('tmp');
    expect(ignorePaths).toContain('.env');
    expect(ignorePaths).toContain('.env.*');
  });

  it('does not duplicate secret entries already present in ignorePaths', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({
        watcher: { ignorePaths: ['.env', 'node_modules'] },
      }),
      'utf8',
    );

    const config = await loadConfig({ projectRoot: tempDir, env: {} });
    const ignorePaths = config.watcher.ignorePaths ?? [];

    // '.env' was already present → the merge must not duplicate it.
    expect(ignorePaths.filter((entry) => entry === '.env')).toHaveLength(1);
    // '.env.*' was missing → the merge must append it exactly once.
    expect(ignorePaths.filter((entry) => entry === '.env.*')).toHaveLength(1);
    expect(ignorePaths).toContain('node_modules');
  });

  it('defaults indexing.maxFileBytes to 1048576 and allows overrides', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const defaults = await loadConfig({ projectRoot: tempDir, env: {} });
    expect(defaults.indexing.maxFileBytes).toBe(1_048_576);

    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({ indexing: { maxFileBytes: 2048 } }),
      'utf8',
    );
    const fileOverride = await loadConfig({ projectRoot: tempDir, env: {} });
    expect(fileOverride.indexing.maxFileBytes).toBe(2048);

    const envOverride = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_INDEXING_MAX_FILE_BYTES: '4096' },
    });
    expect(envOverride.indexing.maxFileBytes).toBe(4096);
  });
});
