import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  acquireGlobalLock,
  GLOBAL_LOCK_RETRIES,
  GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS,
  GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS,
  GLOBAL_LOCK_STALE_MS,
} from '../../../src/utils/global-lock.js';

describe('global-lock', () => {
  it('acquires and releases a global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lock = await acquireGlobalLock(name);
    await lock.release();
  });

  it('throws when another instance holds the same global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lock = await acquireGlobalLock(name);
    try {
      await expect(acquireGlobalLock(name)).rejects.toThrow('already in use');
    } finally {
      await lock.release();
    }
  });

  it('different names do not conflict', async () => {
    const name1 = `test-${randomUUID()}`;
    const name2 = `test-${randomUUID()}`;
    const lock1 = await acquireGlobalLock(name1);
    const lock2 = await acquireGlobalLock(name2);
    await lock1.release();
    await lock2.release();
  });

  it('uses bounded proper-lockfile stale and retry policy', () => {
    expect(GLOBAL_LOCK_STALE_MS).toBe(60_000);
    expect(GLOBAL_LOCK_RETRIES).toBe(10);
    expect(GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS).toBe(100);
    expect(GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS).toBe(1000);
  });
});
