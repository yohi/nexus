import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStorageOwnershipAdmissionService, StorageOwnershipError, type AdmissionInternalOptions, type WriterAdmission,
} from '../../../src/server/storage-ownership/admission.js';
import {
  coordinationRootPath, prepareCoordinationRoot, resourceKey, sqliteFcntlLockBackend, type KernelLockBackend,
} from '../../../src/server/storage-ownership/claims.js';
import {
  claimPathFor, DIRECTORY_CLAIM_FILENAME, readOwnerClaim, resolveStorageOwnershipTargets,
} from '../../../src/server/storage-ownership/index.js';
import type { Config } from '../../../src/types/index.js';
import { readWorktreeWitness } from '../../../src/server/storage-ownership/witness.js';

// Single-process admission contract tests. Cross-process contention/crash cases live in
// tests/integration/storage-ownership-process.test.ts and use real child processes.

const dirs: string[] = [];
const handles: WriterAdmission[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.release().catch(() => undefined);
  for (const d of dirs.splice(0)) {
    await chmod(d, 0o700).catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
});

async function sandbox(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'nexus-admission-')));
  dirs.push(d);
  return d;
}

interface Paths { root: string; metadata: string; vector: string }
const pathsFor = (root: string, vector = join(root, 'vectors')): Paths => ({ root, metadata: join(root, 'metadata.db'), vector });
const cfg = (projectRoot: string, p: Paths): Config =>
  ({ projectRoot, storage: { rootDir: p.root, metadataDbPath: p.metadata, vectorDbPath: p.vector } }) as unknown as Config;

async function project(base: string, name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  return root;
}

function service(base: string, extra: AdmissionInternalOptions = {}) {
  return createStorageOwnershipAdmissionService({ coordinationRoot: join(base, 'coord'), lockWaitMs: 200, ...extra });
}

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

/** Recursive byte digest: every entry below the given paths (absent paths recorded as such). */
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

async function expectClaim(resource: string, kind: 'file' | 'directory', owner: string): Promise<void> {
  const result = await readOwnerClaim(claimPathFor(resource, kind));
  // Storage outside the project root is bound to the owner's worktree incarnation witness (claim format v2, W06).
  const witness = await readWorktreeWitness(owner);
  expect(witness.state).toBe('present');
  expect(result).toEqual({
    state: 'present',
    claim: { version: 2, ownerProjectRoot: owner, resourcePath: resource, kind, worktreeWitness: (witness as { witness: string }).witness },
  });
}

