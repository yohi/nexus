import { lstat, readFile } from 'node:fs/promises';

// Internal ownership claim format version 1. Task 3 (admission) writes these; preflight only reads them.
export const CLAIM_FORMAT_VERSION = 1;
/** Directory resources keep their claim inside the directory. */
export const DIRECTORY_CLAIM_FILENAME = '.nexus-owner-claim.json';
/** File resources (SQLite) keep their claim in an adjacent file named `<resource>` + this suffix. */
export const FILE_CLAIM_SUFFIX = '.nexus-owner-claim';
export const MAX_CLAIM_BYTES = 64 * 1024;

export type ClaimKind = 'file' | 'directory';

export interface OwnerClaim {
  readonly version: typeof CLAIM_FORMAT_VERSION;
  readonly ownerProjectRoot: string;
  readonly resourcePath: string;
  readonly kind: ClaimKind;
}

export const claimPathFor = (resourcePath: string, kind: ClaimKind): string =>
  kind === 'directory' ? `${resourcePath}/${DIRECTORY_CLAIM_FILENAME}` : `${resourcePath}${FILE_CLAIM_SUFFIX}`;

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
  try { parsed = JSON.parse(await readFile(claimPath, 'utf8')); }
  catch { return { state: 'invalid', reason: 'claim is malformed' }; }
  const c = parsed as Partial<OwnerClaim> | null;
  if (!c || typeof c !== 'object' || c.version !== CLAIM_FORMAT_VERSION ||
    typeof c.ownerProjectRoot !== 'string' || typeof c.resourcePath !== 'string' ||
    (c.kind !== 'file' && c.kind !== 'directory')) {
    return { state: 'invalid', reason: 'claim has unsupported version or shape' };
  }
  return { state: 'present', claim: { version: c.version, ownerProjectRoot: c.ownerProjectRoot, resourcePath: c.resourcePath, kind: c.kind } };
}
