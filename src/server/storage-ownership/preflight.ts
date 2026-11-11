import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { claimBindingProblem, claimPathFor, DIRECTORY_CLAIM_FILENAME, isClaimTempPathFor, readOwnerClaim, type ClaimKind, type OwnerClaim } from './claim-format.js';
import { readWorktreeWitness, witnessRequired } from './witness.js';
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

/** Current worktree evidence: `required` when any claim must be bound to this worktree incarnation. */
interface Binding { readonly required: boolean; readonly witness: string | undefined; readonly witnessReason: string }

/** Problem binding `claim` to the current incarnation (read-only); undefined when bound or when no witness is required. */
function bindingProblem(claim: OwnerClaim, binding: Binding): string | undefined {
  if (!binding.required) return undefined;
  if (binding.witness === undefined) return `claim cannot be bound to this worktree incarnation (${binding.witnessReason})`;
  return claimBindingProblem(claim, binding.witness);
}

async function checkAncestors(resource: Resource, owner: string, binding: Binding): Promise<string | undefined> {
  for (let dir = dirname(resource.path), prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
    const result = await readOwnerClaim(join(dir, DIRECTORY_CLAIM_FILENAME));
    if (result.state === 'invalid') return `ancestor claim at ${dir} is invalid: ${result.reason}`;
    if (result.state === 'present' && result.claim.ownerProjectRoot !== owner) {
      return `ancestor ${dir} is claimed by a different owner`;
    }
    if (result.state === 'present') {
      const problem = bindingProblem(result.claim, binding);
      if (problem) return `ancestor ${dir}: ${problem}`;
    }
  }
  return undefined;
}

async function evaluate(resource: Resource, all: readonly Resource[], owner: string, binding: Binding): Promise<Verdict> {
  const nested = await checkAncestors(resource, owner, binding);
  if (nested) return { refuse: nested };
  const claim = await readOwnerClaim(claimPathFor(resource.path, resource.kind));
  if (claim.state === 'invalid') return { refuse: `claim for ${resource.path} is invalid: ${claim.reason}` };
  if (claim.state === 'present') {
    const c = claim.claim;
    if (c.resourcePath !== resource.path || c.kind !== resource.kind) return { refuse: `claim for ${resource.path} does not match the resource` };
    if (c.ownerProjectRoot !== owner) return { refuse: `${resource.path} is owned by a different project` };
    const problem = bindingProblem(c, binding);
    if (problem) return { refuse: `${resource.path}: ${problem}` };
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
  // An in-flight (or killed) claim publication of this resource or another requested resource leaves a regular
  // `<claimPath>.tmp-<pid>-<hex>` file; it is explained, never data, and inspection leaves it untouched.
  const claimTemp = async (entry: string): Promise<boolean> =>
    all.some((r) => isClaimTempPathFor(entry, r.path, r.kind)) && (await lstat(entry)).isFile();
  for (const name of await readdir(resource.path)) {
    const entry = join(resource.path, name);
    if (!allowed(entry) && !(await claimTemp(entry))) return { refuse: `unclaimed non-empty directory ${resource.path}` };
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
    const required = witnessRequired(targets.ownerProjectRoot, resources);
    const current = required ? await readWorktreeWitness(targets.ownerProjectRoot) : undefined;
    if (current?.state === 'invalid') {
      return { targets, disposition: 'refuse', reason: `worktree witness is invalid: ${current.reason}` };
    }
    const binding: Binding = {
      required,
      witness: current?.state === 'present' ? current.witness : undefined,
      witnessReason: current === undefined ? 'not required' : 'worktree witness absent',
    };
    const verdicts: Verdict[] = [];
    for (const r of resources) verdicts.push(await evaluate(r, resources, targets.ownerProjectRoot, binding));
    const refused = verdicts.find((v): v is { refuse: string } => typeof v === 'object');
    if (refused) return { targets, disposition: 'refuse', reason: refused.refuse };
    const disposition = verdicts.every((v) => v === 'claimed') ? 'owned' : 'unclaimed-clean';
    return binding.witness === undefined ? { targets, disposition } : { targets, disposition, worktreeWitness: binding.witness };
  } catch (error) {
    return { targets, disposition: 'refuse', reason: `inspection failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}` };
  }
}
