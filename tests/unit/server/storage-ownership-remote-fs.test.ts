import type * as Fs from 'node:fs';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Nexus #297: the coordination root must refuse network/userspace filesystems. A real NFS/SMB/FUSE/Ceph mount is not
// available in unit tests, so statfs(2) is simulated for the coordination root only; every other filesystem call is
// real. This proves the refusal branch and its ordering, not behavior on a physical remote mount.
const simulated = vi.hoisted(() => ({ root: '', type: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    statfsSync: ((path: string, options?: unknown) => {
      const real = actual.statfsSync(path, options as never);
      return path === simulated.root ? { ...real, type: simulated.type } : real;
    }) as typeof actual.statfsSync,
  };
});

// The shared Vitest setup file already loaded claims.ts with the real node:fs; reload it under the mock.
vi.resetModules();
const { prepareCoordinationRoot } = await import('../../../src/server/storage-ownership/claims.js');

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function coordinationRoot(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-remote-fs-')));
  dirs.push(base);
  simulated.root = join(base, 'coord');
  return simulated.root;
}

describe('coordination root filesystem type', () => {
  it.each([
    ['NFS', 0x6969], ['SMB', 0x517b], ['CIFS', 0xff534d42], ['SMB2', 0xfe534d42], ['FUSE', 0x65735546], ['CEPH', 0x00c36400],
  ])('refuses a %s coordination root before creating lock directories', async (_name, type) => {
    const root = await coordinationRoot();
    simulated.type = type;
    await expect(prepareCoordinationRoot(root, [])).rejects.toThrow('remote or userspace filesystem');
    expect(await readdir(root)).toEqual([]); // no resource/ or writer/ lock directory was created
  });

  it('accepts a local filesystem type', async () => {
    const root = await coordinationRoot();
    simulated.type = 0xef53; // ext2/3/4
    await expect(prepareCoordinationRoot(root, [])).resolves.toBe(root);
    expect((await readdir(root)).sort()).toEqual(['resource', 'writer']);
  });
});
