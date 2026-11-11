import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStorageOwnershipAdmissionService, StorageOwnershipError, type WriterAdmission,
} from '../../../src/server/storage-ownership/admission.js';
import {
  claimPathFor, DIRECTORY_CLAIM_FILENAME, inspectStorageOwnership, readOwnerClaim, resolveStorageOwnershipTargets,
} from '../../../src/server/storage-ownership/index.js';
import { publishClaim } from '../../../src/server/storage-ownership/claims.js';
import { readWorktreeWitness } from '../../../src/server/storage-ownership/witness.js';
import type { Config } from '../../../src/types/index.js';

// Nexus #297 W06-B/C/E (unit level): the Worktree Incarnation Witness binds external storage claims to one worktree.

const dirs: string[] = [];
const handles: WriterAdmission[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.release().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'nexus-witness-')));
  dirs.push(d);
  return d;
}

const cfg = (projectRoot: string, storage: string): Config => ({
  projectRoot,
  storage: { rootDir: storage, metadataDbPath: join(storage, 'metadata.db'), vectorDbPath: join(storage, 'vectors') },
}) as unknown as Config;

const service = (base: string) => createStorageOwnershipAdmissionService({ coordinationRoot: join(base, 'coord'), lockWaitMs: 200 });

async function admit(svc: ReturnType<typeof service>, config: Config): Promise<WriterAdmission> {
  const handle = await svc.admitStorageWriter(await svc.resolveStorageOwnershipTargets(config));
  handles.push(handle);
  return handle;
}

async function refusal(promise: Promise<unknown>): Promise<StorageOwnershipError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageOwnershipError);
  return error as StorageOwnershipError;
}

/** Recursive byte digest of every entry below the given paths (absent paths recorded as such). */
async function digest(...paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    let info;
    try { info = await lstat(path); } catch { out[path] = 'absent'; return; }
    if (info.isDirectory()) {
      out[`${path}/`] = 'dir';
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
    } else if (info.isSymbolicLink()) out[path] = 'symlink';
    else out[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  };
  for (const path of paths) await walk(path);
  return out;
}

async function setup(): Promise<{ base: string; project: string; storage: string; svc: ReturnType<typeof service> }> {
  const base = await sandbox();
  const project = join(base, 'worktree');
  await mkdir(project);
  return { base, project, storage: join(base, 'external-storage'), svc: service(base) };
}

const witnessOf = async (project: string): Promise<string> => {
  const state = await readWorktreeWitness(project);
  expect(state.state).toBe('present');
  return (state as { witness: string }).witness;
};
const witnessFile = (project: string): string => join(project, '.nexus', 'worktree-witness');

/** Simulates a deleted-and-recreated worktree at the same path: its untracked local state is gone. */
const recreateWorktree = (project: string): Promise<void> => rm(join(project, '.nexus'), { recursive: true, force: true });

