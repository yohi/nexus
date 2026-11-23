import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256 } from '../performance/fixture-recipe.js';
import type { QualityCaseManifest, QualityRootKey, ObservationKind } from './contracts.js';
import type { OwnedQualityFixture } from './fixtures.js';

export interface SourceSnapshot {
  readonly rootKey: QualityRootKey;
  readonly canonicalProjectRoot: string;
  readonly snapshotDigest: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly sourceBytes: Readonly<Record<string, Uint8Array>>;
}
export interface SourceAdoption {
  readonly filePath: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly content: string;
  readonly sourceValidation: 'verified' | 'partial' | 'unknown';
}
export interface SourceProvenance {
  readonly observedSourceRootKey: QualityRootKey | null;
  readonly canonicalSourceRoot: string | null;
  readonly sourceRootProofDigest: string | null;
}
export type SourceFreshnessResult = 'FRESH_BYTES' | 'STALE_BYTES' | 'UNKNOWN';

const digestSnapshot = (hashes: Readonly<Record<string, string>>): string => sha256(Object.entries(hashes)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([path, digest]) => `${path}\0${digest}`).join('\n'));
const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.c', '.cpp', '.h', '.hpp']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '.nexus']);

function snapshotPath(snapshot: SourceSnapshot, filePath: string): string | null {
  const candidate = resolve(snapshot.canonicalProjectRoot, filePath);
  if (!inside(snapshot.canonicalProjectRoot, candidate)) return null;
  return relative(snapshot.canonicalProjectRoot, candidate).split(sep).join('/');
}

async function readTree(root: string, directory: string, bytes: Record<string, Uint8Array>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error('quality_snapshot_symlink_rejected');
    if (entry.isDirectory()) await readTree(root, fullPath, bytes);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) {
      bytes[relative(root, fullPath).split(sep).join('/')] = await readFile(fullPath);
    }
  }
}

export async function captureOracleSnapshot(fixture: OwnedQualityFixture, rootKey: QualityRootKey,
  taskId: string): Promise<SourceSnapshot> {
  const task = fixture.oracleCases.find((item) => item.taskId === taskId);
  const root = fixture.roots[rootKey];
  if (task === undefined || root === undefined || task.worktreeIdentity.rootKey !== rootKey) throw new Error('quality_snapshot_root_mismatch');
  const canonicalProjectRoot = await realpath(root);
  const fixtureRoot = await realpath(fixture.root);
  const expectedRoot = resolve(fixtureRoot, rootKey);
  if (!inside(fixtureRoot, canonicalProjectRoot) || canonicalProjectRoot !== expectedRoot) throw new Error('quality_snapshot_root_escape');
  for (const [otherKey, otherRoot] of Object.entries(fixture.roots)) {
    if (otherKey !== rootKey && await realpath(otherRoot) === canonicalProjectRoot) throw new Error('quality_snapshot_root_alias');
  }
  const bytes: Record<string, Uint8Array> = {};
  await readTree(canonicalProjectRoot, canonicalProjectRoot, bytes);
  const sourceHashes = Object.fromEntries(Object.entries(bytes).map(([path, content]) => [path, sha256(content)]));
  const snapshotDigest = digestSnapshot(sourceHashes);
  return Object.freeze({ rootKey, canonicalProjectRoot, snapshotDigest,
    sourceHashes: Object.freeze(sourceHashes), sourceBytes: Object.freeze(bytes) });
}

export function checkSourceFreshness(snapshot: SourceSnapshot, adoption: SourceAdoption): SourceFreshnessResult {
  const path = snapshotPath(snapshot, adoption.filePath);
  if (path === null) return 'UNKNOWN';
  const bytes = snapshot.sourceBytes[path];
  const digest = snapshot.sourceHashes[path];
  if (bytes === undefined || digest === undefined || !Number.isSafeInteger(adoption.startByte) ||
      !Number.isSafeInteger(adoption.endByte) || adoption.startByte < 0 || adoption.endByte <= adoption.startByte) return 'UNKNOWN';
  if (sha256(bytes) !== digest) return 'UNKNOWN';
  if (adoption.endByte > bytes.length) return 'STALE_BYTES';
  const adoptedBytes = new TextEncoder().encode(adoption.content);
  const sourceSlice = bytes.slice(adoption.startByte, adoption.endByte);
  if (sha256(adoptedBytes) !== sha256(sourceSlice)) return 'STALE_BYTES';
  return 'FRESH_BYTES';
}

