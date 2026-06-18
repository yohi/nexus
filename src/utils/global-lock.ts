import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

const GLOBAL_LOCK_STALE_MS = 5000;
const GLOBAL_LOCK_RETRIES = 0;
const GLOBAL_LOCK_ERROR_MESSAGE = (name: string): string =>
  `Nexus global resource "${name}" is already in use by another process.`;

export interface GlobalLockHandle {
  release: () => Promise<void>;
}

export const acquireGlobalLock = async (name: string): Promise<GlobalLockHandle> => {
  const lockfilePath = join(tmpdir(), `nexus-global-${name}.lock`);
  // proper-lockfile requires the target file to exist
  await writeFile(lockfilePath, '', { flag: 'wx' }).catch((err: unknown) => {
    // Ignore only if file already exists
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
  try {
    const release = await lockfile.lock(lockfilePath, {
      retries: GLOBAL_LOCK_RETRIES,
      stale: GLOBAL_LOCK_STALE_MS,
    });
    return { release };
  } catch (error: unknown) {
    if (isLockHeldError(error)) {
      throw new Error(GLOBAL_LOCK_ERROR_MESSAGE(name));
    }
    throw error;
  }
};

const isLockHeldError = (error: unknown): error is Error & { code: string } => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return Reflect.get(error, 'code') === 'ELOCKED';
};