describe('stable physical resource keys and coordination', () => {
  it('S07_lock_identity_survives_target_creation', async () => {
    const base = await sandbox();
    const target = join(base, 'later', 'vectors');
    const before = (await resolveStorageOwnershipTargets(cfg(base, pathsFor(join(base, 'later'), target)))).vectorDbPath;
    await mkdir(target, { recursive: true });
    const after = (await resolveStorageOwnershipTargets(cfg(base, pathsFor(join(base, 'later'), target)))).vectorDbPath;
    expect(before.kind === 'persistent' && after.kind === 'persistent').toBe(true);
    if (before.kind !== 'persistent' || after.kind !== 'persistent') return;
    expect(resourceKey(before.path)).toBe(resourceKey(after.path));
    expect(resourceKey(after.path)).toBe(createHash('sha256').update(`nexus-storage-path-v1\0${target}`).digest('hex'));
  });

  it('S07_symlink_alias_and_different_tmpdir_contend', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const real = pathsFor(join(base, 'storage'));
    await mkdir(real.root);
    await symlink(real.root, join(base, 'alias'), 'dir');
    const svc = service(base);
    await admit(svc, cfg(owner, real));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(base, 'other-tmp');
    try {
      const aliased = pathsFor(join(base, 'alias'));
      const error = await refusal(admit(svc, cfg(owner, aliased)));
      expect(error.code).toBe('writer_busy');
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });

  it('S07_unavailable_kernel_lock_refuses_before_claim', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const failing: KernelLockBackend = { name: 'failing', tryAcquire: () => { throw new Error('no kernel lock'); } };
    const error = await refusal(admit(service(base, { lockBackend: failing }), cfg(owner, p)));
    expect(error.code).toBe('lock_unavailable');
    expect(await digest(p.root)).toEqual({ [p.root]: 'absent' }); // no mkdir, no claim
  });

  it('S10_unsupported_lock_backend_is_stop_not_pass', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const error = await refusal(admit(service(base, { platform: 'darwin' }), cfg(owner, p)));
    expect(error.code).toBe('unsupported_kernel_lease');
    const unverified: KernelLockBackend = { name: 'unverified', tryAcquire: () => ({ isHeld: () => false, release: () => undefined }) };
    expect((await refusal(admit(service(base, { lockBackend: unverified }), cfg(owner, p)))).code).toBe('unsupported_kernel_lease');
    expect(await digest(p.root)).toEqual({ [p.root]: 'absent' });
  });

  it('rejects a coordination root that overlaps a storage target or is not account-private', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const inside = createStorageOwnershipAdmissionService({ coordinationRoot: join(p.root, 'coord') });
    expect((await refusal(admit(inside, cfg(owner, p)))).code).toBe('lock_unavailable');
    await mkdir(join(base, 'open-coord'), { mode: 0o777 });
    await chmod(join(base, 'open-coord'), 0o777);
    const open = createStorageOwnershipAdmissionService({ coordinationRoot: join(base, 'open-coord') });
    expect((await refusal(admit(open, cfg(owner, p)))).code).toBe('lock_unavailable');
    expect(await digest(p.root)).toEqual({ [p.root]: 'absent' });
  });

  it('rejects a coordination root with an untrusted parent before creating the root', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    await chmod(base, 0o777);

    expect((await refusal(admit(service(base), cfg(owner, p)))).code).toBe('lock_unavailable');
    await expect(lstat(join(base, 'coord'))).rejects.toThrow();
  });

  it('rejects a coordination root when an ancestor is writable by another account', async () => {
    const base = await sandbox();
    const ancestor = join(base, 'ancestor');
    const parent = join(ancestor, 'parent');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(ancestor, 0o777);
    const root = join(parent, 'coord');

    await expect(prepareCoordinationRoot(root, [])).rejects.toThrow();
    await expect(lstat(root)).rejects.toThrow();
  });

  it('allows a non-writable shared parent while keeping the coordination root private', async () => {
    const base = await sandbox();
    const parent = join(base, '.local', 'state');
    const root = join(parent, 'nexus-ownership-v1');
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await chmod(parent, 0o755);

    await expect(prepareCoordinationRoot(root, [])).resolves.toBe(root);

    expect((await lstat(parent)).mode & 0o777).toBe(0o755);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });

  it('keeps lock paths anchored to the verified root inode after its path is replaced', async () => {
    const base = await sandbox();
    const root = join(base, 'coord');
    const moved = join(base, 'coord-original');
    await prepareCoordinationRoot(root, []);
    const pinned = coordinationRootPath(root);

    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(pinned, 'identity-probe'), 'original');

    expect(await readFile(join(moved, 'identity-probe'), 'utf8')).toBe('original');
    expect(await lstat(join(root, 'identity-probe')).then(() => true, () => false)).toBe(false);
    expect(() => coordinationRootPath(root)).toThrow('coordination root changed identity');
  });

});

