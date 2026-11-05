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
  let result = false;
  let operationError;
  let cleanupError;
  let lockReplaced = false;
  try {
    lockIdentity = fs.fstatSync(lockFd);
    let usedBytes = 0;
    for (const name of fs.readdirSync(directoryPath)) {
      const entry = fs.lstatSync(path.join(directoryPath, name));
      if (!entry.isFile() || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error('profile_budget_invalid_entry');
      }
      usedBytes += entry.size;
      if (!Number.isSafeInteger(usedBytes) || usedBytes > RUN_LIMIT_BYTES) break;
    }
    if (usedBytes <= RUN_LIMIT_BYTES && requestedBytes <= RUN_LIMIT_BYTES - usedBytes) {
      write();
      result = true;
    }
  } catch (error) {
    operationError = error;
  }

  try {
    if (lockIdentity !== undefined) {
      try {
        const current = fs.lstatSync(lockPath);
        if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) lockReplaced = true;
        else fs.unlinkSync(lockPath);
      } catch (error) {
        cleanupError = error;
      }
    }
  } finally {
    fs.closeSync(lockFd);
  }

  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (lockReplaced) throw new Error('profile_budget_lock_replaced');
  return result;
}

module.exports = { withProfileRunBudget };
