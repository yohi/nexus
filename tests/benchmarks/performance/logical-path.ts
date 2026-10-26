import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FixtureManifest } from './contracts.js';
import { logicalPathSchema } from './contracts.js';

export type FixturePathNormalizer = (returnedPath: string) => Promise<string>;
type PathFailure = 'invalid_result_path' | 'outside_fixture_root' | 'unknown_fixture_file' |
  'missing_fixture_file' | 'fixture_path_alias' | 'fixture_symlink_escape' | 'invalid_manifest_path';
export class FixturePathError extends Error {
  constructor(readonly code: PathFailure) { super(code); this.name = 'FixturePathError'; }
}

function containedPath(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (path === '' || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new FixturePathError('outside_fixture_root');
  return path;
}

export async function createFixturePathNormalizer(root: string, manifest: FixtureManifest,
  signal?: AbortSignal): Promise<FixturePathNormalizer> {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const files = new Map<string, string>();
  const physicalFiles = new Set<string>();
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const parsed = logicalPathSchema.safeParse(file.path);
    if (!parsed.success || files.has(file.path)) throw new FixturePathError('invalid_manifest_path');
    let path = canonicalRoot;
    try {
      for (const segment of file.path.split('/')) {
        signal?.throwIfAborted();
        path = join(path, segment);
        if ((await lstat(path)).isSymbolicLink()) throw new FixturePathError('fixture_path_alias');
      }
      const canonical = await realpath(path);
      containedPath(canonicalRoot, canonical);
      if (!(await lstat(canonical)).isFile()) throw new FixturePathError('missing_fixture_file');
      if (physicalFiles.has(canonical)) throw new FixturePathError('fixture_path_alias');
      files.set(file.path, canonical);
      physicalFiles.add(canonical);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw error instanceof FixturePathError ? error : new FixturePathError('missing_fixture_file');
    }
  }

  return async (returnedPath) => {
    signal?.throwIfAborted();
    if (returnedPath.includes('\0') || (sep === '/' && returnedPath.includes('\\'))) throw new FixturePathError('invalid_result_path');
    let logical: string;
    let candidate: string;
    if (isAbsolute(returnedPath)) {
      const path = containedPath(canonicalRoot, resolve(returnedPath));
      logical = path.split(sep).join('/');
      candidate = returnedPath;
    } else {
      const parsed = logicalPathSchema.safeParse(returnedPath);
      if (!parsed.success) throw new FixturePathError('invalid_result_path');
      logical = parsed.data;
      candidate = resolve(canonicalRoot, logical);
    }
    const expected = files.get(logical);
    if (expected === undefined) throw new FixturePathError('unknown_fixture_file');
    let actual: string;
    try {
      actual = await realpath(candidate);
      if (!(await lstat(actual)).isFile()) throw new FixturePathError('missing_fixture_file');
    } catch (error) {
      if (signal?.aborted) throw error;
      throw error instanceof FixturePathError ? error : new FixturePathError('missing_fixture_file');
    }
    signal?.throwIfAborted();
    try { containedPath(canonicalRoot, actual); }
    catch { throw new FixturePathError('fixture_symlink_escape'); }
    if (actual !== expected) throw new FixturePathError('fixture_path_alias');
    return logical;
  };
}