describe('admitStorageWriter collisions', () => {
  it('S02_metadata_collision_refuses_without_writes', async () => {
    const base = await sandbox();
    const [a, b] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const shared = join(base, 'shared-meta', 'metadata.db');
    const svc = service(base);
    const first = await admit(svc, cfg(a, { ...pathsFor(join(base, 'sa')), metadata: shared }));
    await first.release();
    await writeFile(shared, 'owner-a-bytes');
    const before = await digest(join(base, 'shared-meta'), join(base, 'sb'));
    const error = await refusal(admit(svc, cfg(b, { ...pathsFor(join(base, 'sb')), metadata: shared })));
    expect(error.code).toBe('owner_conflict');
    expect(await digest(join(base, 'shared-meta'), join(base, 'sb'))).toEqual(before);
  });

  it('S03_vector_collision_refuses_without_writes', async () => {
    const base = await sandbox();
    const [a, b] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const shared = join(base, 'shared-vectors');
    const svc = service(base);
    await (await admit(svc, cfg(a, pathsFor(join(base, 'sa'), shared)))).release();
    await writeFile(join(shared, 'data.lance'), 'owner-a-bytes');
    const before = await digest(shared, join(base, 'sb'));
    expect((await refusal(admit(svc, cfg(b, pathsFor(join(base, 'sb'), shared))))).code).toBe('owner_conflict');
    expect(await digest(shared, join(base, 'sb'))).toEqual(before);
  });

  it.each(['root', 'metadata', 'vector'] as const)('S04_symlink_alias_contends_for_same_lock_%s', async (role) => {
    const base = await sandbox();
    const [a, b] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const pa = pathsFor(join(base, 'sa'));
    const svc = service(base);
    await admit(svc, cfg(a, pa));
    const alias = join(base, 'alias');
    const pb = pathsFor(join(base, 'sb'));
    if (role === 'vector') await symlink(pa.vector, alias, 'dir'); else await symlink(pa.root, alias, 'dir');
    const colliding = role === 'root' ? { ...pb, root: alias }
      : role === 'metadata' ? { ...pb, metadata: join(alias, 'metadata.db') } : { ...pb, vector: alias };
    const before = await digest(pa.root, pb.root);
    const error = await refusal(admit(svc, cfg(b, colliding)));
    expect(['writer_busy', 'owner_conflict']).toContain(error.code);
    expect(await digest(pa.root, pb.root)).toEqual(before);
  });

  it('S09_same_owner_second_independent_writer_is_rejected (same process)', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const svc = service(base);
    await admit(svc, cfg(owner, p));
    expect((await refusal(admit(svc, cfg(owner, p)))).code).toBe('writer_busy');
    const otherRoot = { ...pathsFor(join(base, 'other')), metadata: p.metadata }; // same owner, different rootDir
    expect((await refusal(admit(svc, cfg(owner, otherRoot)))).code).toBe('writer_busy');
  });
});

