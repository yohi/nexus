import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  actualLstat: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  filesystem.actualLstat.mockImplementation(actual.lstat);
  return { ...actual, lstat: filesystem.lstat };
});

const roots: string[] = [];
afterEach(async () => {
  filesystem.lstat.mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('readOwnerClaim filesystem identity', () => {
  it('rejects a regular-file replacement between lstat and open', async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'nexus-claim-format-'));
    roots.push(root);
    const original = join(root, 'claim.json');
    const saved = join(root, 'original.json');
    const replacement = JSON.stringify({ version: 1, ownerProjectRoot: '/attacker', resourcePath: '/data', kind: 'directory' });
    await writeFile(original, JSON.stringify({ version: 1, ownerProjectRoot: '/owner', resourcePath: '/data', kind: 'directory' }));
    filesystem.lstat.mockImplementation(async (path: string) => {
      const stat = await filesystem.actualLstat(path);
      if (path === original) {
        await rename(original, saved);
        await writeFile(original, replacement);
      }
      return stat;
    });

    const { readOwnerClaim } = await import('../../../src/server/storage-ownership/claim-format.js');
    const result = await readOwnerClaim(original);
    expect(filesystem.lstat).toHaveBeenCalled();
    expect(result).toEqual({ state: 'invalid', reason: 'claim identity or size changed while opening' });
    expect(await readFile(original, 'utf8')).toBe(replacement);
  });
});
