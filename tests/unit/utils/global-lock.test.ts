import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireGlobalLock,
  GlobalLockHeldError,
  GLOBAL_LOCK_RETRIES,
  GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS,
  GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS,
  GLOBAL_LOCK_STALE_MS,
  projectStartupLockName,
} from '../../../src/utils/global-lock.js';

describe('global-lock', () => {
  it('acquires and releases a global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lock = await acquireGlobalLock(name);
    await lock.release();
  });

  it('throws a GlobalLockHeldError when another instance holds the same global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lock = await acquireGlobalLock(name);
    try {
      const error = await acquireGlobalLock(name).catch((caught) => caught);
      expect(error).toBeInstanceOf(GlobalLockHeldError);
      expect((error as GlobalLockHeldError).lockName).toBe(name);
    } finally {
      await lock.release();
    }
  });

  it('different names do not conflict', async () => {
    const name1 = `test-${randomUUID()}`;
    const name2 = `test-${randomUUID()}`;
    const lock1 = await acquireGlobalLock(name1);
    const lock2 = await acquireGlobalLock(name2);
    await lock1.release();
    await lock2.release();
  });

  it('uses bounded proper-lockfile stale and retry policy', () => {
    expect(GLOBAL_LOCK_STALE_MS).toBe(60_000);
    expect(GLOBAL_LOCK_RETRIES).toBe(10);
    expect(GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS).toBe(100);
    expect(GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS).toBe(1000);
  });

  it('derives the same startup lock for a symlink storage alias', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'nexus-global-lock-'));
    const storageAlias = join(tmpdir(), `nexus-global-lock-alias-${randomUUID()}`);

    try {
      await symlink(storageDir, storageAlias, 'dir');

      const targetLock = await projectStartupLockName(storageDir);

      expect(targetLock).toMatch(/^project-start-[a-f0-9]{64}$/);
      await expect(projectStartupLockName(storageAlias)).resolves.toBe(targetLock);
    } finally {
      await rm(storageAlias, { force: true });
      await rm(storageDir, { force: true, recursive: true });
    }
  });

  it('derives different startup locks for different storage directories', async () => {
    const storageDir1 = await mkdtemp(join(tmpdir(), 'nexus-global-lock-1-'));
    const storageDir2 = await mkdtemp(join(tmpdir(), 'nexus-global-lock-2-'));

    try {
      const lock1 = await projectStartupLockName(storageDir1);
      const lock2 = await projectStartupLockName(storageDir2);
      expect(lock1).not.toBe(lock2);
    } finally {
      await rm(storageDir1, { force: true, recursive: true });
      await rm(storageDir2, { force: true, recursive: true });
    }
  });
});
