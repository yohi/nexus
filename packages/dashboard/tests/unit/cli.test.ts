
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { resolveStorageDir } from '../../src/cli.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('resolveStorageDir', () => {
  let tempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-cli-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    vi.unstubAllEnvs();
  });

  it('resolves relative storage rootDir relative to projectRoot', async () => {
    const projectRoot = tempDir!;
    const customStorageDir = 'custom-storage';
    await writeFile(
      path.join(projectRoot, '.nexus.json'),
      JSON.stringify({
        storage: { rootDir: customStorageDir }
      }),
      'utf8'
    );

    const resolved = await resolveStorageDir(projectRoot);
    expect(resolved).toBe(path.resolve(projectRoot, customStorageDir));
  });

  it('respects NEXUS_STORAGE_ROOT_DIR env var', async () => {
    const projectRoot = tempDir!;
    const envPath = path.join(os.tmpdir(), 'env-storage');
    vi.stubEnv('NEXUS_STORAGE_ROOT_DIR', envPath);

    const resolved = await resolveStorageDir(projectRoot);
    expect(resolved).toBe(path.resolve(envPath));
  });

  it('falls back to default .nexus in projectRoot', async () => {
    const projectRoot = tempDir!;
    const resolved = await resolveStorageDir(projectRoot);
    expect(resolved).toBe(path.join(projectRoot, '.nexus'));
  });

  it('rejects storage rootDir that escapes projectRoot', async () => {
    const projectRoot = tempDir!;
    await writeFile(
      path.join(projectRoot, '.nexus.json'),
      JSON.stringify({ storage: { rootDir: '../outside-storage' } }),
      'utf8'
    );

    await expect(resolveStorageDir(projectRoot)).rejects.toThrow(
      'storage.rootDir must stay within the project root'
    );
  });
});
