import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import { acquireProcessLock, releaseProcessLock } from '../../../src/server/process-lock.js';

describe('ProcessLock', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `nexus-lock-test-${process.pid}-${Date.now()}-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await releaseProcessLock(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  it('acquires a lock and writes the PID file', async () => {
    const result = await acquireProcessLock(testDir);

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(testDir, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);
  });

  it('detects a live process and refuses to acquire', async () => {
    const first = await acquireProcessLock(testDir);
    expect(first.acquired).toBe(true);

    const second = await acquireProcessLock(testDir);
    expect(second.acquired).toBe(false);
    expect(second.existingPid).toBe(process.pid);
  });

  it('recovers from a stale lock (dead PID)', async () => {
    // Write a PID file for a process that definitely doesn't exist
    // 0x7fffffff is the largest 32-bit positive integer; very unlikely to be a real PID
    await writeFile(path.join(testDir, 'nexus.pid'), '2147483647');

    const result = await acquireProcessLock(testDir);

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(testDir, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);
  });

  it('recovers from a corrupt lock file (non-numeric content)', async () => {
    await writeFile(path.join(testDir, 'nexus.pid'), 'not-a-pid\n');

    const result = await acquireProcessLock(testDir);

    expect(result.acquired).toBe(true);
  });

  it('releaseProcessLock removes the PID file', async () => {
    await acquireProcessLock(testDir);

    await releaseProcessLock(testDir);

    await expect(stat(path.join(testDir, 'nexus.pid'))).rejects.toThrow();
  });

  it('releaseProcessLock is idempotent (no error if no lock)', async () => {
    await expect(releaseProcessLock(testDir)).resolves.toBeUndefined();
  });

  it('creates the storage directory if it does not exist', async () => {
    const nestedDir = path.join(testDir, 'subdir-' + randomUUID());

    const result = await acquireProcessLock(nestedDir);

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(nestedDir, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);

    // Verify directory exists
    const dirStat = await stat(nestedDir);
    expect(dirStat.isDirectory()).toBe(true);
  });
});
