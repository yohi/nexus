// Bounded multi-resource writer admission with safe partial claims (Nexus #297, Design §4.3/§4.4, F-002/F-003/F-004).
// Internal only; not a public package or MCP API.
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../../types/index.js';
import { claimPathFor, DIRECTORY_CLAIM_FILENAME, readOwnerClaim, type ClaimKind } from './claim-format.js';
import {
  ADMISSION_LOCK_FILENAME, defaultCoordinationRoot, isWithin, listWriterEntries, mkdirVerified, prepareCoordinationRoot, publishClaim,
  RESOURCE_LOCK_DIR, resourceKey, sqliteFcntlLockBackend, WRITER_LOCK_DIR, writeWriterPathRecord, type KernelLock, type KernelLockBackend,
} from './claims.js';
import { inspectStorageOwnership } from './preflight.js';
import { assertNotHardlinked, canonicalize, resolveStorageOwnershipTargets, storageTargetsFingerprint } from './targets.js';
import type { CanonicalPath, OwnershipPreflight, ResolvedStorageOwnershipTargets } from './types.js';

export type StorageOwnershipErrorCode =
  | 'owner_conflict' | 'owner_unknown' | 'ambiguous_target' | 'writer_busy' | 'lock_unavailable'
  | 'claim_io_failed' | 'unsupported_kernel_lease' | 'invalid_writer_admission' | 'target_mismatch';

/** Bounded internal failure. `code` is the stable classification; `message` is a diagnostic only. */
export class StorageOwnershipError extends Error {
  readonly code: StorageOwnershipErrorCode;
  constructor(code: StorageOwnershipErrorCode, message: string, options?: { cause?: unknown }) {
    super(`storage ownership ${code}: ${message}`, options);
    this.name = 'StorageOwnershipError';
    this.code = code;
  }
}

// Module-private nominal brand; the runtime registry below is the actual authorization check.
declare const writerAdmissionBrand: unique symbol;
export interface WriterAdmission {
  readonly [writerAdmissionBrand]: true;
  readonly targets: ResolvedStorageOwnershipTargets;
  /** Releases the live writer leases only while ISSUED (idempotent); a no-op after transfer to a runtime. */
  readonly release: () => Promise<void>;
}
/**
 * Runtime-only capability returned by `consumeWriterAdmission`; performs the one real lease release. `isHeld` reports
 * whether every kernel writer lease is still held (false after release or on a detected loss).
 */
export interface ConsumedWriterLease {
  readonly release: () => Promise<void>;
  readonly isHeld: () => boolean;
}

export interface StorageOwnershipAdmissionService {
  resolveStorageOwnershipTargets(config: Config): Promise<ResolvedStorageOwnershipTargets>;
  inspectStorageOwnership(targets: ResolvedStorageOwnershipTargets): Promise<OwnershipPreflight>;
  admitStorageWriter(targets: ResolvedStorageOwnershipTargets): Promise<WriterAdmission>;
  assertLiveWriterAdmission(handle: unknown, config: Config): Promise<void>;
  consumeWriterAdmission(handle: WriterAdmission, config: Config): Promise<ConsumedWriterLease>;
}

/** Internal, non-configurable knobs (tests and fault injection). Never derived from user config or environment. */
export interface AdmissionInternalOptions {
  readonly coordinationRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly lockBackend?: KernelLockBackend;
  /** Bounded wait for the *short* admission gate/resource locks. Writer leases never wait. */
  readonly lockWaitMs?: number;
  /** Fault injection hook invoked right before each claim publication. */
  readonly beforeClaimPublish?: (resourcePath: string) => void;
}

type AdmissionState = 'ISSUED' | 'CONSUMED_BY_RUNTIME' | 'RELEASED';
interface RegistryEntry {
  readonly issuer: object;
  readonly fingerprint: string;
  readonly leases: readonly KernelLock[];
  state: AdmissionState;
}
const registry = new WeakMap<object, RegistryEntry>();
/** Strong references so a dropped handle can never let GC close a live lease connection behind the runtime's back. */
const liveLeaseSets = new Set<readonly KernelLock[]>();