describe('F-004 bootstrap and partial claims', () => {
  it('S07_bootstrap_new_storage_root_claim', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'a', 'b', 'storage'));
    await admit(service(base), cfg(owner, p));
    await expectClaim(p.root, 'directory', owner);
    await expectClaim(p.metadata, 'file', owner);
    await expectClaim(p.vector, 'directory', owner);
    expect((await readdir(p.root)).sort()).toEqual([DIRECTORY_CLAIM_FILENAME, 'metadata.db.nexus-owner-claim', 'vectors']);
    expect(await readdir(p.vector)).toEqual([DIRECTORY_CLAIM_FILENAME]);
  });

  it('S07_bootstrap_new_metadata_parent_claim_without_opening_db', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = { ...pathsFor(join(base, 'storage')), metadata: join(base, 'meta', 'deep', 'metadata.db') };
    await admit(service(base), cfg(owner, p));
    await expectClaim(p.metadata, 'file', owner);
    expect(await readdir(join(base, 'meta', 'deep'))).toEqual(['metadata.db.nexus-owner-claim']);
    for (const s of ['', '-wal', '-shm', '-journal']) await expect(lstat(p.metadata + s)).rejects.toThrow();
  });

  it('S07_bootstrap_new_persistent_vector_directory_claim', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'), join(base, 'vec', 'lance'));
    await admit(service(base), cfg(owner, p));
    await expectClaim(p.vector, 'directory', owner);
    expect(await readdir(p.vector)).toEqual([DIRECTORY_CLAIM_FILENAME]);
  });

  it('memory:// vector needs no vector bootstrap or claim; root and metadata remain protected', async () => {
    const base = await sandbox();
    const [a, b] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const p = pathsFor(join(base, 'storage'), 'memory://');
    const svc = service(base);
    await (await admit(svc, cfg(a, p))).release();
    expect((await readdir(p.root)).sort()).toEqual([DIRECTORY_CLAIM_FILENAME, 'metadata.db.nexus-owner-claim']);
    const shared = { ...pathsFor(join(base, 'other'), 'memory://'), metadata: p.metadata };
    expect((await refusal(admit(svc, cfg(b, shared)))).code).toBe('owner_conflict');
  });

  it('S07_claim_midwrite_failure_same_owner_retry', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    let published = 0;
    const failing = service(base, { beforeClaimPublish: () => { if (++published === 2) throw new Error('disk full'); } });
    expect((await refusal(admit(failing, cfg(owner, p)))).code).toBe('claim_io_failed');
    const leftovers = (await readdir(p.root)).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
    // The partial same-owner claim and empty bootstrap directories remain; a fresh attempt revalidates and completes.
    const handle = await admit(service(base), cfg(owner, p));
    expect(handle.targets.rootDir.path).toBe(p.root);
    await expectClaim(p.root, 'directory', owner);
    await expectClaim(p.metadata, 'file', owner);
    await expectClaim(p.vector, 'directory', owner);
  });

  it('S07_claim_midwrite_failure_does_not_modify_existing_data', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    // Root + metadata already claimed (via an earlier memory:// admission) and holding live-looking data; the
    // persistent vector directory is absent, so a fresh admission must bootstrap it and publish exactly one claim.
    await (await admit(service(base), cfg(owner, { ...p, vector: 'memory://' }))).release();
    await writeFile(p.metadata, 'existing-sqlite-bytes');
    await writeFile(`${p.metadata}-wal`, 'existing-wal-bytes');
    await writeFile(join(p.root, 'nexus.pid'), '4242\n');
    await writeFile(join(p.root, 'endpoint.json'), '{"pid":4242}\n');
    const existing = [p.metadata, `${p.metadata}-wal`, join(p.root, 'nexus.pid'), join(p.root, 'endpoint.json'),
      claimPathFor(p.root, 'directory'), claimPathFor(p.metadata, 'file')];
    const before = await digest(...existing);
    const attempted: string[] = [];
    const failing = service(base, { beforeClaimPublish: (path) => { attempted.push(path); throw new Error('io'); } });
    let handle: WriterAdmission | undefined;
    const error = await refusal(failing.admitStorageWriter(await failing.resolveStorageOwnershipTargets(cfg(owner, p)))
      .then((h) => { handle = h; return h; }));
    expect(error.code).toBe('claim_io_failed');
    expect(handle).toBeUndefined();
    expect(attempted).toEqual([p.vector]); // failure happened at publication, after bootstrap
    expect(await digest(...existing)).toEqual(before);
    expect(await readdir(p.vector)).toEqual([]); // only the permitted empty bootstrap directory remains
    expect((await readdir(p.root)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('another owner can claim empty bootstrap directories left without claims', async () => {
    const base = await sandbox();
    const [firstOwner, nextOwner] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const p = pathsFor(join(base, 'storage'));
    const failed = service(base, { beforeClaimPublish: () => { throw new Error('publication interrupted'); } });

    expect((await refusal(admit(failed, cfg(firstOwner, p)))).code).toBe('claim_io_failed');
    expect(await readOwnerClaim(claimPathFor(p.root, 'directory'))).toEqual({ state: 'absent' });
    expect(await readdir(p.root)).toEqual(['vectors']);
    expect(await readdir(p.vector)).toEqual([]);

    const next = await admit(service(base), cfg(nextOwner, p));

    expect(next.targets.rootDir.path).toBe(p.root);
    await expectClaim(p.root, 'directory', nextOwner);
  });

  it('S07_foreign_owner_refused_before_any_directory_creation', async () => {
    const base = await sandbox();
    const [a, b] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    const shared = join(base, 'shared-vectors');
    const svc = service(base);
    await (await admit(svc, cfg(a, pathsFor(join(base, 'sa'), shared)))).release();
    const pb = pathsFor(join(base, 'fresh', 'sb'), shared);
    expect((await refusal(admit(svc, cfg(b, pb)))).code).toBe('owner_conflict');
    await expect(lstat(join(base, 'fresh'))).rejects.toThrow(); // no mkdir for the refused attempt
  });

  it('S07_partial_claim_retry_contract', async () => {
    const base = await sandbox();
    const [a, b] = [await project(base, 'ownerA'), await project(base, 'ownerB')];
    // Claims are published in resourceKey (hash) order. Pick a storage name whose vector key sorts last so the
    // single claim published before the injected crash is always root or metadata, never the vector directory
    // (a claimed directory is not content-scanned, which would make the "unexpected content" step order-dependent).
    const vectorSortsLast = (q: Paths) => resourceKey(q.vector) > resourceKey(q.root) && resourceKey(q.vector) > resourceKey(q.metadata);
    let p = pathsFor(join(base, 'storage'));
    for (let i = 0; i < 1000 && !vectorSortsLast(p); i++) p = pathsFor(join(base, `storage-${i}`));
    expect(vectorSortsLast(p)).toBe(true); // ~1/3 of names qualify; 1000 attempts make exhaustion negligible
    let n = 0;
    const crashAfterOne = service(base, { beforeClaimPublish: () => { if (++n > 1) throw new Error('crash'); } });
    await refusal(admit(crashAfterOne, cfg(a, p)));
    expect((await readOwnerClaim(claimPathFor(p.vector, 'directory'))).state).not.toBe('present');
    const svc = service(base);
    // A different owner never inherits the partial claim set, even with empty bootstrap dirs present.
    expect((await refusal(admit(svc, cfg(b, p)))).code).toBe('owner_conflict');
    // A different owner whose targets are disjoint from the partial claims may proceed.
    await (await admit(svc, cfg(b, pathsFor(join(base, 'disjoint'))))).release();
    // The same owner resumes only after full revalidation; unexpected content keeps it fail-closed.
    await writeFile(join(p.vector, 'unexpected'), 'x');
    expect((await refusal(admit(svc, cfg(a, p)))).code).toBe('owner_unknown');
    await rm(join(p.vector, 'unexpected'));
    await admit(svc, cfg(a, p));
    await expectClaim(p.vector, 'directory', a);
  });

  it('S07_same_owner_retry_succeeds_with_leftover_claim_temp_files', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    await mkdir(p.vector, { recursive: true });
    // As left by an attempt killed between fsync and link(): temp names of the root, metadata and vector claims.
    const temps = [
      `${claimPathFor(p.root, 'directory')}.tmp-99999-0123456789ab`,
      `${claimPathFor(p.metadata, 'file')}.tmp-99999-abcdef012345`,
      `${claimPathFor(p.vector, 'directory')}.tmp-99999-00ff00ff00ff`,
    ];
    for (const temp of temps) await writeFile(temp, '{"partial":');
    await admit(service(base), cfg(owner, p));
    await expectClaim(p.root, 'directory', owner);
    await expectClaim(p.metadata, 'file', owner);
    await expectClaim(p.vector, 'directory', owner);
    for (const temp of temps) expect((await lstat(temp)).isFile()).toBe(true); // retained, never PID-deleted
  });

  it('admission refuses look-alike claim temp entries', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    await mkdir(p.root, { recursive: true });
    await writeFile(join(p.root, 'metadata.db.tmp-99999-0123456789ab'), 'x'); // not a claim temp name
    expect((await refusal(admit(service(base), cfg(owner, p)))).code).toBe('owner_unknown');
    await rm(join(p.root, 'metadata.db.tmp-99999-0123456789ab'));
    await mkdir(`${claimPathFor(p.root, 'directory')}.tmp-99999-0123456789ab`); // right name, but a directory
    // The read-only preflight (first admission step) already refuses it, before any lock or validation.
    expect((await refusal(admit(service(base), cfg(owner, p)))).code).toBe('owner_unknown');
  });

  it('S07_claim_lock_failure_creates_zero_new_claims', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    let calls = 0;
    const flaky: KernelLockBackend = {
      name: 'flaky',
      tryAcquire: (path) => (++calls >= 3 ? null : sqliteFcntlLockBackend.tryAcquire(path)),
    };
    const error = await refusal(admit(service(base, { lockBackend: flaky }), cfg(owner, p)));
    expect(['lock_unavailable', 'writer_busy']).toContain(error.code);
    expect(await digest(p.root)).toEqual({ [p.root]: 'absent' });
    await admit(service(base), cfg(owner, p)); // all attempt-owned locks were released
  });

  it('S08_malformed_or_unwritable_claim_refuses', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    await mkdir(p.root);
    await writeFile(join(p.root, DIRECTORY_CLAIM_FILENAME), '{not json');
    const before = await digest(p.root);
    expect((await refusal(admit(service(base), cfg(owner, p)))).code).toBe('owner_unknown');
    expect(await digest(p.root)).toEqual(before);

    const q = pathsFor(join(base, 'readonly'));
    await mkdir(q.root);
    await chmod(q.root, 0o500);
    expect((await refusal(admit(service(base), cfg(owner, q)))).code).toBe('claim_io_failed');
    await chmod(q.root, 0o700);
    expect(await readdir(q.root)).toEqual([]);
  });

  it('refuses unclaimed legacy data without adoption', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'legacy'));
    await mkdir(join(p.root, 'sub'), { recursive: true });
    await writeFile(p.metadata, 'legacy');
    const before = await digest(p.root);
    expect((await refusal(admit(service(base), cfg(owner, p)))).code).toBe('owner_unknown');
    expect(await digest(p.root)).toEqual(before);
  });
});

