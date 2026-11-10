import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Config } from '../../types/index.js';
import type { CanonicalPath, PersistentTarget, ResolvedStorageOwnershipTargets, VectorTarget } from './types.js';

const MEMORY = 'memory://';

/**
 * Canonicalize without creating anything: realpath for present entries, verified canonical existing ancestor plus
 * unresolved suffix for missing ones. Dangling symlinks and non-directory ancestors are rejected.
 */
export async function canonicalize(input: string, label: string): Promise<CanonicalPath> {
  if (input.includes('\0')) throw new Error(`Invalid ${label}: contains null byte`);
  const absolute = resolve(input); // same semantics as StorageManager: relative to process cwd, not projectRoot
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    let exists = true;
    try { await lstat(current); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`Unsafe ${label}: cannot inspect ${current} (${code ?? 'unknown'})`);
      exists = false;
    }
    if (exists) {
      let real: string;
      try { real = await realpath(current); }
      catch { throw new Error(`Unsafe ${label}: dangling or unresolvable alias at ${current}`); }
      return join(real, ...suffix.reverse()) as CanonicalPath;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Unsafe ${label}: no existing ancestor`);
    suffix.push(basename(current));
    current = parent;
  }
}

export async function assertNotHardlinked(path: CanonicalPath, label: string): Promise<void> {
  let stat;
  try { stat = await lstat(path); } catch { return; }
  if (stat.isDirectory()) throw new Error(`Unsafe ${label}: SQLite target is a directory`);
  if (stat.isFile() && stat.nlink > 1) throw new Error(`Unsafe ${label}: hard-linked SQLite file`);
}

export async function resolveStorageOwnershipTargets(config: Config): Promise<ResolvedStorageOwnershipTargets> {
  const ownerProjectRoot = await canonicalize(config.projectRoot, 'projectRoot');
  const root: PersistentTarget = { kind: 'persistent', path: await canonicalize(config.storage.rootDir, 'storage.rootDir') };
  const metadataPath = await canonicalize(config.storage.metadataDbPath, 'storage.metadataDbPath');
  await assertNotHardlinked(metadataPath, 'storage.metadataDbPath');
  const metadataDbPath: PersistentTarget = { kind: 'persistent', path: metadataPath };

  const rawVector = config.storage.vectorDbPath;
  let vectorDbPath: VectorTarget;
  if (rawVector === MEMORY || rawVector === '') {
    vectorDbPath = { kind: 'ephemeral', source: MEMORY };
  } else if (rawVector.includes('://')) {
    throw new Error('Unsupported storage.vectorDbPath: only exact "memory://" or a local path is allowed');
  } else {
    vectorDbPath = { kind: 'persistent', path: await canonicalize(rawVector, 'storage.vectorDbPath') };
  }
  return { ownerProjectRoot, rootDir: root, metadataDbPath, vectorDbPath };
}

export function storageTargetsFingerprint(targets: ResolvedStorageOwnershipTargets): string {
  const v = targets.vectorDbPath;
  return createHash('sha256').update(JSON.stringify([
    'nexus-targets-v1', targets.ownerProjectRoot, targets.rootDir.path, targets.metadataDbPath.path,
    v.kind, v.kind === 'persistent' ? v.path : MEMORY,
  ])).digest('hex');
}
