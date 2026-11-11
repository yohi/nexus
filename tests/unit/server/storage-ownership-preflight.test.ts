import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimPathFor, DIRECTORY_CLAIM_FILENAME, inspectStorageOwnership, resolveStorageOwnershipTargets,
} from '../../../src/server/storage-ownership/index.js';
import type { Config } from '../../../src/types/index.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function sandbox(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'nexus-preflight-')));
  dirs.push(d);
  return d;
}
const cfg = (projectRoot: string, root: string, vector = join(root, 'vectors')): Config =>
  ({ projectRoot, storage: { rootDir: root, metadataDbPath: join(root, 'metadata.db'), vectorDbPath: vector } }) as unknown as Config;
const claimJson = (owner: string, resourcePath: string, kind: 'file' | 'directory') =>
  JSON.stringify({ version: 1, ownerProjectRoot: owner, resourcePath, kind });
async function claimAll(owner: string, root: string, withVector = true): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, DIRECTORY_CLAIM_FILENAME), claimJson(owner, root, 'directory'));
  await writeFile(claimPathFor(join(root, 'metadata.db'), 'file'), claimJson(owner, join(root, 'metadata.db'), 'file'));
  if (withVector) {
    const v = join(root, 'vectors');
    await mkdir(v);
    await writeFile(join(v, DIRECTORY_CLAIM_FILENAME), claimJson(owner, v, 'directory'));
  }
}
const inspect = async (c: Config) => inspectStorageOwnership(await resolveStorageOwnershipTargets(c));

describe('inspectStorageOwnership', () => {
  it('refuses an invalid external-storage witness before changing coordination or empty storage', async () => {
    const base = await sandbox();
    const project = join(base, 'project');
    const root = join(base, 'empty-storage');
    const coordination = join(base, 'coordination');
    await mkdir(project);
    await mkdir(join(project, '.nexus'));
    await writeFile(join(project, '.nexus', 'worktree-witness'), '{invalid');
    const before = await Promise.all([root, coordination].map(async (path) => {
      try { return await lstat(path); } catch { return undefined; }
    }));
    const result = await inspect(cfg(project, root));
    expect(result.disposition).toBe('refuse');
    expect(result.reason).toMatch(/worktree witness/i);
    const after = await Promise.all([root, coordination].map(async (path) => {
      try { return await lstat(path); } catch { return undefined; }
    }));
    expect(after).toEqual(before);
  });

  it('permits first admission when an external-storage witness is absent', async () => {
    const base = await sandbox();
    const project = join(base, 'project');
    await mkdir(project);
    expect((await inspect(cfg(project, join(base, 'fresh-storage')))).disposition).toBe('unclaimed-clean');
  });

  it('S05_disjoint_clean_targets_are_unclaimed_clean', async () => {
    const base = await sandbox();
    expect((await inspect(cfg(base, join(base, 'missing')))).disposition).toBe('unclaimed-clean');
    await mkdir(join(base, 'empty', 'vectors'), { recursive: true });
    expect((await inspect(cfg(base, join(base, 'empty')))).disposition).toBe('unclaimed-clean');
  });

  it('owned_when_all_claims_match_same_owner', async () => {
    const base = await sandbox();
    await claimAll(base, join(base, 's'));
    expect((await inspect(cfg(base, join(base, 's')))).disposition).toBe('owned');
  });

  it('S02_foreign_metadata_owner_is_refused_read_only', async () => {
    const base = await sandbox();
    await claimAll(join(base, 'other'), join(base, 's'));
    const r = await inspect(cfg(base, join(base, 's')));
    expect(r.disposition).toBe('refuse');
    expect(r.reason).toMatch(/different project/);
  });

  it('S12_ephemeral_does_not_bypass_metadata', async () => {
    const base = await sandbox();
    await claimAll(join(base, 'other'), join(base, 's'), false);
    expect((await inspect(cfg(base, join(base, 's'), 'memory://'))).disposition).toBe('refuse');
    await claimAll(base, join(base, 'mine'), false);
    expect((await inspect(cfg(base, join(base, 'mine'), 'memory://'))).disposition).toBe('owned');
  });

  it('S08_nonempty_unclaimed_refuses', async () => {
    const base = await sandbox();
    await mkdir(join(base, 's'));
    await writeFile(join(base, 's', 'stranger.txt'), 'x');
    expect((await inspect(cfg(base, join(base, 's')))).disposition).toBe('refuse');
    await rm(join(base, 's', 'stranger.txt'));
    await writeFile(join(base, 's', 'metadata.db'), 'legacy');
    expect((await inspect(cfg(base, join(base, 's')))).disposition).toBe('refuse');
  });

  it('in_flight_claim_temp_files_do_not_refuse_and_are_left_untouched', async () => {
    const base = await sandbox();
    const root = join(base, 's');
    const vectors = join(root, 'vectors');
    await mkdir(vectors, { recursive: true });
    // publishClaim() temp files between fsync and link: root dir claim, adjacent metadata claim, vector dir claim.
    const temps = [
      `${join(root, DIRECTORY_CLAIM_FILENAME)}.tmp-4242-0123456789ab`,
      `${claimPathFor(join(root, 'metadata.db'), 'file')}.tmp-4242-abcdef012345`,
      `${join(vectors, DIRECTORY_CLAIM_FILENAME)}.tmp-17-00ff00ff00ff`,
    ];
    for (const temp of temps) await writeFile(temp, '{"partial":');
    expect((await inspect(cfg(base, root))).disposition).toBe('unclaimed-clean');
    for (const temp of temps) expect((await stat(temp)).isFile()).toBe(true); // never deleted
  });

  it('look_alike_claim_temp_names_still_refuse', async () => {
    const base = await sandbox();
    const root = join(base, 's');
    for (const name of [`${DIRECTORY_CLAIM_FILENAME}.tmp-4242-XYZ`, `${DIRECTORY_CLAIM_FILENAME}.tmp-abc-0123456789ab`,
      `${DIRECTORY_CLAIM_FILENAME}.tmp-4242-0123456789ab.extra`, `other.json.tmp-4242-0123456789ab`]) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, name), 'x');
      expect((await inspect(cfg(base, root))).disposition).toBe('refuse');
      await rm(root, { recursive: true });
    }
    // A directory carrying a valid temp name is not a publication artifact.
    await mkdir(join(root, `${DIRECTORY_CLAIM_FILENAME}.tmp-4242-0123456789ab`), { recursive: true });
    expect((await inspect(cfg(base, root))).disposition).toBe('refuse');
  });

  it('S04_nested_foreign_owner_refuses', async () => {
    const base = await sandbox();
    await claimAll(join(base, 'other'), join(base, 'outer'), false);
    const r = await inspect(cfg(base, join(base, 'outer', 'inner')));
    expect(r.disposition).toBe('refuse');
    await mkdir(join(base, 'bad'));
    await writeFile(join(base, 'bad', DIRECTORY_CLAIM_FILENAME), '{not json');
    expect((await inspect(cfg(base, join(base, 'bad')))).disposition).toBe('refuse');
  });

  it('inspection_never_creates_pid_endpoint_or_claim', async () => {
    const base = await sandbox();
    const root = join(base, 'fresh');
    await inspect(cfg(base, root));
    await expect(stat(root)).rejects.toThrow();
    await mkdir(root);
    await inspect(cfg(base, root));
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(base)).toEqual(['fresh']);
  });
});
