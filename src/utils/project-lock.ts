import path from 'node:path';

import lockfile from 'proper-lockfile';

export const PROJECT_LOCK_FILENAME = '.nexus-lock';
const PROJECT_LOCK_STALE_MS = 5000;
const PROJECT_LOCK_RETRIES = 0;
const PROJECT_LOCK_ERROR_MESSAGE = (rootDir: string): string =>
  `Another Nexus process is already running for this project (${rootDir}). Only one instance per project is allowed.`;

export interface ProjectLockHandle {
  release: () => Promise<void>;
}

export const acquireProjectLock = async (rootDir: string): Promise<ProjectLockHandle> => {
  const projectRoot = path.resolve(rootDir);
  const lockfilePath = path.join(projectRoot, PROJECT_LOCK_FILENAME);

  try {
    const release = await lockfile.lock(projectRoot, {
      lockfilePath,
      retries: PROJECT_LOCK_RETRIES,
      stale: PROJECT_LOCK_STALE_MS,
    });

    return { release };
  } catch (error: unknown) {
    if (isLockHeldError(error)) {
      throw new Error(PROJECT_LOCK_ERROR_MESSAGE(rootDir));
    }

    throw error;
  }
};

export const isProjectLocked = async (rootDir: string): Promise<boolean> => {
  const projectRoot = path.resolve(rootDir);

  return lockfile.check(projectRoot, {
    lockfilePath: path.join(projectRoot, PROJECT_LOCK_FILENAME),
    stale: PROJECT_LOCK_STALE_MS,
  });
};

const isLockHeldError = (error: unknown): error is Error & { code: string } => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return Reflect.get(error, 'code') === 'ELOCKED';
};
