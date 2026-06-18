import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireProjectLock, isProjectLocked } from '../../../src/utils/project-lock.js';

describe('project-lock', () => {
  let rootDir: string;
  let releaseLock: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-project-lock-'));
    releaseLock = undefined;
  });

  afterEach(async () => {
    await releaseLock?.();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('acquires and releases a project lock', async () => {
    expect(await isProjectLocked(rootDir)).toBe(false);

    const lock = await acquireProjectLock(rootDir);
    releaseLock = lock.release;

    expect(await isProjectLocked(rootDir)).toBe(true);
    await expect(stat(path.join(rootDir, '.nexus-lock'))).resolves.toBeDefined();

    await lock.release();
    releaseLock = undefined;

    expect(await isProjectLocked(rootDir)).toBe(false);
    await expect(stat(path.join(rootDir, '.nexus-lock'))).rejects.toThrow();
  });

  it('rejects a second acquire while the lock is held', async () => {
    const lock = await acquireProjectLock(rootDir);
    releaseLock = lock.release;

    await expect(acquireProjectLock(rootDir)).rejects.toThrow(
      `Another Nexus process is already running for this project (${rootDir}). Only one instance per project is allowed.`,
    );
  });
});
