import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQualityFixture, type OwnedQualityFixture } from '../../../tests/benchmarks/quality/fixtures.js';
import type { QualityCaseManifest } from '../../../tests/benchmarks/quality/contracts.js';
import { collectQualityRouteCoverage, runQualityPair } from '../../../tests/benchmarks/quality/runner.js';

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

describe('quality benchmark core integration', () => {
  let fixture: OwnedQualityFixture;

  beforeAll(async () => {
    const controller = new AbortController();
    fixture = await createQualityFixture(['Q01@quality-v1'], controller.signal);
  }, 30_000);

  afterAll(async () => {
    await fixture.dispose();
  }, 30_000);

  const makeTask = async (): Promise<QualityCaseManifest> => {
    const baseTask = fixture.oracleCases[0];
    if (baseTask === undefined) throw new Error('fixture task missing');
    const projectRoot = fixture.roots.single;
    if (projectRoot === undefined) throw new Error('single root missing');
    const expectedFile = baseTask.expectedFiles[0];
    const symbolName = baseTask.expectedSymbols[0]?.name ?? 'answer';
    if (expectedFile === undefined) throw new Error('expected file missing');
    const content = await readFile(join(projectRoot, expectedFile), 'utf8');
    const fileBytes = new TextEncoder().encode(content);
    const wholeHash = sha256(fileBytes);
    return {
      ...baseTask,
      initialClues: ['id:answer'],
      expectedSymbols: [
        { filePath: expectedFile, name: symbolName, startByte: 0, endByte: fileBytes.length },
      ],
      expectedSourceHashes: { [expectedFile]: wholeHash },
      expectedLocations: [{ filePath: expectedFile, line: 1, character: 0 }],
    };
  };

  it('runs a paired quality benchmark and reaches the correct source in both arms', async () => {
    const task = await makeTask();
    const result = await runQualityPair(task, fixture, { signal: new AbortController().signal });

    expect(result.taskId).toBe(task.taskId);
    expect(result.profile).toBe('quality-core-v1');
    expect(result.rootKey).toBe('single');
    expect(result.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.policyVersion).toBe('quality-policy-v1');

    expect(result.outcomes.R.executionStatus).toBe('executed');
    expect(result.outcomes.N.executionStatus).toBe('executed');
    expect(result.outcomes.R.correctSourceReached).toBe(true);
    expect(result.outcomes.N.correctSourceReached).toBe(true);
    expect(result.outcomes.R.wrongSourceAdopted).toBe(false);
    expect(result.outcomes.N.wrongSourceAdopted).toBe(false);
    expect(result.outcomes.R.observation).toBe('CORRECT_CURRENT');
    expect(result.outcomes.N.observation).toBe('CORRECT_CURRENT');

    expect(result.baselineRgExecution.status).toBe('INVOKED_VERIFIED');
    expect(result.baselineRgExecution.baselineExecutionContractDigest).not.toBeNull();
    expect(result.discovery.R.evidenceStatus).toBe('EVALUATED');
    expect(result.discovery.N.evidenceStatus).toBe('EVALUATED');
  }, 60_000);

  it('collects route coverage for a required scenario', async () => {
    const task = await makeTask();
    const coverage = await collectQualityRouteCoverage(task, fixture, { signal: new AbortController().signal });

    expect(coverage).toHaveLength(1);
    const route = coverage[0];
    if (route === undefined) throw new Error('route coverage missing');
    expect(route.taskId).toBe(task.taskId);
    expect(route.scenarioId).toBe(task.scenarioId);
    expect(route.rootKey).toBe('single');
    expect(route.requiredProbeIds.length).toBeGreaterThan(0);
    expect(route.probes).toHaveLength(route.requiredProbeIds.length);
    expect(route.setupProofDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(['COVERED', 'INCOMPLETE']).toContain(route.status);

    for (const probe of route.probes) {
      expect(probe.probeId).toMatch(/^unit-q01|^Q01/);
      expect(probe.taskId).toBe(task.taskId);
      expect(probe.traceSequence).toBeGreaterThan(0);
    }
  }, 60_000);
});
