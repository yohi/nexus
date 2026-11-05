'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RUN_LIMIT_BYTES = 512 * 1024 * 1024;

function makeLockError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cleanupOwnedLock(lockPath, lockFd, lockIdentity) {
  try {
    const current = fs.lstatSync(lockPath);
    if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
      const currentFd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let actual;
      try {
        actual = fs.fstatSync(currentFd);
      } finally {
        fs.closeSync(currentFd);
      }
      if (actual.dev !== lockIdentity.dev || actual.ino !== lockIdentity.ino) {
        return makeLockError('profile_budget_lock_replaced');
      }
      return makeLockError('profile_budget_lock_identity_unverified');
    }
    fs.unlinkSync(lockPath);
    return undefined;
  } catch (error) {
    return error;
  }
}

function throwCleanupErrors(cleanupErrors) {
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  const error = new AggregateError(cleanupErrors, 'profile_budget_lock_cleanup_failed');
  error.code = 'profile_budget_lock_cleanup_failed';
  throw error;
}

function withProfileRunBudget(runDirectoryFd, profileDirectoryFd, requestedBytes, write) {
  const lockPath = `/proc/self/fd/${runDirectoryFd}/profile-budget.lock`;
  const directoryPath = `/proc/self/fd/${profileDirectoryFd}`;
  const lockFd = fs.openSync(lockPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let lockIdentity;
  let operationFailed = false;
  let operationError;
  let result = false;
  const cleanupErrors = [];
  try {
    lockIdentity = fs.fstatSync(lockFd);
    let usedBytes = 0;
    let budgetExceeded = false;
    for (const name of fs.readdirSync(directoryPath)) {
      const entry = fs.lstatSync(path.join(directoryPath, name));
      if (!entry.isFile() || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error('profile_budget_invalid_entry');
      }
      usedBytes += entry.size;
      if (!Number.isSafeInteger(usedBytes) || usedBytes > RUN_LIMIT_BYTES) {
        budgetExceeded = true;
        break;
      }
    }
    if (!budgetExceeded && requestedBytes <= RUN_LIMIT_BYTES - usedBytes) {
      write();
      result = true;
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  if (lockIdentity !== undefined) {
    const cleanupError = cleanupOwnedLock(lockPath, lockFd, lockIdentity);
    if (cleanupError !== undefined) cleanupErrors.push(cleanupError);
  }
  try {
    fs.closeSync(lockFd);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationFailed) {
    if (cleanupErrors.some((error) => error.code === 'profile_budget_lock_replaced')) {
      throwCleanupErrors([operationError, ...cleanupErrors]);
    }
    throw operationError;
  }
  if (cleanupErrors.length > 0) throwCleanupErrors(cleanupErrors);
  return result;
}

module.exports = { withProfileRunBudget };
