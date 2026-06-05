import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

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
 *
 * The caller MUST invoke `releaseProcessLock` on shutdown to free the lock.
 */
export async function acquireProcessLock(storageDir: string): Promise<LockResult> {
  const lockPath = path.join(storageDir, LOCK_FILENAME);

  // Step 1: Inspect any existing lock and decide whether to reclaim it.
  try {
    const content = await readFile(lockPath, 'utf8');
    const existingPid = Number.parseInt(content.trim(), 10);

    if (Number.isNaN(existingPid) || existingPid <= 0) {
      // Corrupt lock file - remove and proceed.
      await safeUnlink(lockPath);
    } else if (isProcessAlive(existingPid)) {
      return { acquired: false, existingPid };
    } else {
      // Stale lock (process no longer exists) - remove and proceed.
      await safeUnlink(lockPath);
    }
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

function isProcessAlive(pid: number): boolean {
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
