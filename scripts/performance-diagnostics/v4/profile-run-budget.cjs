'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RUN_LIMIT_BYTES = 512 * 1024 * 1024;

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
    try {
      const current = fs.lstatSync(lockPath);
      if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
        const error = new Error('profile_budget_lock_replaced');
        error.code = 'profile_budget_lock_replaced';
        throw error;
      }
      fs.unlinkSync(lockPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    fs.closeSync(lockFd);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationFailed) throw operationError;
  if (cleanupErrors.length > 0) {
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    const error = new AggregateError(cleanupErrors, 'profile_budget_lock_cleanup_failed');
    error.code = 'profile_budget_lock_cleanup_failed';
    throw error;
  }
  return result;
}

module.exports = { withProfileRunBudget };
