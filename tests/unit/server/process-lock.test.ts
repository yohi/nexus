import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import {
  acquireProcessLock, releaseOwnedProcessLock, releaseOwnedProcessLockSync, releaseProcessLock,
} from '../../../src/server/process-lock.js';
import { storageOwnershipAdmissionService, type WriterAdmission } from '../../../src/server/storage-ownership/admission.js';
import type { Config } from '../../../src/types/index.js';

describe('ProcessLock', () => {
  let testDir: string;
  const releases: Array<() => Promise<void>> = [];

  /** A live writer admission for `dir` (admitted while the directory is still empty). */
  async function admitted(dir: string): Promise<{ handle: WriterAdmission; config: Config }> {
    const projectRoot = path.join(path.dirname(dir), `${path.basename(dir)}-project`);
    await mkdir(projectRoot, { recursive: true });
    releases.push(() => rm(projectRoot, { recursive: true, force: true }));
    const config = { projectRoot, storage: { rootDir: dir, metadataDbPath: path.join(dir, 'metadata.db'),
      vectorDbPath: path.join(dir, 'vectors') } } as unknown as Config;
    const service = storageOwnershipAdmissionService;
    const handle = await service.admitStorageWriter(await service.resolveStorageOwnershipTargets(config));
    releases.push(() => handle.release());
    return { handle, config };
  }

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `nexus-lock-test-${process.pid}-${Date.now()}-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    for (const release of releases.splice(0).reverse()) await release();
    await releaseProcessLock(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  it('acquires a lock and writes the PID file', async () => {
    const result = await acquireProcessLock(testDir, await admitted(testDir));

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(testDir, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);
  });

  it('detects a live process and refuses to acquire', async () => {
    const admission = await admitted(testDir);
    const first = await acquireProcessLock(testDir, admission);
    expect(first.acquired).toBe(true);

    const second = await acquireProcessLock(testDir, admission);
    expect(second.acquired).toBe(false);
    expect(second.existingPid).toBe(process.pid);
  });

  it('recovers from a stale lock (dead PID)', async () => {
    // Write a PID file for a process that definitely doesn't exist
    // 0x7fffffff is the largest 32-bit positive integer; very unlikely to be a real PID
    const admission = await admitted(testDir);
    await writeFile(path.join(testDir, 'nexus.pid'), '2147483647');

    const result = await acquireProcessLock(testDir, admission);

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(testDir, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);
  });

  it('recovers from a corrupt lock file (non-numeric content)', async () => {
    const admission = await admitted(testDir);
    await writeFile(path.join(testDir, 'nexus.pid'), 'not-a-pid\n');

    const result = await acquireProcessLock(testDir, admission);

    expect(result.acquired).toBe(true);
  });

  it('releaseProcessLock removes the PID file', async () => {
    await acquireProcessLock(testDir, await admitted(testDir));

    await releaseProcessLock(testDir);

    await expect(stat(path.join(testDir, 'nexus.pid'))).rejects.toThrow();
  });

  it('releaseProcessLock is idempotent (no error if no lock)', async () => {
    await expect(releaseProcessLock(testDir)).resolves.toBeUndefined();
  });

  it('creates the storage directory if it does not exist', async () => {
    const nestedDir = path.join(testDir, 'subdir-' + randomUUID());

    const result = await acquireProcessLock(nestedDir, await admitted(nestedDir));

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(nestedDir, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);

    // Verify directory exists
    const dirStat = await stat(nestedDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  // Nexus #297: shutdown/exit cleanup only ever removes a PID file this process wrote.
  it('owned release removes only this process PID file', async () => {
    await acquireProcessLock(testDir, await admitted(testDir));
    await releaseOwnedProcessLock(testDir);
    await expect(stat(path.join(testDir, 'nexus.pid'))).rejects.toThrow();
    await expect(releaseOwnedProcessLock(testDir)).resolves.toBeUndefined();
    expect(() => releaseOwnedProcessLockSync(testDir)).not.toThrow();
  });

  it('foreign_pid_not_unlinked_on_failed_admission (owned release keeps foreign PID bytes)', async () => {
    const pidPath = path.join(testDir, 'nexus.pid');
    for (const foreign of ['2147483000\n', 'not-a-pid\n']) {
      await writeFile(pidPath, foreign);
      await releaseOwnedProcessLock(testDir);
      releaseOwnedProcessLockSync(testDir);
      expect(await readFile(pidPath, 'utf8')).toBe(foreign);
    }
  });

  it('never removes a stale or corrupt PID file without a live writer admission for the same root', async () => {
    const pidPath = path.join(testDir, 'nexus.pid');
    const other = await admitted(path.join(testDir, 'other-root'));
    for (const foreign of ['2147483000\n', 'not-a-pid\n']) {
      await writeFile(pidPath, foreign);
      expect((await acquireProcessLock(testDir, other)).acquired).toBe(false); // admission for a different root
      expect(await readFile(pidPath, 'utf8')).toBe(foreign);
    }
  });

  it('rejects a released admission before removing a stale PID file', async () => {
    const admission = await admitted(testDir);
    await admission.handle.release();
    await writeFile(path.join(testDir, 'nexus.pid'), '2147483000\n');
    await expect(acquireProcessLock(testDir, admission)).rejects.toMatchObject({ code: 'invalid_writer_admission' });
    expect(await readFile(path.join(testDir, 'nexus.pid'), 'utf8')).toBe('2147483000\n');
  });
});
