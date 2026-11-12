// Physical resource identity, account-private coordination root, kernel-backed locks and atomic claim I/O
// (Nexus #297, Design §4.3 F-002/F-004). Internal only; not a public API.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statfsSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, parse, sep } from 'node:path';
import Database from 'better-sqlite3';
import { claimPathFor, CLAIM_FORMAT_VERSION, WITNESS_CLAIM_FORMAT_VERSION, type ClaimKind, type OwnerClaim } from './claim-format.js';
import { canonicalize } from './targets.js';

/** Design §4.3: SHA-256("nexus-storage-path-v1\0" + canonicalAbsoluteTargetPath). No role/TMPDIR/PID component. */
export function resourceKey(canonicalAbsolutePath: string): string {
  return createHash('sha256').update(`nexus-storage-path-v1\0${canonicalAbsolutePath}`).digest('hex');
}

export const COORDINATION_DIRNAME = 'nexus-ownership-v1';
export const ADMISSION_LOCK_FILENAME = 'admission.lock';
export const RESOURCE_LOCK_DIR = 'resource';
export const WRITER_LOCK_DIR = 'writer';

export const isWithin = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Default anchor derived from the OS account database home (not HOME/TMPDIR). */
export async function defaultCoordinationRoot(): Promise<string> {
  const home = await realpath(userInfo().homedir);
  return join(home, '.local', 'state', COORDINATION_DIRNAME);
}

// Filesystem magic numbers (statfs f_type) for network/userspace filesystems on which local kernel lock semantics
// cannot be established for the coordination root.
const REMOTE_FS_TYPES = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x65735546, // FUSE
  0x73757245, // CODA
  0x5346414f, // AFS
  0x6b414653, // kAFS
  0x0bd00bd0, // Lustre
  0x47504653, // GPFS
  0x013111a8, // IBRIX
  0x19830326, // FhGFS / BeeGFS
  0x00c36400, // CEPH
]);

async function verifyPrivateDirectory(path: string, uid: number, canonicalPath = path): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`coordination path ${path} is not a real directory`);
  if (stat.uid !== uid) throw new Error(`coordination path ${path} is not owned by the current account`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`coordination path ${path} is accessible by other accounts`);
  if (await realpath(path) !== canonicalPath) throw new Error(`coordination path ${path} is reached through an alias`);
}

async function verifyCoordinationParent(path: string, uid: number): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`coordination path ${path} is not a real directory`);
  if (stat.uid !== uid) throw new Error(`coordination path ${path} is not owned by the current account`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`coordination path ${path} is writable by other accounts`);
  if (await realpath(path) !== path) throw new Error(`coordination path ${path} is reached through an alias`);
}

function verifyTrustedAncestors(path: string, uid: number): void {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    const writableByOthers = (stat.mode & 0o022) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0) ||
      (writableByOthers && (stat.mode & 0o1000) === 0)) {
      throw new Error(`coordination ancestor ${current} is not trusted`);
    }
    if (current === parse(current).root) return;
  }
}

interface VerifiedCoordinationRoot {
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

const verifiedCoordinationRoots = new Map<string, VerifiedCoordinationRoot>();

/** Path anchored to the verified coordination-root inode; callers use it for every lock and gate path. */
export function coordinationRootPath(root: string): string {
  const verified = verifiedCoordinationRoots.get(root);
  if (verified === undefined) throw new Error('coordination root has not been verified');
  let pathStat;
  try { pathStat = lstatSync(root, { bigint: true }); }
  catch { throw new Error('coordination root changed identity'); }
  const opened = fstatSync(verified.fd, { bigint: true });
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || pathStat.dev !== verified.dev || pathStat.ino !== verified.ino ||
    opened.dev !== verified.dev || opened.ino !== verified.ino) {
    throw new Error('coordination root changed identity');
  }
  return `/proc/self/fd/${verified.fd}`;
}

export async function ensurePrivateDirectory(path: string, uid: number, canonicalPath = path): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await verifyPrivateDirectory(path, uid, canonicalPath);
}

