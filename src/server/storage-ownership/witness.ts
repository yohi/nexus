// Worktree Incarnation Witness (Nexus #297 W06, Design §4.6). Internal only; not a public API or identity.
//
// The Runtime Identity stays the canonical projectRoot. The witness is additional evidence that a durable storage
// claim, or a published Endpoint, belongs to the *current* worktree incarnation rather than to an earlier worktree that
// happened to live at the same canonical path. It is stored inside the worktree's own untracked, git-ignored local
// state directory (`<projectRoot>/.nexus/worktree-witness`), so deleting the worktree deletes the witness, whereas
// external custom storage (and its claims) survives. It is created exactly once, only inside WriterAdmission.
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { isWithin } from './claims.js';
import type { ClaimKind } from './claim-format.js';

export const WITNESS_DIRNAME = '.nexus';
export const WITNESS_FILENAME = 'worktree-witness';
export const WITNESS_FORMAT_VERSION = 1;
const MAX_WITNESS_BYTES = 4 * 1024;
const WITNESS_PATTERN = /^[0-9a-f]{64}$/;

export type WitnessState =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly witness: string }
  | { readonly state: 'invalid'; readonly reason: string };

interface PersistentPath { readonly path: string; readonly kind: ClaimKind }

/**
 * A witness is required whenever any persistent storage target lives outside the worktree: only then can its claims
 * outlive the worktree. Storage fully inside the project dies with the worktree and keeps the existing behavior.
 */
export const witnessRequired = (ownerProjectRoot: string, resources: readonly { readonly path: string }[]): boolean =>
  resources.some((r) => !isWithin(r.path, ownerProjectRoot));

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const witnessDir = (ownerProjectRoot: string): string => join(ownerProjectRoot, WITNESS_DIRNAME);
const witnessPath = (ownerProjectRoot: string): string => join(witnessDir(ownerProjectRoot), WITNESS_FILENAME);

type DirectoryState = { readonly state: 'ok' | 'absent' } | { readonly state: 'invalid'; readonly reason: string };

async function verifyWitnessDirectory(ownerProjectRoot: string): Promise<DirectoryState> {
  const dir = witnessDir(ownerProjectRoot);
  let stat;
  try { stat = await lstat(dir); }
  catch (error) {
    if (errno(error) === 'ENOENT') return { state: 'absent' };
    return { state: 'invalid', reason: `witness directory unreadable (${errno(error) ?? 'unknown'})` };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'invalid', reason: 'witness directory is not a real directory' };
  if (stat.uid !== process.getuid?.()) return { state: 'invalid', reason: 'witness directory is not owned by the current account' };
  if (await realpath(dir).catch(() => undefined) !== dir) return { state: 'invalid', reason: 'witness directory resolves through an alias' };
  return { state: 'ok' };
}

/** Read-only, no-follow witness read. Never creates, writes or deletes anything. */
export async function readWorktreeWitness(ownerProjectRoot: string): Promise<WitnessState> {
  const dirState = await verifyWitnessDirectory(ownerProjectRoot);
  if (dirState.state === 'absent') return { state: 'absent' };
  if (dirState.state === 'invalid') return dirState;
  const path = witnessPath(ownerProjectRoot);
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (errno(error) === 'ENOENT') return { state: 'absent' };
    return { state: 'invalid', reason: `witness unreadable (${errno(error) ?? 'unknown'})` };
  }
  if (!stat.isFile() || stat.nlink !== 1) return { state: 'invalid', reason: 'witness is not a single-link regular file' };
  if (stat.uid !== process.getuid?.()) return { state: 'invalid', reason: 'witness is not owned by the current account' };
  if (stat.size > MAX_WITNESS_BYTES) return { state: 'invalid', reason: 'witness too large' };
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch { return { state: 'invalid', reason: 'witness is malformed' }; }
  const w = parsed as { version?: unknown; projectRoot?: unknown; witness?: unknown } | null;
  if (!w || typeof w !== 'object' || w.version !== WITNESS_FORMAT_VERSION || typeof w.witness !== 'string' ||
    !WITNESS_PATTERN.test(w.witness) || typeof w.projectRoot !== 'string') {
    return { state: 'invalid', reason: 'witness has unsupported version or shape' };
  }
  if (w.projectRoot !== ownerProjectRoot) return { state: 'invalid', reason: 'witness belongs to a different project root' };
  return { state: 'present', witness: w.witness };
}

function publishWitness(ownerProjectRoot: string): void {
  const finalPath = witnessPath(ownerProjectRoot);
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const content = `${JSON.stringify({
    version: WITNESS_FORMAT_VERSION, projectRoot: ownerProjectRoot, witness: randomBytes(32).toString('hex'),
  })}\n`;
  const fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    // link() never replaces: a concurrently published witness wins, an interrupted attempt leaves no final file.
    try { linkSync(tempPath, finalPath); }
    catch (error) { if (errno(error) !== 'EEXIST') throw error; }
  } finally {
    try { unlinkSync(tempPath); } catch { /* attempt-owned temp already gone */ }
  }
}

/**
 * Return the existing witness or create it atomically. MUST only be called while holding the writer admission gate
 * and the writer leases. Refuses (never repairs or regenerates) a malformed, foreign or aliased witness, and refuses
 * when the witness location would fall inside a claim-required storage directory.
 */
export async function ensureWorktreeWitness(
  ownerProjectRoot: string, resources: readonly PersistentPath[],
): Promise<{ readonly ok: true; readonly witness: string } | { readonly ok: false; readonly reason: string }> {
  const dir = witnessDir(ownerProjectRoot);
  if (resources.some((r) => r.kind === 'directory' && isWithin(dir, r.path))) {
    return { ok: false, reason: 'worktree witness location overlaps a storage directory' };
  }
  const existing = await readWorktreeWitness(ownerProjectRoot);
  if (existing.state === 'present') return { ok: true, witness: existing.witness };
  if (existing.state === 'invalid') return { ok: false, reason: existing.reason };
  try {
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (errno(error) !== 'EEXIST') throw error; }
    if (await realpath(dirname(dir)) !== ownerProjectRoot) throw new Error('projectRoot changed identity');
    publishWitness(ownerProjectRoot);
  } catch (error) {
    return { ok: false, reason: `witness publication failed: ${errno(error) ?? (error as Error).message}` };
  }
  const created = await readWorktreeWitness(ownerProjectRoot);
  return created.state === 'present'
    ? { ok: true, witness: created.witness }
    : { ok: false, reason: created.state === 'invalid' ? created.reason : 'witness missing after publication' };
}
