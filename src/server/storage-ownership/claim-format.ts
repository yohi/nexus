import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

// Internal ownership claim format version 1. Task 3 (admission) writes these; preflight only reads them.
export const CLAIM_FORMAT_VERSION = 1;
/**
 * Claim format version 2 (Nexus #297 W06): additionally records the Worktree Incarnation Witness. It is written only for
 * storage that can outlive the worktree (a persistent target outside the project root). Version 1 claims stay valid
 * for fully in-project storage but are never adopted for external storage (they cannot prove their incarnation).
 */
export const WITNESS_CLAIM_FORMAT_VERSION = 2;
/** Directory resources keep their claim inside the directory. */
export const DIRECTORY_CLAIM_FILENAME = '.nexus-owner-claim.json';
/** File resources (SQLite) keep their claim in an adjacent file named `<resource>` + this suffix. */
export const FILE_CLAIM_SUFFIX = '.nexus-owner-claim';
export const MAX_CLAIM_BYTES = 64 * 1024;

export type ClaimKind = 'file' | 'directory';

export interface OwnerClaim {
  readonly version: typeof CLAIM_FORMAT_VERSION | typeof WITNESS_CLAIM_FORMAT_VERSION;
  readonly ownerProjectRoot: string;
  readonly resourcePath: string;
  readonly kind: ClaimKind;
  /** Present exactly on version 2 claims. */
  readonly worktreeWitness?: string;
}

/**
 * Whether `claim` is bound to the current worktree incarnation. `witness === undefined` means no witness is required
 * (storage fully inside the project): any valid claim qualifies. Otherwise only a version 2 claim carrying exactly the
 * current witness qualifies; legacy v1 claims and other incarnations' claims never do.
 */
export function claimBindingProblem(claim: OwnerClaim, witness: string | undefined): string | undefined {
  if (witness === undefined) return undefined;
  if (claim.version !== WITNESS_CLAIM_FORMAT_VERSION || claim.worktreeWitness === undefined) {
    return 'legacy claim cannot be bound to this worktree incarnation';
  }
  return claim.worktreeWitness === witness ? undefined : 'claim belongs to a different worktree incarnation';
}

export const claimPathFor = (resourcePath: string, kind: ClaimKind): string =>
  kind === 'directory' ? `${resourcePath}/${DIRECTORY_CLAIM_FILENAME}` : `${resourcePath}${FILE_CLAIM_SUFFIX}`;

const CLAIM_TEMP_SUFFIX = /^\.tmp-\d+-[0-9a-f]{12}$/;

/**
 * Whether `entryPath` has the exact name of an attempt-owned temporary file that `publishClaim()` creates next to the
 * claim of (`resourcePath`, `kind`) between its fsync and link: `<claimPath>.tmp-<pid>-<12 hex>`. Such a file is a
 * claim-publication artifact (in flight, or left by a killed attempt), not storage data. Name check only; callers must
 * still verify it is a regular file. It is never adopted as a claim and never deleted by inspection or admission.
 */
export function isClaimTempPathFor(entryPath: string, resourcePath: string, kind: ClaimKind): boolean {
  const claimPath = claimPathFor(resourcePath, kind);
  return entryPath.startsWith(claimPath) && CLAIM_TEMP_SUFFIX.test(entryPath.slice(claimPath.length));
}

export type ClaimReadResult =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly claim: OwnerClaim }
  | { readonly state: 'invalid'; readonly reason: string };

/** Read-only, no-follow claim parser. Never writes, creates or deletes anything. */
export async function readOwnerClaim(claimPath: string): Promise<ClaimReadResult> {
  let stat;
  try { stat = await lstat(claimPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'invalid', reason: `claim unreadable (${code ?? 'unknown'})` };
  }
  if (!stat.isFile()) return { state: 'invalid', reason: 'claim is not a regular file' };
  if (stat.size > MAX_CLAIM_BYTES) return { state: 'invalid', reason: 'claim too large' };
  let parsed: unknown;
  let handle;
  try {
    handle = await open(claimPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      return { state: 'invalid', reason: 'claim identity or size changed while opening' };
    }
    const buffer = Buffer.alloc(MAX_CLAIM_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead > MAX_CLAIM_BYTES || after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || bytesRead !== opened.size) {
      return { state: 'invalid', reason: bytesRead > MAX_CLAIM_BYTES ? 'claim too large' : 'claim changed while reading' };
    }
    parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  }
  catch { return { state: 'invalid', reason: 'claim is malformed' }; }
  finally { await handle?.close().catch(() => undefined); }
  const c = parsed as Partial<OwnerClaim> | null;
  if (!c || typeof c !== 'object' || (c.version !== CLAIM_FORMAT_VERSION && c.version !== WITNESS_CLAIM_FORMAT_VERSION) ||
    typeof c.ownerProjectRoot !== 'string' || typeof c.resourcePath !== 'string' ||
    (c.kind !== 'file' && c.kind !== 'directory')) {
    return { state: 'invalid', reason: 'claim has unsupported version or shape' };
  }
  const base = { ownerProjectRoot: c.ownerProjectRoot, resourcePath: c.resourcePath, kind: c.kind };
  if (c.version === CLAIM_FORMAT_VERSION) {
    if (c.worktreeWitness !== undefined) return { state: 'invalid', reason: 'claim has unsupported version or shape' };
    return { state: 'present', claim: { version: c.version, ...base } };
  }
  if (typeof c.worktreeWitness !== 'string' || !/^[0-9a-f]{64}$/.test(c.worktreeWitness)) {
    return { state: 'invalid', reason: 'claim has unsupported version or shape' };
  }
  return { state: 'present', claim: { version: c.version, ...base, worktreeWitness: c.worktreeWitness } };
}