const releaseLeases = (leases: readonly KernelLock[]): void => {
  for (const lease of [...leases].reverse()) {
    try { lease.release(); } catch { /* releasing an attempt-owned descriptor is best effort; kernel frees on exit */ }
  }
  liveLeaseSets.delete(leases);
};

interface Resource {
  readonly role: 'rootDir' | 'metadataDbPath' | 'vectorDbPath';
  readonly path: CanonicalPath;
  readonly kind: ClaimKind;
  readonly key: string;
}

const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'];
const DEFAULT_LOCK_WAIT_MS = 5_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function persistentResources(targets: ResolvedStorageOwnershipTargets): Resource[] {
  const list: Resource[] = [
    { role: 'rootDir', path: targets.rootDir.path, kind: 'directory', key: resourceKey(targets.rootDir.path) },
    { role: 'metadataDbPath', path: targets.metadataDbPath.path, kind: 'file', key: resourceKey(targets.metadataDbPath.path) },
  ];
  if (targets.vectorDbPath.kind === 'persistent') {
    list.push({ role: 'vectorDbPath', path: targets.vectorDbPath.path, kind: 'directory', key: resourceKey(targets.vectorDbPath.path) });
  }
  const seen = new Set<string>();
  for (const r of list) {
    if (seen.has(r.path)) throw new StorageOwnershipError('ambiguous_target', `${r.role} shares a physical path with another role`);
    seen.add(r.path);
  }
  return list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function classifyPreflight(reason: string | undefined): StorageOwnershipError {
  const text = reason ?? 'unknown';
  if (/different (owner|project)/.test(text)) return new StorageOwnershipError('owner_conflict', text);
  if (/alias|hard-linked|not a directory|no existing ancestor/.test(text)) return new StorageOwnershipError('ambiguous_target', text);
  return new StorageOwnershipError('owner_unknown', text);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return false;
    throw new StorageOwnershipError('ambiguous_target', `cannot inspect ${path} (${errno(error) ?? 'unknown'})`);
  }
}

/** Re-resolve a target and require an unchanged canonical identity and resource key. */
async function assertStableIdentity(resource: Resource): Promise<void> {
  let again: CanonicalPath;
  try { again = await canonicalize(resource.path, resource.role); }
  catch (error) { throw new StorageOwnershipError('ambiguous_target', (error as Error).message); }
  if (again !== resource.path || resourceKey(again) !== resource.key) {
    throw new StorageOwnershipError('ambiguous_target', `${resource.role} changed identity during admission`);
  }
  if (resource.kind === 'file') {
    try { await assertNotHardlinked(again, resource.role); }
    catch (error) { throw new StorageOwnershipError('ambiguous_target', (error as Error).message); }
  }
}

async function checkAncestorClaims(resource: Resource, owner: string): Promise<void> {
  for (let dir = dirname(resource.path), prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
    const result = await readOwnerClaim(join(dir, DIRECTORY_CLAIM_FILENAME));
    if (result.state === 'invalid') throw new StorageOwnershipError('owner_unknown', `ancestor claim at ${dir}: ${result.reason}`);
    if (result.state !== 'present') continue;
    if (result.claim.resourcePath !== dir || result.claim.kind !== 'directory') {
      throw new StorageOwnershipError('owner_unknown', `ancestor claim at ${dir} does not match its directory`);
    }
    if (result.claim.ownerProjectRoot !== owner) throw new StorageOwnershipError('owner_conflict', `ancestor ${dir} is owned by another project`);
  }
}

/** Every entry of an unclaimed directory must be explained by the requested resource set (recursively). */
async function assertOnlyExplainedEntries(dir: string, self: Resource, all: readonly Resource[]): Promise<void> {
  const others = all.filter((r) => r !== self);
  for (const name of await readdir(dir)) {
    const entry = join(dir, name);
    if (others.some((o) => o.path === entry || claimPathFor(o.path, o.kind) === entry)) continue;
    if (others.some((o) => isWithin(o.path, entry))) {
      const stat = await lstat(entry);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StorageOwnershipError('ambiguous_target', `${entry} is not a real directory`);
      await assertOnlyExplainedEntries(entry, self, all);
      continue;
    }
    throw new StorageOwnershipError('owner_unknown', `unclaimed ${self.role} ${self.path} contains unexplained entry ${name}`);
  }
}