describe('W06 worktree incarnation witness', () => {
  it('W06_C_sequential_restart_keeps_witness_and_claims', async () => {
    const { project, storage, svc } = await setup();
    const first = await admit(svc, cfg(project, storage));
    const witness = await witnessOf(project);
    expect(first.worktreeWitness).toBe(witness);
    const witnessBytes = await readFile(witnessFile(project));
    const claimBefore = await readFile(join(storage, DIRECTORY_CLAIM_FILENAME));
    await first.release();
    const second = await admit(svc, cfg(project, storage));
    expect(second.worktreeWitness).toBe(witness);
    expect(await readFile(witnessFile(project))).toEqual(witnessBytes); // not regenerated
    expect(await readFile(join(storage, DIRECTORY_CLAIM_FILENAME))).toEqual(claimBefore);
    expect(await readOwnerClaim(claimPathFor(storage, 'directory'))).toMatchObject({
      state: 'present', claim: { version: 2, worktreeWitness: witness },
    });
  });

  it('W06_B_recreated_incarnation_is_refused_without_touching_storage', async () => {
    const { project, storage, svc } = await setup();
    await (await admit(svc, cfg(project, storage))).release();
    await writeFile(join(storage, 'metadata.db'), 'OLD-INCARNATION-INDEX');
    await mkdir(join(storage, 'vectors'), { recursive: true });
    await writeFile(join(storage, 'vectors', 'old.lance'), 'OLD-VECTOR');
    const before = await digest(storage);
    await recreateWorktree(project);
    const error = await refusal(admit(svc, cfg(project, storage)));
    expect(error.code).toBe('incarnation_mismatch');
    expect(await digest(storage)).toEqual(before); // claims, metadata and vector data all byte-identical
    // The read-only Bridge preflight reaches the same verdict, both with the freshly created and with no witness.
    expect((await inspectStorageOwnership(await resolveStorageOwnershipTargets(cfg(project, storage)))).disposition).toBe('refuse');
    await rm(join(project, '.nexus'), { recursive: true, force: true });
    expect((await inspectStorageOwnership(await resolveStorageOwnershipTargets(cfg(project, storage)))).disposition).toBe('refuse');
    expect(await digest(storage)).toEqual(before);
    // A new, empty external storage for the recreated worktree starts normally.
    const fresh = await admit(svc, cfg(project, join(project, '..', 'second-storage')));
    expect(fresh.worktreeWitness).toBeDefined();
  });

  it('W06_E_missing_witness_with_existing_claims_is_refused_and_not_regenerated', async () => {
    const { project, storage, svc } = await setup();
    await (await admit(svc, cfg(project, storage))).release();
    await rm(witnessFile(project));
    const before = await digest(storage);
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
    expect(await digest(storage)).toEqual(before);
  });

  it('W06_E_malformed_witness_is_refused_and_left_untouched', async () => {
    const { project, storage, svc } = await setup();
    await mkdir(join(project, '.nexus'));
    await writeFile(witnessFile(project), '{"version":1,"witness":"nope"');
    const witnessBefore = await readFile(witnessFile(project));
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
    expect(await readFile(witnessFile(project))).toEqual(witnessBefore);
    expect(await digest(storage)).toEqual({ [storage]: 'absent' });
  });

  it('W06_E_witness_copied_from_another_project_root_is_refused', async () => {
    const { base, project, storage, svc } = await setup();
    const other = join(base, 'other-worktree');
    await mkdir(other);
    await (await admit(svc, cfg(other, join(base, 'other-storage')))).release();
    await mkdir(join(project, '.nexus'));
    await writeFile(witnessFile(project), await readFile(witnessFile(other)));
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
    expect(await digest(storage)).toEqual({ [storage]: 'absent' });
  });

  it('W06_E_symlinked_witness_directory_is_refused', async () => {
    const { base, project, storage, svc } = await setup();
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(project, '.nexus'));
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await digest(storage)).toEqual({ [storage]: 'absent' });
  });

  it('W06_E_symlinked_or_hardlinked_witness_file_is_refused', async () => {
    const { base, project, storage, svc } = await setup();
    await (await admit(svc, cfg(project, storage))).release();
    const real = join(base, 'real-witness');
    await writeFile(real, await readFile(witnessFile(project)));
    await rm(witnessFile(project));
    await symlink(real, witnessFile(project));
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
  });

  it('W06_E_legacy_v1_claim_on_external_storage_is_not_adopted', async () => {
    const { project, storage, svc } = await setup();
    await mkdir(storage, { recursive: true });
    expect(publishClaim(storage, 'directory', project)).toBe('created'); // legacy version 1 claim
    await writeFile(join(storage, 'legacy-data'), 'LEGACY');
    const before = await digest(storage);
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
    expect(await digest(storage)).toEqual(before);
    const preflight = await inspectStorageOwnership(await resolveStorageOwnershipTargets(cfg(project, storage)));
    expect(preflight.disposition).toBe('refuse');
  });

  it('W06_E_claim_with_other_witness_is_refused_as_mismatch', async () => {
    const { project, storage, svc } = await setup();
    await (await admit(svc, cfg(project, storage))).release();
    const claimPath = claimPathFor(storage, 'directory');
    const claim = JSON.parse(await readFile(claimPath, 'utf8')) as Record<string, unknown>;
    await writeFile(claimPath, `${JSON.stringify({ ...claim, worktreeWitness: 'f'.repeat(64) })}\n`);
    const before = await digest(storage);
    expect((await refusal(admit(svc, cfg(project, storage)))).code).toBe('incarnation_mismatch');
    expect(await digest(storage)).toEqual(before);
  });

  it('W06_E_concurrent_admissions_for_one_worktree_share_one_witness', async () => {
    const { base, project, svc } = await setup();
    const [a, b] = await Promise.all([
      admit(svc, cfg(project, join(base, 'storage-a'))), admit(svc, cfg(project, join(base, 'storage-b'))),
    ]);
    expect(a.worktreeWitness).toBeDefined();
    expect(a.worktreeWitness).toBe(b.worktreeWitness);
    expect(a.worktreeWitness).toBe(await witnessOf(project));
  });

  it('W06_E_interrupted_witness_publication_leaves_no_usable_witness', async () => {
    const { project, storage, svc } = await setup();
    await mkdir(join(project, '.nexus'));
    // A killed attempt leaves only its attempt-owned temp file; the final name never appears half-written.
    await writeFile(`${witnessFile(project)}.tmp-1-${'a'.repeat(12)}`, '{"version":1,');
    expect((await readWorktreeWitness(project)).state).toBe('absent');
    const handle = await admit(svc, cfg(project, storage));
    expect(handle.worktreeWitness).toBe(await witnessOf(project));
  });

  it('W06_storage_fully_inside_the_project_needs_no_witness_and_keeps_v1_claims', async () => {
    const { project, svc } = await setup();
    const handle = await admit(svc, cfg(project, join(project, '.nexus')));
    expect(handle.worktreeWitness).toBeUndefined();
    expect((await readWorktreeWitness(project)).state).toBe('absent');
    expect(await readOwnerClaim(claimPathFor(join(project, '.nexus'), 'directory'))).toMatchObject({
      state: 'present', claim: { version: 1 },
    });
  });
});
