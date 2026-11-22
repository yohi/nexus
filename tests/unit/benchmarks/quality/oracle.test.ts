import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../benchmarks/performance/fixture-recipe.js';
import { QUALITY_CASES_V1 } from '../../../benchmarks/quality/manifest.js';
import { checkSourceFreshness, gradeTaskSource, type SourceAdoption, type SourceProvenance, type SourceSnapshot } from '../../../benchmarks/quality/oracle.js';

const snapshotDigest = (hashes: Readonly<Record<string, string>>): string => sha256(Object.entries(hashes)
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([path, digest]) => `${path}\0${digest}`).join('\n'));

const makeSnapshot = (root: string, files: Readonly<Record<string, string>>, rootKey: 'single' | 'primary' | 'linked' = 'single'): SourceSnapshot => {
  const sourceBytes = Object.fromEntries(Object.entries(files).map(([path, source]) => [path, new TextEncoder().encode(source)]));
  const sourceHashes = Object.fromEntries(Object.entries(sourceBytes).map(([path, bytes]) => [path, sha256(bytes)]));
  return { rootKey, canonicalProjectRoot: root, snapshotDigest: snapshotDigest(sourceHashes), sourceHashes, sourceBytes };
};

const proof = (root: string, rootKey: 'single' | 'primary' | 'linked' = 'single'): SourceProvenance => ({
  observedSourceRootKey: rootKey, canonicalSourceRoot: root, sourceRootProofDigest: sha256(root),
});

const taskWithGolden = (filePath: string, source: string, name: string, startByte: number, endByte: number,
  line = 1, character = 0) => {
  const task = QUALITY_CASES_V1[0];
  if (task === undefined) throw new Error('quality manifest missing');
  const bytes = new TextEncoder().encode(source);
  const sourceSlice = bytes.slice(startByte, endByte);
  return { ...task, sourceSnapshotDigest: snapshotDigest({ [filePath]: sha256(bytes) }), expectedFiles: [filePath],
    expectedSymbols: [{ filePath, name, startByte, endByte }], expectedSourceHashes: { [filePath]: sha256(sourceSlice) },
    expectedLocations: [{ filePath, line, character }] };
};