describe('WriterAdmission registry (F-003 primitives)', () => {
  it('refuses a released admission if release occurs during target resolution', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const svc = service(base);
    const handle = await admit(svc, cfg(owner, p));

    const pending = svc.assertLiveWriterAdmission(handle, cfg(owner, p));
    await handle.release();

    expect((await refusal(pending)).code).toBe('invalid_writer_admission');
  });

  it('refuses an admission if its writer lease is lost during target resolution', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    let writerLeaseHeld = true;
    const backend: KernelLockBackend = {
      name: 'controllable',
      tryAcquire: (path) => {
        let released = false;
        const writerLease = path.includes('/writer/');
        return {
          isHeld: () => !released && (!writerLease || writerLeaseHeld),
          release: () => { released = true; },
        };
      },
    };
    const svc = service(base, { lockBackend: backend });
    const handle = await admit(svc, cfg(owner, p));

    const pending = svc.assertLiveWriterAdmission(handle, cfg(owner, p));
    writerLeaseHeld = false;

    expect((await refusal(pending)).code).toBe('invalid_writer_admission');
  });

  it('refuses an admission when its worktree witness disappears', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = { ...pathsFor(join(base, 'storage')), vector: join(base, 'external-vectors') };
    const svc = service(base);
    const handle = await admit(svc, cfg(owner, p));

    await rm(join(owner, '.nexus', 'worktree-witness'));

    expect((await refusal(svc.assertLiveWriterAdmission(handle, cfg(owner, p)))).code).toBe('incarnation_mismatch');
  });

  it('rejects forged, cloned or mismatched handles and consumes exactly once', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const svc = service(base);
    const handle = await admit(svc, cfg(owner, p));
    await svc.assertLiveWriterAdmission(handle, cfg(owner, p));
    const forged = { targets: handle.targets, release: () => Promise.resolve() };
    expect((await refusal(svc.assertLiveWriterAdmission(forged, cfg(owner, p)))).code).toBe('invalid_writer_admission');
    expect((await refusal(svc.assertLiveWriterAdmission({ ...handle }, cfg(owner, p)))).code).toBe('invalid_writer_admission');
    expect((await refusal(service(base).assertLiveWriterAdmission(handle, cfg(owner, p)))).code).toBe('invalid_writer_admission');
    const memoryConfig = cfg(owner, { ...p, vector: 'memory://' });
    expect((await refusal(svc.assertLiveWriterAdmission(handle, memoryConfig))).code).toBe('target_mismatch');

    const lease = await svc.consumeWriterAdmission(handle, cfg(owner, p));
    expect((await refusal(svc.consumeWriterAdmission(handle, cfg(owner, p)))).code).toBe('invalid_writer_admission');
    await handle.release(); // retained pre-transfer reference must not drop the live runtime lease
    expect((await refusal(admit(svc, cfg(owner, p)))).code).toBe('writer_busy');
    await lease.release();
    await lease.release(); // idempotent
    expect((await refusal(svc.assertLiveWriterAdmission(handle, cfg(owner, p)))).code).toBe('invalid_writer_admission');
    await admit(svc, cfg(owner, p)); // lease actually released
  });

  it('release is idempotent before consumption and a released handle cannot be consumed', async () => {
    const base = await sandbox();
    const owner = await project(base, 'owner');
    const p = pathsFor(join(base, 'storage'));
    const svc = service(base);
    const handle = await admit(svc, cfg(owner, p));
    await handle.release();
    await handle.release();
    expect((await refusal(svc.consumeWriterAdmission(handle, cfg(owner, p)))).code).toBe('invalid_writer_admission');
    await admit(svc, cfg(owner, p));
  });
});
