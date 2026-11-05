import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type OwnedDiagnosticDirectoryResult =
  | Readonly<{ status: 'valid'; directory: string }>
  | Readonly<{ status: 'invalid'; reason: 'unverified' | 'unsupported' | 'invalid_path' }>;

export async function verifyOwnedDiagnosticDirectory(ownerRoot: string, directory: string): Promise<OwnedDiagnosticDirectoryResult> {
  if (process.platform !== 'linux' || process.getuid === undefined) return { status: 'invalid', reason: 'unsupported' };
  if (!isAbsolute(ownerRoot) || !isAbsolute(directory)) return { status: 'invalid', reason: 'invalid_path' };
  try {
    const [canonicalOwner, canonicalDirectory, ownerStat, directoryStat] = await Promise.all([
      realpath(ownerRoot), realpath(directory), lstat(ownerRoot), lstat(directory),
    ]);
    const inside = relative(canonicalOwner, canonicalDirectory);
    if (canonicalOwner !== resolve(ownerRoot) || canonicalDirectory !== resolve(directory)
      || inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
      || !ownerStat.isDirectory() || !directoryStat.isDirectory()
      || (ownerStat.mode & 0o777) !== 0o700 || (directoryStat.mode & 0o777) !== 0o700
      || ownerStat.uid !== process.getuid() || directoryStat.uid !== process.getuid()) {
      return { status: 'invalid', reason: 'unverified' };
    }
    return { status: 'valid', directory: canonicalDirectory };
  } catch {
    return { status: 'invalid', reason: 'unverified' };
  }
}
