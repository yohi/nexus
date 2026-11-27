import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPrimaryLinkedQualityFixture } from '../../benchmarks/quality/fixtures.js';
import { runQualityPair } from '../../benchmarks/quality/runner.js';
import { captureOracleSnapshot, gradeTaskSource } from '../../benchmarks/quality/oracle.js';
import type { SourceAdoption, SourceProvenance } from '../../benchmarks/quality/oracle.js';
import type { QualityCaseManifest } from '../../benchmarks/quality/contracts.js';

const signal = new AbortController().signal;

function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = isGitAvailable();

function taskFor(fixture: Awaited<ReturnType<typeof createPrimaryLinkedQualityFixture>>, taskId: string): QualityCaseManifest {
  const task = fixture.oracleCases.find((item) => item.taskId === taskId);
  if (task === undefined) throw new Error(`missing_task:${taskId}`);
  return task;
}

describe.skipIf(!gitAvailable)('Q12 primary/linked worktree boundaries', () => {
  it('creates a primary .git directory and a linked .git file', async () => {
    const fixture = await createPrimaryLinkedQualityFixture(signal);
    try {
      const primaryGitInfo = await lstat(join(fixture.roots.primary ?? '', '.git'));
      expect(primaryGitInfo.isDirectory()).toBe(true);
      const linkedGitFile = await readFile(join(fixture.roots.linked ?? '', '.git'), 'utf8');
      expect(linkedGitFile).toMatch(/^gitdir: /);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps divergent dirty source in primary and linked roots', async () => {
    const fixture = await createPrimaryLinkedQualityFixture(signal);
    try {
      const primarySource = await readFile(join(fixture.roots.primary ?? '', 'src/answer.ts'), 'utf8');
      const linkedSource = await readFile(join(fixture.roots.linked ?? '', 'src/answer.ts'), 'utf8');
      expect(primarySource).toContain('return 42');
      expect(linkedSource).toContain('return 43');
      expect(primarySource).not.toBe(linkedSource);
    } finally {
      await fixture.dispose();
    }
  });

  it('resolves the same root key in paired arms for each Q12 task and produces distinct fixture digests', async () => {
    const armFixtures: Array<Awaited<ReturnType<typeof createPrimaryLinkedQualityFixture>>> = [];
    try {
      armFixtures.push(await createPrimaryLinkedQualityFixture(signal));
      armFixtures.push(await createPrimaryLinkedQualityFixture(signal));
      const [armFixtureR, armFixtureN] = armFixtures;
      if (armFixtureR === undefined || armFixtureN === undefined) throw new Error('paired_git_fixtures_required');
      const taskFixture = { R: armFixtureR, N: armFixtureN };
      const primaryTask = taskFor(armFixtureR, 'Q12-primary');
      const linkedTask = taskFor(armFixtureR, 'Q12-linked');
      const primaryResult = await runQualityPair(primaryTask, armFixtureR, { signal, armFixtures: taskFixture });
      const linkedResult = await runQualityPair(linkedTask, armFixtureR, { signal, armFixtures: taskFixture });
      expect(primaryResult.rootKey).toBe('primary');
      expect(linkedResult.rootKey).toBe('linked');
      expect(primaryResult.outcomes.R.correctSourceReached).toBe(true);
      expect(primaryResult.outcomes.N.correctSourceReached).toBe(true);
      expect(linkedResult.outcomes.R.correctSourceReached).toBe(true);
      expect(linkedResult.outcomes.N.correctSourceReached).toBe(true);
      expect(primaryResult.fixtureDigest).toBe(primaryTask.sourceSnapshotDigest);
      expect(linkedResult.fixtureDigest).toBe(linkedTask.sourceSnapshotDigest);
      for (const armFixture of armFixtures) {
        const primaryRoot = armFixture.roots.primary ?? '';
        const linkedRoot = armFixture.roots.linked ?? '';
        expect((await lstat(join(primaryRoot, '.git'))).isDirectory()).toBe(true);
        expect(await readFile(join(linkedRoot, '.git'), 'utf8')).toMatch(/^gitdir: /);
        expect(await readFile(join(linkedRoot, 'src/answer.ts'), 'utf8')).toContain('return 43');
        expect(taskFor(armFixture, 'Q12-primary').sourceSnapshotDigest).toBe(primaryResult.fixtureDigest);
        expect(taskFor(armFixture, 'Q12-linked').sourceSnapshotDigest).toBe(linkedResult.fixtureDigest);
      }
      expect(primaryResult.fixtureDigest).not.toBe(linkedResult.fixtureDigest);
    } finally {
      await Promise.all(armFixtures.map((fixture) => fixture.dispose()));
    }
  });

  it('rejects a publication captured from the wrong root for the task', async () => {
    const fixture = await createPrimaryLinkedQualityFixture(signal);
    try {
      const primaryTask = taskFor(fixture, 'Q12-primary');
      const linkedSnapshot = await captureOracleSnapshot(fixture, 'linked', 'Q12-linked');
      const adoption: SourceAdoption = {
        filePath: 'src/answer.ts',
        startByte: primaryTask.expectedSymbols[0]?.startByte ?? 0,
        endByte: primaryTask.expectedSymbols[0]?.endByte ?? 0,
        content: 'export function answer(): number { return 42; }\n',
        sourceValidation: 'verified',
      };
      const wrongProvenance: SourceProvenance = {
        observedSourceRootKey: 'linked',
        canonicalSourceRoot: fixture.roots.linked ?? '',
        sourceRootProofDigest: 'irrelevant',
      };
      expect(gradeTaskSource(primaryTask, linkedSnapshot, adoption, wrongProvenance)).toBe('WRONG_SOURCE');
    } finally {
      await fixture.dispose();
    }
  });

  it('does not score a same-hash source as CORRECT_CURRENT without valid source provenance', async () => {
    const fixture = await createPrimaryLinkedQualityFixture(signal);
    try {
      const primaryTask = taskFor(fixture, 'Q12-primary');
      const primarySnapshot = await captureOracleSnapshot(fixture, 'primary', 'Q12-primary');
      const adoption: SourceAdoption = {
        filePath: 'src/answer.ts',
        startByte: primaryTask.expectedSymbols[0]?.startByte ?? 0,
        endByte: primaryTask.expectedSymbols[0]?.endByte ?? 0,
        content: 'export function answer(): number { return 42; }\n',
        sourceValidation: 'verified',
      };
      const invalidProvenance: SourceProvenance = {
        observedSourceRootKey: null,
        canonicalSourceRoot: null,
        sourceRootProofDigest: null,
      };
      expect(gradeTaskSource(primaryTask, primarySnapshot, adoption, invalidProvenance)).not.toBe('CORRECT_CURRENT');
    } finally {
      await fixture.dispose();
    }
  });
});
