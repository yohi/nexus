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
  try {
    lockIdentity = fs.fstatSync(lockFd);
    let usedBytes = 0;
    for (const name of fs.readdirSync(directoryPath)) {
      const entry = fs.lstatSync(path.join(directoryPath, name));
      if (!entry.isFile() || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error('profile_budget_invalid_entry');
      }
      usedBytes += entry.size;
      if (!Number.isSafeInteger(usedBytes) || usedBytes > RUN_LIMIT_BYTES) return false;
    }
    if (requestedBytes > RUN_LIMIT_BYTES - usedBytes) return false;
    write();
    return true;
  } finally {
    try {
      if (lockIdentity !== undefined) {
        const current = fs.lstatSync(lockPath);
        if (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
          throw new Error('profile_budget_lock_replaced');
        }
        fs.unlinkSync(lockPath);
      }
    } finally {
      fs.closeSync(lockFd);
    }
  }
}

module.exports = { withProfileRunBudget };
