import { describe, expect, it } from 'vitest';
import { QUALITY_BUDGETS_V1, publicTask, validateQualityCase, validateQualityCases } from '../../../benchmarks/quality/contracts.js';
import { QUALITY_CASES_V1 } from '../../../benchmarks/quality/manifest.js';
import { createQualityFixture } from '../../../benchmarks/quality/fixtures.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('quality case contracts', () => {
  it('projects only visible task fields and returns a fresh frozen object', () => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    // When
    const visible = publicTask(manifest);
    // Then
    expect(Object.keys(visible).sort()).toEqual(['initialClues', 'taskDescription']);
    expect(visible).not.toHaveProperty('taskId');
    expect(visible).not.toHaveProperty('expectedFiles');
    expect(Object.isFrozen(visible)).toBe(true);
    expect(visible).not.toBe(publicTask(manifest));
  });

  it('rejects extra public fields', () => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    const withLeak = { ...manifest, leaked: 'golden' };
    // When / Then
    expect(() => publicTask(withLeak)).toThrow();
  });

  it('accepts a versioned, role-matched manifest', () => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    // When
    const result = validateQualityCase(manifest);
    // Then
    expect(result.taskId).toBe(manifest.taskId);
  });

  it.each([
    { rootKey: 'unknown', role: 'single' },
    { role: 'single' },
    { rootKey: 'primary', role: 'single' },
    { rootKey: 'single', role: 'primary' },
  ])('rejects invalid worktree identity %j', (worktreeIdentity) => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    // When / Then
    expect(() => validateQualityCase({ ...manifest, worktreeIdentity })).toThrow();
  });

  it('keeps immutable v1 budgets and rejects manifest budget fields', () => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    // When
    const frozen = Object.isFrozen(QUALITY_BUDGETS_V1);
    // Then
    expect(frozen).toBe(true);
    expect(QUALITY_BUDGETS_V1).toEqual({ maxLogicalOperations: 12, maxCandidates: 20, maxContextBytes: 65536, maxRetries: 2 });
    expect(() => validateQualityCase({ ...manifest, budgets: { maxLogicalOperations: -1 } })).toThrow();
  });

  it('defines the canonical 17 task identifiers', () => {
    // Given / When
    const taskIds = QUALITY_CASES_V1.map((item) => item.taskId);
    // Then
    expect(taskIds).toEqual([
      'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q14',
      'Q12-primary', 'Q12-linked', 'Q13-definition', 'Q13-references', 'Q13-implementations',
    ]);
  });

  it('rejects duplicate task identifiers in a case set', () => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    // When / Then
    expect(() => validateQualityCases([manifest, manifest])).toThrow('duplicate_task_id');
  });

  it.each(['Q99@quality-v1', 'Q01'])('rejects unrecognized or unversioned scenarios %s', (scenarioId) => {
    // Given
    const manifest = QUALITY_CASES_V1[0];
    if (manifest === undefined) throw new Error('quality fixture missing');
    // When / Then
    expect(() => validateQualityCase({ ...manifest, scenarioId })).toThrow();
  });

  it('keeps Q07 and Q08 in the core set and rejects extension eligibility', () => {
    // Given
    const q07 = QUALITY_CASES_V1.find((item) => item.scenarioId === 'Q07@quality-v1');
    const q08 = QUALITY_CASES_V1.find((item) => item.scenarioId === 'Q08@quality-v1');
    if (q07 === undefined || q08 === undefined) throw new Error('Q07/Q08 fixture missing');
    // When / Then
    expect(q07.evaluationEligibility).toBe('required_core');
    expect(q08.evaluationEligibility).toBe('required_core');
    expect(() => validateQualityCase({ ...q07, evaluationEligibility: 'conditional_worktree' })).toThrow();
    expect(() => validateQualityCase({ ...q08, evaluationEligibility: 'conditional_lsp' })).toThrow();
  });

  it('matches the exact required and conditional profile matrix for every task', () => {
    // Given / When
    const actual = new Map(QUALITY_CASES_V1.map((item) => [item.taskId, item.evaluationEligibility]));
    const expected = [
      ['Q01', 'required_core'], ['Q02', 'required_core'], ['Q03', 'required_core'],
      ['Q04', 'required_core'], ['Q05', 'required_core'], ['Q06', 'required_core'],
      ['Q07', 'required_core'], ['Q08', 'required_core'], ['Q09', 'required_core'],
      ['Q10', 'required_core'], ['Q11', 'required_core'], ['Q14', 'required_core'],
      ['Q12-primary', 'conditional_worktree'], ['Q12-linked', 'conditional_worktree'],
      ['Q13-definition', 'conditional_lsp'], ['Q13-references', 'conditional_lsp'],
      ['Q13-implementations', 'conditional_lsp'],
    ] as const;
    // Then
    expect([...actual.entries()]).toEqual(expected);
  });

  it('provides parseable scenario clues and a fixture containing the retired Q03 declaration', async () => {
    expect(QUALITY_CASES_V1.every(({ initialClues }) =>
      initialClues.length > 0 &&
      initialClues.every((clue) => /^(id|file|symbol|concept|position|nav):/u.test(clue)),
    )).toBe(true);

    const fixture = await createQualityFixture(['Q03@quality-v1'], new AbortController().signal);
    try {
      const root = fixture.roots.single;
      if (root === undefined) throw new Error('Q03 root missing');
      const oldDeclaration = await readFile(join(root, 'Q03/old-name.ts'), 'utf8');
      expect(oldDeclaration).toContain('function oldAnswer');
    } finally {
      await fixture.dispose();
    }
  });

  it('requires Q12 worktree roles to match each task identity', () => {
    // Given
    const primary = QUALITY_CASES_V1.find((item) => item.taskId === 'Q12-primary');
    if (primary === undefined) throw new Error('Q12-primary fixture missing');
    // When / Then
    expect(primary.worktreeIdentity).toEqual({ rootKey: 'primary', role: 'primary' });
    expect(() => validateQualityCase({
      ...primary,
      worktreeIdentity: { rootKey: 'linked', role: 'linked' },
    })).toThrow();
  });
});