function verifyCoordinationPin(
  root: string,
  parent: string,
  uid: number,
  kind: 'parent' | 'root',
  expected: { readonly dev: bigint; readonly ino: bigint },
): void {
  const pin = join(dirname(parent), `.nexus-ownership-${kind}-${createHash('sha256').update(root).digest('hex')}`);
  const identity = `${expected.dev}:${expected.ino}\n`;
  let fd: number | undefined;
  try {
    try { fd = openSync(pin, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temp = `${pin}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      const tempFd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { writeSync(tempFd, identity); fsyncSync(tempFd); }
      finally { closeSync(tempFd); }
      try { linkSync(temp, pin); }
      catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
      } finally { unlinkSync(temp); }
      fd = openSync(pin, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(uid) || (stat.mode & 0o077n) !== 0n || stat.nlink !== 1n ||
      readFileSync(fd, 'utf8') !== identity) {
      throw new Error(`coordination root ${kind} changed identity`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Create (if needed) and verify the private coordination root and its lock subdirectories. Rejects symlink/alias
 * substitution, foreign ownership, group/other access, remote filesystems, account mismatch and overlap with any
 * configured persistent storage target. Never touches storage targets.
 */
export async function prepareCoordinationRoot(root: string, persistentTargets: readonly string[]): Promise<string> {
  if (typeof process.getuid !== 'function') throw new Error('account identity is unavailable on this platform');
  const uid = process.getuid();
  if (userInfo().uid !== uid) throw new Error('process uid does not match the OS account database entry');
  // Overlap is decided on the canonical identity *before* anything is created, so a root placed inside an
  // unclaimed storage tree can never cause a storage-side mkdir.
  const canonicalRoot: string = await canonicalize(root, 'coordination root');
  for (const target of persistentTargets) {
    if (isWithin(canonicalRoot, target) || isWithin(target, canonicalRoot)) {
      throw new Error('coordination root overlaps a configured storage target');
    }
  }
  const parent = dirname(canonicalRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  verifyTrustedAncestors(parent, uid);
  await verifyCoordinationParent(parent, uid);
  const parentBefore = lstatSync(parent, { bigint: true });
  const parentFd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const parentOpened = fstatSync(parentFd, { bigint: true });
    if (parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) {
      throw new Error('coordination root parent changed identity while opening');
    }
    verifyCoordinationPin(canonicalRoot, parent, uid, 'parent', parentOpened);
    const verifiedRoot = verifiedCoordinationRoots.get(canonicalRoot);
    if (verifiedRoot !== undefined) {
      coordinationRootPath(canonicalRoot);
      verifyCoordinationPin(canonicalRoot, parent, uid, 'root', verifiedRoot);
    } else {
      await ensurePrivateDirectory(canonicalRoot, uid);
      const before = lstatSync(canonicalRoot, { bigint: true });
      const fd = openSync(canonicalRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true });
        const parentAfter = lstatSync(parent, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isDirectory() ||
          parentAfter.dev !== parentOpened.dev || parentAfter.ino !== parentOpened.ino) {
          throw new Error('coordination root or parent changed identity while opening');
        }
        verifyCoordinationPin(canonicalRoot, parent, uid, 'parent', parentOpened);
        verifyCoordinationPin(canonicalRoot, parent, uid, 'root', opened);
        verifiedCoordinationRoots.set(canonicalRoot, { fd, dev: opened.dev, ino: opened.ino });
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    }
  } finally { closeSync(parentFd); }
  const pinnedRoot = coordinationRootPath(canonicalRoot);
  const fsType = statfsSync(pinnedRoot).type;
  if (REMOTE_FS_TYPES.has(fsType)) throw new Error('coordination root is on a remote or userspace filesystem');
  await ensurePrivateDirectory(join(pinnedRoot, RESOURCE_LOCK_DIR), uid, join(canonicalRoot, RESOURCE_LOCK_DIR));
  await ensurePrivateDirectory(join(pinnedRoot, WRITER_LOCK_DIR), uid, join(canonicalRoot, WRITER_LOCK_DIR));
  return canonicalRoot;
}

// ---------------------------------------------------------------------------------------------------------------
// Kernel lock adapter
// ---------------------------------------------------------------------------------------------------------------

/** An acquired lock. `isHeld()` must reflect the OS-level lock, not only local bookkeeping. */
export interface KernelLock {
  readonly isHeld: () => boolean;
  readonly release: () => void;
}

/** `tryAcquire` is nonblocking: returns `null` when another holder owns the lock; throws when locking is unusable. */
export interface KernelLockBackend {
  readonly name: string;
  readonly tryAcquire: (path: string) => KernelLock | null;
}

const isBusy = (error: unknown): boolean => {
  const code = (error as { code?: string }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
};

/** Decode a Linux st_dev into the `MAJOR:MINOR` hex form used by /proc/locks. */
function procDeviceId(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}`;
}

const PROC_LOCKS_READ_ATTEMPTS = 3;

/**
 * Linux kernel evidence: /proc/locks lists a POSIX advisory WRITE lock owned by this PID on the lock file's inode.
 * Returns false when the evidence is absent or unavailable (fail closed).
 *
 * /proc/locks is a seq_file: a multi-chunk read can skip entries while other processes concurrently add/remove locks
 * (busy hosts, many SQLite connections). A present lock is therefore re-read a bounded number of times before it is
 * reported absent; a genuinely lost lock stays absent on every read, so this never turns absence into presence.
 */
export function kernelHoldsWriteLock(path: string): boolean {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch { return false; }
  const device = procDeviceId(stat.dev);
  const inode = stat.ino.toString();
  const pid = String(process.pid);
  for (let attempt = 0; attempt < PROC_LOCKS_READ_ATTEMPTS; attempt += 1) {
    let table: string;
    try { table = readFileSync('/proc/locks', 'utf8'); } catch { return false; }
    if (table.split('\n').some((line) => procLockLineMatches(line, device, inode, pid))) return true;
  }
  return false;
}

function procLockLineMatches(line: string, device: string, inode: string, pid: string): boolean {
  const fields = line.trim().split(/\s+/);
  if (fields[1] === '->' || fields[1] !== 'POSIX' || fields[3] !== 'WRITE' || fields[4] !== pid) return false;
  const id = fields[5]?.split(':');
  return id?.length === 3 && `${id[0]}:${id[1]}` === device && id[2] === inode;
}

/**
 * Kernel advisory lock via SQLite's unix VFS (already a dependency through better-sqlite3): `BEGIN EXCLUSIVE` on an
 * empty lock database takes nonblocking fcntl(F_SETLK) write locks held for the connection's lifetime; the kernel
 * releases them when the process terminates. SQLite also excludes a second connection in the same process via its
 * per-inode lock table. Hazard: POSIX locks are dropped if *any* descriptor of the same inode is closed in this process,
 * so lock files must only ever be opened through this adapter (they live in the private coordination root).
 */
export const sqliteFcntlLockBackend: KernelLockBackend = {
  name: 'sqlite-fcntl',
  tryAcquire(path: string): KernelLock | null {
    let existing;
    try { existing = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error(`unsafe lock file ${path}`);
    const db = new Database(path, { timeout: 0 });
    try {
      db.pragma('journal_mode = MEMORY'); // no journal sidecar next to the lock file
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      db.close();
      if (isBusy(error)) return null;
      throw error;
    }
    const after = lstatSync(path);
    if (!after.isFile() || after.nlink !== 1 || after.uid !== process.getuid?.()) {
      db.close();
      throw new Error(`unsafe lock file ${path}`);
    }
    let released = false;
    return {
      isHeld: () => !released && db.open && db.inTransaction && kernelHoldsWriteLock(path),
      release: () => {
        if (released) return;
        released = true;
        db.close(); // closing the connection releases the fcntl locks
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Writer path records (overlap detection between independent admissions)
// ---------------------------------------------------------------------------------------------------------------

const WRITER_PATH_SUFFIX = '.path';
const MAX_PATH_RECORD_BYTES = 16 * 1024;

/**
 * Record the canonical target path for `writer/<key>.lock`. Written only while holding both the admission gate and
 * that key's writer lease. Content is deterministic per key, so an atomic rename over an older record is idempotent.
 * The record is metadata for overlap probing only; liveness is always decided by the kernel lock itself.
 */
export function writeWriterPathRecord(writerDir: string, key: string, canonicalPath: string): void {
  const finalPath = join(writerDir, `${key}${WRITER_PATH_SUFFIX}`);
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, canonicalPath); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tempPath, finalPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* attempt-owned temp already gone */ }
    throw error;
  }
}

export interface WriterEntry {
  readonly key: string;
  /** Verified canonical path (record present, regular file and hashing to `key`), otherwise undefined. */
  readonly path: string | undefined;
}

/** List every writer lock key in the coordination root with its verified path record, if any. */
export function listWriterEntries(writerDir: string): WriterEntry[] {
  const entries: WriterEntry[] = [];
  for (const name of readdirSync(writerDir)) {
    if (!name.endsWith('.lock')) continue;
    const key = name.slice(0, -'.lock'.length);
    let path: string | undefined;
    try {
      const recordPath = join(writerDir, `${key}${WRITER_PATH_SUFFIX}`);
      const stat = lstatSync(recordPath);
      if (stat.isFile() && stat.size <= MAX_PATH_RECORD_BYTES) {
        const text = readFileSync(recordPath, 'utf8');
        if (resourceKey(text) === key) path = text;
      }
    } catch { /* missing/unreadable record: path unknown, caller must probe liveness */ }
    entries.push({ key, path });
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Bootstrap directories and atomic claims
// ---------------------------------------------------------------------------------------------------------------

/**
 * Create missing directory components of `target` one at a time (no recursive mkdir), verifying after each step that
 * the component is a real, non-symlink directory whose canonical path equals the expected canonical path. Existing
 * entries are never modified. Returns the components created by this call.
 */
async function findMissingDirectories(target: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = target; ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} is not a real directory`);
      if (await realpath(current) !== current) throw new Error(`${current} resolves through an alias`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (dirname(current) === current) throw new Error('no existing ancestor');
      missing.unshift(current);
    }
  }
  return missing;
}

async function createAndVerifyDirectories(missing: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (const dir of missing) {
    try { await mkdir(dir); created.push(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(dir) !== dir) {
      throw new Error(`${dir} changed identity during bootstrap`);
    }
  }
  return created;
}

export async function mkdirVerified(target: string): Promise<string[]> {
  return await createAndVerifyDirectories(await findMissingDirectories(target));
}

export type PublishResult = 'created' | 'exists';

/**
 * Durably publish a claim with no overwrite: write+fsync a unique attempt-owned temp file in the same directory, then
 * `link()` it to the final name (atomic, fails with EEXIST instead of replacing). The attempt-owned temp file is
 * always unlinked; nothing pre-existing is modified or deleted.
 */
export function publishClaim(
  resourcePath: string, kind: ClaimKind, ownerProjectRoot: string, worktreeWitness?: string,
): PublishResult {
  const claim: OwnerClaim = worktreeWitness === undefined
    ? { version: CLAIM_FORMAT_VERSION, ownerProjectRoot, resourcePath, kind }
    : { version: WITNESS_CLAIM_FORMAT_VERSION, ownerProjectRoot, resourcePath, kind, worktreeWitness };
  const finalPath = claimPathFor(resourcePath, kind);
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
  try {
    try {
      writeSync(fd, `${JSON.stringify(claim)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(tempPath, finalPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw error;
    }
    syncDirectory(dirname(finalPath));
    return 'created';
  } finally {
    try { unlinkSync(tempPath); } catch { /* attempt-owned temp already gone */ }
  }
}

function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try { fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY); fsyncSync(fd); }
  catch { /* directory fsync is best-effort durability; the claim content itself was fsynced */ }
  finally { if (fd !== undefined) closeSync(fd); }
}
