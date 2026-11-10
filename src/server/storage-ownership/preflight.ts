import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { claimPathFor, DIRECTORY_CLAIM_FILENAME, readOwnerClaim, type ClaimKind } from './claim-format.js';
import type { OwnershipPreflight, ResolvedStorageOwnershipTargets } from './types.js';

interface Resource { readonly path: string; readonly kind: ClaimKind }
type Verdict = 'claimed' | 'clean' | { readonly refuse: string };

const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'];
const isWithin = (child: string, parent: string): boolean => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function checkAncestors(resource: Resource, owner: string): Promise<string | undefined> {
  for (let dir = dirname(resource.path), prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
    const result = await readOwnerClaim(join(dir, DIRECTORY_CLAIM_FILENAME));
    if (result.state === 'invalid') return `ancestor claim at ${dir} is invalid: ${result.reason}`;
    if (result.state === 'present' && result.claim.ownerProjectRoot !== owner) {
      return `ancestor ${dir} is claimed by a different owner`;
    }
  }
  return undefined;
}

async function evaluate(resource: Resource, all: readonly Resource[], owner: string): Promise<Verdict> {
  const nested = await checkAncestors(resource, owner);
  if (nested) return { refuse: nested };
  const claim = await readOwnerClaim(claimPathFor(resource.path, resource.kind));
  if (claim.state === 'invalid') return { refuse: `claim for ${resource.path} is invalid: ${claim.reason}` };
  if (claim.state === 'present') {
    const c = claim.claim;
    if (c.resourcePath !== resource.path || c.kind !== resource.kind) return { refuse: `claim for ${resource.path} does not match the resource` };
    if (c.ownerProjectRoot !== owner) return { refuse: `${resource.path} is owned by a different project` };
    return 'claimed';
  }
  if (!(await exists(resource.path))) {
    if (resource.kind === 'file') {
      for (const s of SQLITE_SIDECARS) if (await exists(resource.path + s)) return { refuse: `unclaimed SQLite sidecar present for ${resource.path}` };
    }
    return 'clean';
  }
  if (resource.kind === 'file') return { refuse: `unclaimed existing file ${resource.path}` };
  const stat = await lstat(resource.path);
  if (!stat.isDirectory()) return { refuse: `${resource.path} is not a directory` };
  const others = all.filter((r) => r !== resource);
  const allowed = (entry: string): boolean => others.some((o) => {
    const claimPath = claimPathFor(o.path, o.kind);
    return entry === o.path || entry === claimPath || isWithin(o.path, entry);
  });
  for (const name of await readdir(resource.path)) {
    if (!allowed(join(resource.path, name))) return { refuse: `unclaimed non-empty directory ${resource.path}` };
  }
  return 'clean';
}

/** Read-only advisory inspection. Never creates, writes or deletes; never authorizes opening stores. */
export async function inspectStorageOwnership(targets: ResolvedStorageOwnershipTargets): Promise<OwnershipPreflight> {
  const resources: Resource[] = [
    { path: targets.rootDir.path, kind: 'directory' },
    { path: targets.metadataDbPath.path, kind: 'file' },
  ];
  if (targets.vectorDbPath.kind === 'persistent') resources.push({ path: targets.vectorDbPath.path, kind: 'directory' });
  try {
    const verdicts: Verdict[] = [];
    for (const r of resources) verdicts.push(await evaluate(r, resources, targets.ownerProjectRoot));
    const refused = verdicts.find((v): v is { refuse: string } => typeof v === 'object');
    if (refused) return { targets, disposition: 'refuse', reason: refused.refuse };
    return { targets, disposition: verdicts.every((v) => v === 'claimed') ? 'owned' : 'unclaimed-clean' };
  } catch (error) {
    return { targets, disposition: 'refuse', reason: `inspection failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}` };
  }
}