function lineCharacter(bytes: Uint8Array, offset: number): Readonly<{ line: number; character: number }> {
  const prefix = new TextDecoder().decode(bytes.slice(0, offset));
  const lines = prefix.split('\n');
  const lastLine = lines.at(-1) ?? '';
  return { line: lines.length, character: lastLine.length };
}

function incompleteGolden(task: QualityCaseManifest): boolean {
  return new Set(task.sourceSnapshotDigest).size < 2 || task.expectedFiles.length === 0 ||
    task.expectedSymbols.length === 0 || task.expectedLocations.length === 0 ||
    Object.keys(task.expectedSourceHashes).length === 0;
}

function expectedNameMatches(content: string, name: string): boolean {
  const declaration = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/.exec(content);
  return declaration?.[1] === name;
}

export function gradeTaskSource(task: QualityCaseManifest, snapshot: SourceSnapshot,
  adoption: SourceAdoption, provenance: SourceProvenance): ObservationKind {
  if (incompleteGolden(task)) return 'INCONCLUSIVE';
  if (provenance.observedSourceRootKey === null || provenance.canonicalSourceRoot === null || provenance.sourceRootProofDigest === null) return 'INCONCLUSIVE';
  if (provenance.observedSourceRootKey !== task.worktreeIdentity.rootKey || provenance.observedSourceRootKey !== snapshot.rootKey) return 'WRONG_SOURCE';
  if (resolve(provenance.canonicalSourceRoot) !== snapshot.canonicalProjectRoot ||
      provenance.sourceRootProofDigest !== sha256(snapshot.canonicalProjectRoot)) return 'WRONG_SOURCE';
  if (digestSnapshot(snapshot.sourceHashes) !== snapshot.snapshotDigest || Object.entries(snapshot.sourceBytes)
    .some(([path, bytes]) => snapshot.sourceHashes[path] !== sha256(bytes)) ||
      Object.keys(snapshot.sourceBytes).length !== Object.keys(snapshot.sourceHashes).length) return 'INCONCLUSIVE';
  if (adoption.sourceValidation !== 'verified') return 'INCONCLUSIVE';
  if (adoption.content.length === 0) return 'MISSING';
  const path = snapshotPath(snapshot, adoption.filePath);
  if (path === null) return 'WRONG_SOURCE';
  if (task.expectedFiles.includes(path) && snapshot.sourceBytes[path] === undefined) return 'FALSE_FRESH';
  const freshness = checkSourceFreshness(snapshot, adoption);
  if (freshness === 'UNKNOWN') return 'INCONCLUSIVE';
  if (freshness === 'STALE_BYTES') return 'FALSE_FRESH';
  const matchingFile = task.expectedFiles.includes(path);
  const symbol = task.expectedSymbols.find((candidate) => candidate.filePath === path &&
    candidate.startByte === adoption.startByte && candidate.endByte === adoption.endByte);
  const expectedHash = task.expectedSourceHashes[path];
  const bytes = snapshot.sourceBytes[path];
  const rangeHash = sha256(bytes?.slice(adoption.startByte, adoption.endByte) ?? new Uint8Array());
  if (!matchingFile || symbol === undefined || expectedHash === undefined || bytes === undefined ||
      rangeHash !== expectedHash || !expectedNameMatches(adoption.content, symbol.name) || !task.expectedLocations.some((location) => {
        if (location.filePath !== path) return false;
        const actual = lineCharacter(bytes, adoption.startByte);
        return actual.line === location.line && actual.character === location.character;
      })) return 'WRONG_SOURCE';
  return 'CORRECT_CURRENT';
}
