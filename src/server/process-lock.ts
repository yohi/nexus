import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../types/index.js';
import { assertLiveWriterAdmission, type WriterAdmission } from './storage-ownership/admission.js';

export interface LockResult {
  acquired: boolean;
  existingPid?: number;
}

export const LOCK_FILENAME = 'nexus.pid';

/**
 * Attempts to acquire a single-instance lock for the given storage directory.
 *
 * Behavior:
 * - Atomically creates `${storageDir}/nexus.pid` containing the current PID.
 * - If the lock file already exists, verifies the recorded PID is still alive
 *   via `process.kill(pid, 0)`. If the process is dead (or the file is corrupt),
 *   the stale lock is removed and acquisition is retried.
 * - If the recorded PID is alive, returns `{ acquired: false, existingPid }`.
 * - Nexus #297: removing a stale/corrupt PID file requires the caller's live, ISSUED writer admission for exactly this
 *   storage root (authenticated by the admission service). An admission for a different root never removes an
 *   existing PID file (reported as not acquired); a forged/released/consumed handle is rejected before any unlink.
 *
 * The caller MUST invoke `releaseOwnedProcessLock` (or `releaseProcessLock`) on shutdown to free the lock.
 */
export async function acquireProcessLock(storageDir: string,
  admission: { readonly handle: WriterAdmission; readonly config: Config }): Promise<LockResult> {
  const lockPath = path.join(storageDir, LOCK_FILENAME);
  const mayReclaim = async (): Promise<boolean> => {
    if (path.resolve(admission.config.storage.rootDir) !== path.resolve(storageDir)) return false;
    await assertLiveWriterAdmission(admission.handle, admission.config);
    return true;
  };

  // Ensure the storage directory exists before trying to read or write the lock file.
  await mkdir(path.resolve(storageDir), { recursive: true });

  // Step 1: Inspect any existing lock and decide whether to reclaim it.
  try {
    const content = await readFile(lockPath, 'utf8');
    const existingPid = Number.parseInt(content.trim(), 10);

    const corrupt = Number.isNaN(existingPid) || existingPid <= 0;
    if (!corrupt && isProcessAlive(existingPid)) {
      return { acquired: false, existingPid };
    }
    if (!(await mayReclaim())) {
      return corrupt ? { acquired: false } : { acquired: false, existingPid };
    }
    // Corrupt or stale lock (process no longer exists) under a live writer admission - remove and proceed.
    await safeUnlink(lockPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
    // No lock file exists - proceed to acquire.
  }

  // Step 2: Acquire lock atomically via O_EXCL ('wx').
  try {
    const fd = await open(lockPath, 'wx');
    try {
      await fd.writeFile(`${process.pid}\n`);
    } finally {
      await fd.close();
    }
    return { acquired: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      // Race: another process acquired between our check and create.
      // Re-read to report the conflicting PID best-effort.
      try {
        const content = await readFile(lockPath, 'utf8');
        const existingPid = Number.parseInt(content.trim(), 10);
        return Number.isNaN(existingPid)
          ? { acquired: false }
          : { acquired: false, existingPid };
      } catch {
        return { acquired: false };
      }
    }
    throw error;
  }
}

/**
 * Releases the process lock by removing the PID file.
 * Safe to call even if no lock is held (idempotent).
 */
export async function releaseProcessLock(storageDir: string): Promise<void> {
  await safeUnlink(path.join(storageDir, LOCK_FILENAME));
}

const ownsPidContent = (content: string): boolean => content.trim() === String(process.pid);

/**
 * Owner-safe release (Nexus #297): removes the PID file only when it records this process. A foreign, stale or
 * corrupt PID file is never removed by shutdown or exit cleanup. Idempotent.
 */
export async function releaseOwnedProcessLock(storageDir: string): Promise<void> {
  const lockPath = path.join(storageDir, LOCK_FILENAME);
  let content: string;
  try { content = await readFile(lockPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (ownsPidContent(content)) await safeUnlink(lockPath);
}

/** Synchronous best-effort variant of `releaseOwnedProcessLock` for the process `exit` event. Never throws. */
export function releaseOwnedProcessLockSync(storageDir: string): void {
  const lockPath = path.join(storageDir, LOCK_FILENAME);
  try {
    if (ownsPidContent(readFileSync(lockPath, 'utf8'))) unlinkSync(lockPath);
  } catch {
    // Missing or unreadable: a stale lock is detected by the next startup.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 does not actually deliver a signal; it only checks
    // if the process exists and we have permission to signal it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EPERM means the process exists but we don't have permission - still alive.
    return err.code === 'EPERM';
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }
}
