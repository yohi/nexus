import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAttemptLog } from '../../../src/server/storage-ownership/startup-gate.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('readAttemptLog', () => {
  it('returns only the bounded UTF-8 tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-startup-log-'));
    roots.push(root);
    const path = join(root, 'stderr.log');
    await writeFile(path, 'old output\n0123あ');

    expect(readAttemptLog(path, 5)).toBe('23あ');
  });

  it('preserves a short log and missing-file behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-startup-log-'));
    roots.push(root);
    const path = join(root, 'stderr.log');
    await writeFile(path, 'short log\n');

    expect(readAttemptLog(path, 64)).toBe('short log\n');
    expect(readAttemptLog(join(root, 'missing.log'), 64)).toBe('');
  });
});
