import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveStorageOwnershipTargets, storageTargetsFingerprint } from '../../../src/server/storage-ownership/index.js';
import type { Config } from '../../../src/types/index.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function sandbox(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'nexus-targets-')));
  dirs.push(d);
  return d;
}
const cfg = (projectRoot: string, rootDir: string, metadataDbPath: string, vectorDbPath: string): Config =>
  ({ projectRoot, storage: { rootDir, metadataDbPath, vectorDbPath } }) as unknown as Config;

describe('resolveStorageOwnershipTargets', () => {
  it('canonicalizes_existing_symlink_alias', async () => {
    const base = await sandbox();
    await mkdir(join(base, 'real'));
    await symlink(join(base, 'real'), join(base, 'alias'));
    const t = await resolveStorageOwnershipTargets(cfg(base, join(base, 'alias'), join(base, 'alias', 'm.db'), join(base, 'alias', 'v')));
    expect(t.rootDir.path).toBe(join(base, 'real'));
    expect(t.metadataDbPath.path).toBe(join(base, 'real', 'm.db'));
    expect(t.vectorDbPath).toEqual({ kind: 'persistent', path: join(base, 'real', 'v') });
  });

  it('canonicalizes_missing_target_from_verified_ancestor', async () => {
    const base = await sandbox();
    await mkdir(join(base, 'real'));
    await symlink(join(base, 'real'), join(base, 'alias'));
    const t = await resolveStorageOwnershipTargets(cfg(base, join(base, 'alias', 'a', 'b'), join(base, 'alias', 'a', 'b', 'm.db'), join(base, 'alias', 'a', 'v')));
    expect(t.rootDir.path).toBe(join(base, 'real', 'a', 'b'));
    const { access } = await import('node:fs/promises');
    await expect(access(join(base, 'real', 'a'))).rejects.toThrow();
  });

  it('rejects_unsafe_sqlite_hardlink_and_dangling_alias', async () => {
    const base = await sandbox();
    await writeFile(join(base, 'orig.db'), 'x');
    await link(join(base, 'orig.db'), join(base, 'm.db'));
    await expect(resolveStorageOwnershipTargets(cfg(base, join(base, 's'), join(base, 'm.db'), 'memory://'))).rejects.toThrow(/hard-linked/);
    await symlink(join(base, 'nowhere'), join(base, 'dangling'));
    await expect(resolveStorageOwnershipTargets(cfg(base, join(base, 'dangling'), join(base, 'x.db'), 'memory://'))).rejects.toThrow(/dangling/);
  });

  it.each(['-wal', '-shm', '-journal'])('rejects_vector_target_at_metadata_sidecar%s', async (sidecar) => {
    const base = await sandbox();
    const metadata = join(base, 'storage', 'metadata.db');
    await expect(resolveStorageOwnershipTargets(cfg(base, join(base, 'storage'), metadata,
      `${metadata}${sidecar}`))).rejects.toThrow(/overlap|ambiguous/i);
  });

  it('rejects_root_target_at_metadata_sidecar', async () => {
    const base = await sandbox();
    const metadata = join(base, 'metadata.db');
    await expect(resolveStorageOwnershipTargets(cfg(base, `${metadata}-wal`, metadata, join(base, 'vectors'))))
      .rejects.toThrow(/metadata sidecar/i);
  });

  it('classifies_only_exact_memory_sentinel', async () => {
    const base = await sandbox();
    const mk = (v: string) => resolveStorageOwnershipTargets(cfg(base, join(base, 's'), join(base, 's', 'm.db'), v));
    expect((await mk('memory://')).vectorDbPath).toEqual({ kind: 'ephemeral', source: 'memory://' });
    expect((await mk('')).vectorDbPath.kind).toBe('ephemeral');
    await expect(mk('memory://x')).rejects.toThrow(/Unsupported/);
    await expect(mk('s3://bucket/v')).rejects.toThrow(/Unsupported/);
    expect((await mk('Memory:/')).vectorDbPath.kind).toBe('persistent');
  });

  it('supports_non_git_project', async () => {
    const base = await sandbox();
    const t = await resolveStorageOwnershipTargets(cfg(base, join(base, '.nexus'), join(base, '.nexus', 'metadata.db'), join(base, '.nexus', 'vectors')));
    expect(t.ownerProjectRoot).toBe(base);
    expect(storageTargetsFingerprint(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(storageTargetsFingerprint(t)).toBe(storageTargetsFingerprint({ ...t }));
  });

  it('preserves_effective_custom_relative_path_semantics', async () => {
    const base = await sandbox();
    // Relative paths resolve against process cwd (as StorageManager does), never against projectRoot.
    const rel = relative(process.cwd(), join(base, 'custom'));
    const t = await resolveStorageOwnershipTargets(cfg(join(base, 'proj-not-used'), rel, `${rel}/m.db`, `${rel}/v`));
    expect(t.rootDir.path).toBe(join(base, 'custom'));
    expect(t.vectorDbPath).toEqual({ kind: 'persistent', path: join(base, 'custom', 'v') });
    const e1 = storageTargetsFingerprint(await resolveStorageOwnershipTargets(cfg(base, rel, `${rel}/m.db`, 'memory://')));
    const e2 = storageTargetsFingerprint(await resolveStorageOwnershipTargets(cfg(base, rel, `${rel}/m.db`, '')));
    expect(e1).toBe(e2);
  });
});