describe('quality source oracle', () => {
  it('accepts the exact declaration range and rejects whole-file adoption', () => {
    // Given
    const root = '/owned/project';
    const declaration = 'export function answer(): number { return 42; }';
    const source = `${declaration}\n`;
    const snapshot = makeSnapshot(root, { 'src/answer.ts': source });
    const task = taskWithGolden('src/answer.ts', source, 'answer', 0, new TextEncoder().encode(declaration).length);
    const declarationAdoption: SourceAdoption = { filePath: 'src/answer.ts', startByte: 0,
      endByte: new TextEncoder().encode(declaration).length, content: declaration, sourceValidation: 'verified' };
    // When
    const exact = gradeTaskSource(task, snapshot, declarationAdoption, proof(root));
    const wholeFile = gradeTaskSource(task, snapshot, { ...declarationAdoption,
      endByte: new TextEncoder().encode(source).length, content: source }, proof(root));
    // Then
    expect(checkSourceFreshness(snapshot, declarationAdoption)).toBe('FRESH_BYTES');
    expect(exact).toBe('CORRECT_CURRENT');
    expect(wholeFile).toBe('WRONG_SOURCE');
  });

  it('rejects current irrelevant bytes at the Golden target check with valid snapshot and provenance', () => {
    // Given
    const root = '/owned/project';
    const source = 'export const unrelated = 1;\n';
    const snapshot = makeSnapshot(root, { 'src/other.ts': source });
    const task = taskWithGolden('src/target.ts', source, 'target', 0, source.length - 1);
    const adoption: SourceAdoption = { filePath: 'src/other.ts', startByte: 0, endByte: source.length - 1,
      content: source.trimEnd(), sourceValidation: 'verified' };
    // When / Then
    expect(snapshot.snapshotDigest).toBe(snapshotDigest(snapshot.sourceHashes));
    expect(checkSourceFreshness(snapshot, adoption)).toBe('FRESH_BYTES');
    expect(gradeTaskSource(task, snapshot, adoption, proof(root))).toBe('WRONG_SOURCE');
  });

  it('distinguishes wrong-root same-hash adoption despite valid provenance for its actual root', () => {
    // Given
    const source = 'export function answer(): number { return 42; }';
    const primary = makeSnapshot('/owned/primary', { 'src/answer.ts': source }, 'primary');
    const linked = makeSnapshot('/owned/linked', { 'src/answer.ts': source }, 'linked');
    const task = taskWithGolden('src/answer.ts', source, 'answer', 0, source.length);
    const adoption: SourceAdoption = { filePath: 'src/answer.ts', startByte: 0, endByte: source.length,
      content: source, sourceValidation: 'verified' };
    // When / Then
    expect(primary.sourceHashes['src/answer.ts']).toBe(linked.sourceHashes['src/answer.ts']);
    expect(gradeTaskSource(task, primary, adoption, proof('/owned/primary', 'primary'))).toBe('WRONG_SOURCE');
    const localSnapshot = makeSnapshot('/owned/project', { 'src/answer.ts': source });
    expect(gradeTaskSource(task, localSnapshot, adoption, proof('/owned/other'))).toBe('WRONG_SOURCE');
  });

  it('returns inconclusive for placeholder Golden data and unknown provenance', () => {
    // Given
    const task = QUALITY_CASES_V1[0];
    if (task === undefined) throw new Error('quality manifest missing');
    const source = 'export function answer(): number { return 42; }';
    const snapshot = makeSnapshot('/owned/project', { 'src/answer.ts': source });
    const adoption: SourceAdoption = { filePath: 'src/answer.ts', startByte: 0, endByte: source.length,
      content: source, sourceValidation: 'verified' };
    // When / Then
    expect(gradeTaskSource(task, snapshot, adoption, proof('/owned/project'))).toBe('INCONCLUSIVE');
    expect(gradeTaskSource({ ...taskWithGolden('src/answer.ts', source, 'answer', 0, source.length), sourceSnapshotDigest: 'a'.repeat(64) },
      snapshot, adoption, proof('/owned/project'))).toBe('INCONCLUSIVE');
    expect(gradeTaskSource(taskWithGolden('src/answer.ts', source, 'answer', 0, source.length), snapshot,
      adoption, { observedSourceRootKey: null, canonicalSourceRoot: null, sourceRootProofDigest: null })).toBe('INCONCLUSIVE');
  });

  it('uses UTF-16 code units for locations while retaining UTF-8 byte offsets', () => {
    // Given
    const root = '/owned/project';
    const prefix = 'const label = "あ"; ';
    const declaration = 'export function answer(): number { return 42; }';
    const source = `${prefix}${declaration}\n`;
    const startByte = new TextEncoder().encode(prefix).length;
    const endByte = startByte + new TextEncoder().encode(declaration).length;
    const task = taskWithGolden('src/unicode.ts', source, 'answer', startByte, endByte, 1, prefix.length);
    const snapshot = makeSnapshot(root, { 'src/unicode.ts': source });
    const adoption: SourceAdoption = { filePath: 'src/unicode.ts', startByte, endByte,
      content: declaration, sourceValidation: 'verified' };
    // When / Then
    expect(checkSourceFreshness(snapshot, adoption)).toBe('FRESH_BYTES');
    expect(task.expectedSourceHashes['src/unicode.ts']).toBe(sha256(snapshot.sourceBytes['src/unicode.ts']?.slice(startByte, endByte) ?? new Uint8Array()));
    expect(gradeTaskSource(task, snapshot, adoption, proof(root))).toBe('CORRECT_CURRENT');
  });

  it('classifies an empty adoption as missing before freshness comparison', () => {
    // Given
    const root = '/owned/project';
    const source = 'export function answer(): number { return 42; }';
    const task = taskWithGolden('src/answer.ts', source, 'answer', 0, source.length);
    const snapshot = makeSnapshot(root, { 'src/answer.ts': source });
    const adoption: SourceAdoption = { filePath: 'src/answer.ts', startByte: 0, endByte: 0, content: '', sourceValidation: 'verified' };
    // When / Then
    expect(gradeTaskSource(task, snapshot, adoption, proof(root))).toBe('MISSING');
  });

  it('requires the expected declaration name, not only matching location and range', () => {
    // Given
    const root = '/owned/project';
    const source = 'export function actual(): number { return 42; }';
    const snapshot = makeSnapshot(root, { 'src/answer.ts': source });
    const task = taskWithGolden('src/answer.ts', source, 'expected', 0, source.length);
    const adoption: SourceAdoption = { filePath: 'src/answer.ts', startByte: 0, endByte: source.length,
      content: source, sourceValidation: 'verified' };
    // When / Then
    expect(gradeTaskSource(task, snapshot, adoption, proof(root))).toBe('WRONG_SOURCE');
  });
});
