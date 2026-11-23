import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../../benchmarks/performance/fixture-recipe.js';
import { applyQualityMutation, createQualityFixture, QualitySetupError } from '../../benchmarks/quality/fixtures.js';
import { captureOracleSnapshot, gradeTaskSource, type SourceAdoption, type SourceProvenance } from '../../benchmarks/quality/oracle.js';

const proofFor = (root: string, rootKey: 'single' | 'primary' | 'linked'): SourceProvenance => ({
  observedSourceRootKey: rootKey, canonicalSourceRoot: root, sourceRootProofDigest: sha256(root),
});

describe('owned quality fixture integration', () => {
  it('creates deterministic snapshots that match independently read filesystem bytes and disposes its root', async () => {
    // Given
    const sentinel = await mkdtemp(`${tmpdir()}/nexus-quality-sentinel-`);
    const sentinelFile = `${sentinel}/keep.txt`;
    await writeFile(sentinelFile, 'untouched');
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('quality task missing');
      // When
      const first = await captureOracleSnapshot(fixture, 'single', task.taskId);
      const second = await captureOracleSnapshot(fixture, 'single', task.taskId);
      const actualBytes = await readFile(`${first.canonicalProjectRoot}/Q01/src/answer.ts`);
      // Then
      expect(isAbsolute(fixture.root)).toBe(true);
      expect(first.snapshotDigest).toBe(second.snapshotDigest);
      expect(first.sourceHashes['Q01/src/answer.ts']).toBe(sha256(actualBytes));
      expect(first.sourceBytes['Q01/src/answer.ts']).toEqual(actualBytes);
      expect(fixture.roots.single).toBe(first.canonicalProjectRoot);
      expect(fixture.publicTasks[0]).not.toHaveProperty('expectedFiles');
    } finally {
      await fixture.dispose();
      await expect(access(fixture.root)).rejects.toThrow();
      expect(await readFile(sentinelFile, 'utf8')).toBe('untouched');
      await rm(sentinel, { recursive: true, force: true });
    }
  });

  it('rejects unknown roots, aliased root mappings, and unknown task ids', async () => {
    // Given
    const fixture = await createQualityFixture(['Q12@quality-v1'], new AbortController().signal);
    try {
      const linked = fixture.oracleCases.find((item) => item.taskId === 'Q12-linked');
      if (linked === undefined) throw new Error('linked task missing');
      const alias = { ...fixture, roots: { ...fixture.roots, linked: fixture.roots.primary } };
      // When / Then
      await expect(captureOracleSnapshot(alias, 'linked', linked.taskId)).rejects.toThrow('quality_snapshot_root_escape');
      await expect(captureOracleSnapshot(fixture, 'linked', 'unknown')).rejects.toThrow('quality_snapshot_root_mismatch');
      await expect(applyQualityMutation(fixture, 'unknown', 'before_request')).rejects.toThrow('quality_task_not_found');
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects empty, duplicate, and unknown scenario selections with setup_incomplete errors', async () => {
    // Given
    const signal = new AbortController().signal;
    // When / Then
    for (const scenarios of [[], ['Q01@quality-v1', 'Q01@quality-v1'], ['Q99@quality-v1']]) {
      const setup = createQualityFixture(scenarios, signal);
      await expect(setup).rejects.toBeInstanceOf(QualitySetupError);
      await expect(setup).rejects.toMatchObject({
        name: 'QualitySetupError', status: 'setup_incomplete',
      });
    }
    expect(new QualitySetupError('scenario_unknown')).toBeInstanceOf(Error);
  });

  it('honors cancellation before allocating an owned fixture root', async () => {
    // Given
    const controller = new AbortController();
    controller.abort(new Error('fixture setup cancelled'));
    // When / Then
    await expect(createQualityFixture(['Q01@quality-v1'], controller.signal)).rejects.toThrow('fixture setup cancelled');
  });

  it('builds cross-file rename and move scenarios with different Golden targets', async () => {
    // Given
    const fixture = await createQualityFixture(['Q03@quality-v1', 'Q04@quality-v1'], new AbortController().signal);
    try {
      const rename = fixture.oracleCases.find((item) => item.scenarioId === 'Q03@quality-v1');
      const move = fixture.oracleCases.find((item) => item.scenarioId === 'Q04@quality-v1');
      if (rename === undefined || move === undefined) throw new Error('scenario Golden missing');
      const snapshot = await captureOracleSnapshot(fixture, 'single', rename.taskId);
      // When / Then
      expect(rename.expectedFiles).toHaveLength(1);
      expect(rename.expectedSymbols[0]?.name).not.toBe('answer');
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.includes('old-name.ts'))).toBe(true);
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.includes('new-name.ts'))).toBe(true);
      expect(move.expectedFiles[0]).toContain('moved.ts');
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.includes('before-move.ts'))).toBe(true);
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.includes('moved.ts'))).toBe(true);
      const beforeMove = Object.entries(snapshot.sourceBytes).find(([path]) => path.includes('before-move.ts'))?.[1];
      const afterMove = Object.entries(snapshot.sourceBytes).find(([path]) => path.includes('moved.ts'))?.[1];
      expect(beforeMove).toEqual(afterMove);
    } finally {
      await fixture.dispose();
    }
  });

  it('captures Q05 deletion and Q06 delete/recreate as request and publication snapshots', async () => {
    // Given
    const fixture = await createQualityFixture(['Q05@quality-v1', 'Q06@quality-v1'], new AbortController().signal);
    try {
      const deletion = fixture.oracleCases.find((item) => item.scenarioId === 'Q05@quality-v1');
      const recreation = fixture.oracleCases.find((item) => item.scenarioId === 'Q06@quality-v1');
      if (deletion === undefined || recreation === undefined) throw new Error('mutation Golden missing');
      const deletionRequest = await captureOracleSnapshot(fixture, 'single', deletion.taskId);
      const deletedPath = deletion.expectedFiles[0];
      if (deletedPath === undefined) throw new Error('deletion target missing');
      const deletionAdoption: SourceAdoption = { filePath: deletedPath, startByte: deletion.expectedSymbols[0]?.startByte ?? 0,
        endByte: deletion.expectedSymbols[0]?.endByte ?? 0, content: 'export function answer(): number { return 42; }', sourceValidation: 'verified' };
      // When
      await applyQualityMutation(fixture, deletion.taskId, 'before_publication');
      const deletionPublication = await captureOracleSnapshot(fixture, 'single', deletion.taskId);
      const recreationRequest = await captureOracleSnapshot(fixture, 'single', recreation.taskId);
      await applyQualityMutation(fixture, recreation.taskId, 'during_request');
      // Then
      expect(deletionRequest.sourceHashes[deletedPath]).toBeDefined();
      expect(deletionPublication.sourceHashes[deletedPath]).toBeUndefined();
      expect(gradeTaskSource(deletion, deletionPublication, deletionAdoption, proofFor(deletionPublication.canonicalProjectRoot, 'single'))).toBe('FALSE_FRESH');
      const recreationPath = recreation.expectedFiles[0];
      if (recreationPath === undefined) throw new Error('recreation target missing');
      const recreationDeleted = await captureOracleSnapshot(fixture, 'single', recreation.taskId);
      expect(recreationRequest.sourceHashes[recreationPath]).toBeDefined();
      expect(recreationDeleted.sourceHashes[recreationPath]).toBeUndefined();
      await applyQualityMutation(fixture, recreation.taskId, 'before_publication');
      const recreationPublication = await captureOracleSnapshot(fixture, 'single', recreation.taskId);
      expect(recreationPublication.sourceHashes[recreationPath]).not.toBe(recreationRequest.sourceHashes[recreationPath]);
      const symbol = recreation.expectedSymbols[0];
      if (symbol === undefined) throw new Error('recreation Golden missing');
      const currentBytes = recreationPublication.sourceBytes[recreationPath];
      if (currentBytes === undefined) throw new Error('publication source missing');
      const currentAdoption: SourceAdoption = { filePath: recreationPath, startByte: symbol.startByte, endByte: symbol.endByte,
        content: new TextDecoder().decode(currentBytes.slice(symbol.startByte, symbol.endByte)), sourceValidation: 'verified' };
      expect(gradeTaskSource(recreation, recreationPublication, currentAdoption,
        proofFor(recreationPublication.canonicalProjectRoot, 'single'))).toBe('CORRECT_CURRENT');
      const oldBytes = recreationRequest.sourceBytes[recreationPath];
      if (oldBytes === undefined) throw new Error('request source missing');
      const oldAdoption: SourceAdoption = { filePath: recreationPath, startByte: symbol.startByte, endByte: symbol.endByte,
        content: new TextDecoder().decode(oldBytes.slice(symbol.startByte, symbol.endByte)), sourceValidation: 'verified' };
      expect(gradeTaskSource(recreation, recreationPublication, oldAdoption,
        proofFor(recreationPublication.canonicalProjectRoot, 'single'))).toBe('FALSE_FRESH');
      expect(recreation.mutationSchedule.filter(({ operation }) => operation === 'delete' || operation === 'recreate')).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  });

  it('contains duplicate same-named declarations, large TS source, and mixed-language source in the intended fixtures', async () => {
    // Given
    const fixture = await createQualityFixture(['Q10@quality-v1', 'Q11@quality-v1', 'Q14@quality-v1'], new AbortController().signal);
    try {
      const sameName = fixture.oracleCases.find((item) => item.scenarioId === 'Q10@quality-v1');
      const large = fixture.oracleCases.find((item) => item.scenarioId === 'Q11@quality-v1');
      const mixed = fixture.oracleCases.find((item) => item.scenarioId === 'Q14@quality-v1');
      if (sameName === undefined || large === undefined || mixed === undefined) throw new Error('scenario fixture missing');
      const snapshot = await captureOracleSnapshot(fixture, 'single', sameName.taskId);
      const largeSnapshot = await captureOracleSnapshot(fixture, 'single', large.taskId);
      const mixedSnapshot = await captureOracleSnapshot(fixture, 'single', mixed.taskId);
      // When / Then
      const sameNameFiles = Object.keys(snapshot.sourceBytes).filter((path) => path.includes('scope-'));
      expect(sameNameFiles).toHaveLength(2);
      expect(sameNameFiles.every((path) => new TextDecoder().decode(snapshot.sourceBytes[path]).includes('function lookup'))).toBe(true);
      expect(Object.keys(largeSnapshot.sourceBytes).some((path) => path.includes('large.ts'))).toBe(true);
      const largeSymbol = large.expectedSymbols[0];
      const largeFile = largeSnapshot.sourceBytes[large.expectedFiles[0] ?? ''];
      if (largeSymbol === undefined || largeFile === undefined) throw new Error('large declaration missing');
      expect(largeSymbol.endByte).toBeLessThan(largeFile.length);
      expect(largeSymbol.name).toBe('largeAnswer');
      expect(Object.keys(mixedSnapshot.sourceBytes).some((path) => path.endsWith('.py'))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects symlinked source entries when capturing the independent snapshot', async () => {
    // Given
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    const task = fixture.oracleCases[0];
    if (task === undefined) throw new Error('quality task missing');
    try {
      const projectRoot = fixture.roots.single;
      if (projectRoot === undefined) throw new Error('quality root missing');
      await symlink('/etc/passwd', `${projectRoot}/Q01/src/escape.ts`);
      // When / Then
      await expect(captureOracleSnapshot(fixture, 'single', task.taskId)).rejects.toThrow('quality_snapshot_symlink_rejected');
    } finally {
      await fixture.dispose();
    }
  });

  it('excludes Git, dependency, and Nexus state directories from source snapshots', async () => {
    // Given
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const projectRoot = fixture.roots.single;
      if (task === undefined || projectRoot === undefined) throw new Error('quality fixture missing');
      for (const directory of ['.git', 'node_modules/pkg', '.nexus']) {
        await mkdir(`${projectRoot}/${directory}`, { recursive: true });
        await writeFile(`${projectRoot}/${directory}/ignored.ts`, 'export function ignored() {}');
      }
      // When
      const snapshot = await captureOracleSnapshot(fixture, 'single', task.taskId);
      // Then
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.startsWith('.git/'))).toBe(false);
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.startsWith('node_modules/'))).toBe(false);
      expect(Object.keys(snapshot.sourceBytes).some((path) => path.startsWith('.nexus/'))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});