/**
 * Full validation of one resource against the single owner. Returns whether the resource is already claimed by that
 * owner. Throws for any foreign, malformed, unexplained or ambiguous state. Read-only.
 */
async function validateResource(resource: Resource, all: readonly Resource[], owner: string): Promise<boolean> {
  await assertStableIdentity(resource);
  await checkAncestorClaims(resource, owner);
  const claim = await readOwnerClaim(claimPathFor(resource.path, resource.kind));
  if (claim.state === 'invalid') throw new StorageOwnershipError('owner_unknown', `claim for ${resource.path}: ${claim.reason}`);
  if (claim.state === 'present') {
    const c = claim.claim;
    if (c.resourcePath !== resource.path || c.kind !== resource.kind) {
      throw new StorageOwnershipError('owner_unknown', `claim for ${resource.path} does not match the resource`);
    }
    if (c.ownerProjectRoot !== owner) throw new StorageOwnershipError('owner_conflict', `${resource.path} is owned by another project`);
    return true;
  }
  if (resource.kind === 'file') {
    if (await exists(resource.path)) throw new StorageOwnershipError('owner_unknown', `unclaimed existing file ${resource.path}`);
    for (const s of SQLITE_SIDECARS) {
      if (await exists(resource.path + s)) throw new StorageOwnershipError('owner_unknown', `unclaimed SQLite sidecar ${resource.path}${s}`);
    }
    const parent = dirname(resource.path);
    if (await exists(parent) && !(await lstat(parent)).isDirectory()) {
      throw new StorageOwnershipError('ambiguous_target', `parent of ${resource.path} is not a directory`);
    }
    return false;
  }
  if (!(await exists(resource.path))) return false;
  const stat = await lstat(resource.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StorageOwnershipError('ambiguous_target', `${resource.path} is not a directory`);
  await assertOnlyExplainedEntries(resource.path, resource, all);
  return false;
}

async function validateAll(resources: readonly Resource[], owner: string): Promise<Map<Resource, boolean>> {
  const claimed = new Map<Resource, boolean>();
  for (const r of resources) claimed.set(r, await validateResource(r, resources, owner));
  return claimed;
}

export function createStorageOwnershipAdmissionService(options: AdmissionInternalOptions = {}): StorageOwnershipAdmissionService {
  const backend = options.lockBackend ?? sqliteFcntlLockBackend;
  const platform = options.platform ?? process.platform;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const issuer = {};

  const tryLock = (path: string): KernelLock | null => {
    let lock: KernelLock | null;
    try { lock = backend.tryAcquire(path); }
    catch (error) { throw new StorageOwnershipError('lock_unavailable', `kernel lock failed for ${path}`, { cause: error }); }
    if (lock && !lock.isHeld()) {
      lock.release();
      throw new StorageOwnershipError('unsupported_kernel_lease', `backend ${backend.name} provided no verifiable kernel lock`);
    }
    return lock;
  };

  /** Short lock: bounded retry of the nonblocking primitive (never a stale takeover). */
  const acquireShort = async (path: string): Promise<KernelLock> => {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      const lock = tryLock(path);
      if (lock) return lock;
      if (Date.now() >= deadline) throw new StorageOwnershipError('lock_unavailable', `timed out waiting for ${path}`);
      await sleep(20);
    }
  };

  async function admitStorageWriter(targets: ResolvedStorageOwnershipTargets): Promise<WriterAdmission> {
    if (platform !== 'linux') {
      throw new StorageOwnershipError('unsupported_kernel_lease', `kernel lease verification is not supported on ${platform}`);
    }
    const owner = targets.ownerProjectRoot;
    try {
      if (await canonicalize(owner, 'projectRoot') !== owner) throw new Error('projectRoot changed identity');
    } catch (error) { throw new StorageOwnershipError('ambiguous_target', (error as Error).message); }
    const resources = persistentResources(targets);

    // 1. Read-only inspection: refuse early without any lock or mutation.
    const preflight = await inspectStorageOwnership(targets);
    if (preflight.disposition === 'refuse') throw classifyPreflight(preflight.reason);

    let coordinationRoot: string;
    try {
      coordinationRoot = await prepareCoordinationRoot(options.coordinationRoot ?? await defaultCoordinationRoot(),
        resources.map((r) => r.path));
    } catch (error) {
      throw new StorageOwnershipError('lock_unavailable', `coordination root unusable: ${(error as Error).message}`, { cause: error });
    }

    const shortLocks: KernelLock[] = [];
    const leases: KernelLock[] = [];
    let admitted = false;
    try {
      // 2. Global gate, then sorted per-resource admission locks, then sorted nonblocking lifetime writer leases.
      shortLocks.push(await acquireShort(join(coordinationRoot, ADMISSION_LOCK_FILENAME)));
      for (const r of resources) shortLocks.push(await acquireShort(join(coordinationRoot, RESOURCE_LOCK_DIR, `${r.key}.lock`)));
      for (const r of resources) {
        const lease = tryLock(join(coordinationRoot, WRITER_LOCK_DIR, `${r.key}.lock`));
        if (!lease) throw new StorageOwnershipError('writer_busy', `${r.role} already has a live writer`);
        leases.push(lease);
      }

      // 2b. Overlap exclusion across independent admissions (even for the same owner): any *live* writer whose
      // canonical path is an ancestor/descendant of a requested target refuses. Unknown records are probed too.
      // Liveness is decided only by the kernel lock (nonblocking probe), never by time or PID.
      const writerDir = join(coordinationRoot, WRITER_LOCK_DIR);
      const ownKeys = new Set(resources.map((r) => r.key));
      for (const other of listWriterEntries(writerDir)) {
        if (ownKeys.has(other.key)) continue;
        const otherPath = other.path;
        if (otherPath !== undefined &&
          !resources.some((r) => isWithin(r.path, otherPath) || isWithin(otherPath, r.path))) continue;
        const probe = tryLock(join(writerDir, `${other.key}.lock`));
        if (!probe) {
          throw new StorageOwnershipError('writer_busy',
            otherPath === undefined ? 'a live writer with an unverifiable target exists' : `live writer on overlapping target ${otherPath}`);
        }
        probe.release(); // not live: its record is stale metadata only
      }
      try {
        for (const r of resources) writeWriterPathRecord(writerDir, r.key, r.path);
      } catch (error) {
        throw new StorageOwnershipError('lock_unavailable', `cannot record writer target: ${(error as Error).message}`, { cause: error });
      }

      // 3. Validate the complete set before any Storage mkdir or claim publication.
      await validateAll(resources, owner);

      // 4. F-004 bootstrap: only missing empty claim-required directories / the metadata claim parent.
      try {
        for (const r of [...resources].sort((a, b) => a.path.localeCompare(b.path))) {
          await mkdirVerified(r.kind === 'directory' ? r.path : dirname(r.path));
        }
      } catch (error) {
        throw new StorageOwnershipError('claim_io_failed', `bootstrap failed: ${(error as Error).message}`, { cause: error });
      }

      // 5. Revalidate identities/keys and content after bootstrap, then publish missing claims (no overwrite).
      const claimed = await validateAll(resources, owner);
      for (const r of resources) {
        if (claimed.get(r)) continue;
        let result;
        try {
          options.beforeClaimPublish?.(r.path);
          result = publishClaim(r.path, r.kind, owner);
        } catch (error) {
          throw new StorageOwnershipError('claim_io_failed', `claim publication failed for ${r.path}: ${errno(error) ?? (error as Error).message}`, { cause: error });
        }
        if (result === 'exists') await validateResource(r, resources, owner); // must be our own valid claim
      }

      // 6. Verify the complete claim set and live leases before issuing the handle.
      const final = await validateAll(resources, owner);
      if (![...final.values()].every(Boolean)) throw new StorageOwnershipError('claim_io_failed', 'claim set incomplete after publication');
      for (const r of resources) await assertStableIdentity(r);
      if (!leases.every((l) => l.isHeld())) throw new StorageOwnershipError('unsupported_kernel_lease', 'writer lease lost during admission');
      admitted = true;
    } finally {
      releaseLeases(shortLocks);
      if (!admitted) releaseLeases(leases);
    }

    const frozenTargets = deepFreeze(structuredClone(targets));
    const entry: RegistryEntry = { issuer, fingerprint: storageTargetsFingerprint(targets), leases, state: 'ISSUED' };
    liveLeaseSets.add(leases);
    const handle = Object.freeze({
      targets: frozenTargets,
      release: (): Promise<void> => {
        if (entry.state === 'ISSUED') { // after transfer the runtime alone owns the release
          entry.state = 'RELEASED';
          releaseLeases(leases);
        }
        return Promise.resolve();
      },
    }) as unknown as WriterAdmission;
    registry.set(handle, entry);
    return handle;
  }

  async function assertLiveWriterAdmission(handle: unknown, config: Config): Promise<void> {
    const entry = typeof handle === 'object' && handle !== null ? registry.get(handle) : undefined;
    if (!entry || entry.issuer !== issuer) throw new StorageOwnershipError('invalid_writer_admission', 'handle was not issued by this service');
    if (entry.state !== 'ISSUED') throw new StorageOwnershipError('invalid_writer_admission', `handle is ${entry.state}`);
    if (!entry.leases.every((l) => l.isHeld())) throw new StorageOwnershipError('invalid_writer_admission', 'writer lease is no longer held');
    let fresh: ResolvedStorageOwnershipTargets;
    try { fresh = await resolveStorageOwnershipTargets(config); }
    catch (error) { throw new StorageOwnershipError('target_mismatch', (error as Error).message, { cause: error }); }
    if (storageTargetsFingerprint(fresh) !== entry.fingerprint) {
      throw new StorageOwnershipError('target_mismatch', 'configuration does not match the admitted storage targets');
    }
  }

  async function consumeWriterAdmission(handle: WriterAdmission, config: Config): Promise<ConsumedWriterLease> {
    await assertLiveWriterAdmission(handle, config);
    const entry = registry.get(handle);
    if (!entry || entry.state !== 'ISSUED') throw new StorageOwnershipError('invalid_writer_admission', 'handle already consumed');
    entry.state = 'CONSUMED_BY_RUNTIME';
    return Object.freeze({
      release: (): Promise<void> => {
        if (entry.state !== 'RELEASED') {
          entry.state = 'RELEASED';
          releaseLeases(entry.leases);
        }
        return Promise.resolve();
      },
      isHeld: (): boolean => entry.state === 'CONSUMED_BY_RUNTIME' && entry.leases.every((l) => l.isHeld()),
    });
  }

  return {
    resolveStorageOwnershipTargets,
    inspectStorageOwnership,
    admitStorageWriter,
    assertLiveWriterAdmission,
    consumeWriterAdmission,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * In-process, test-only override of the process-wide coordination root (set by the Vitest setup so tests never touch
 * the real account home). It is deliberately neither a Config field nor an environment variable.
 */
export const TEST_COORDINATION_ROOT_KEY: unique symbol = Symbol.for('nexus.storageOwnership.testCoordinationRoot') as never;
const processServiceOptions: AdmissionInternalOptions = {
  get coordinationRoot(): string | undefined {
    const value = (globalThis as Record<symbol, unknown>)[TEST_COORDINATION_ROOT_KEY];
    return typeof value === 'string' ? value : undefined;
  },
};

/** Coordination root used by every process-wide caller (writer admission and the Bridge startup gate). */
export async function processCoordinationRoot(): Promise<string> {
  return processServiceOptions.coordinationRoot ?? await defaultCoordinationRoot();
}

/** Process-wide service using the verified OS-account coordination root. */
export const storageOwnershipAdmissionService: StorageOwnershipAdmissionService =
  createStorageOwnershipAdmissionService(processServiceOptions);
export const admitStorageWriter = (targets: ResolvedStorageOwnershipTargets): Promise<WriterAdmission> =>
  storageOwnershipAdmissionService.admitStorageWriter(targets);
export const assertLiveWriterAdmission = (handle: unknown, config: Config): Promise<void> =>
  storageOwnershipAdmissionService.assertLiveWriterAdmission(handle, config);
export const consumeWriterAdmission = (handle: WriterAdmission, config: Config): Promise<ConsumedWriterLease> =>
  storageOwnershipAdmissionService.consumeWriterAdmission(handle, config);
