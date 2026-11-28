import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQualityFixture, qualityRuntimeIndexSeed, type OwnedQualityFixture } from '../../../tests/benchmarks/quality/fixtures.js';
import type { QualityCaseManifest } from '../../../tests/benchmarks/quality/contracts.js';
import { collectQualityRouteCoverage, createNexusAdapterForRoot, runQualityPair } from '../../../tests/benchmarks/quality/runner.js';

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
    expect(content).toContain(`function ${symbolName}`);
    return {
      ...baseTask,
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

    const projectRoot = fixture.roots.single;
    const expectedSymbol = task.expectedSymbols[0];
    if (projectRoot === undefined || expectedSymbol === undefined) throw new Error('Q01 golden missing');
    const sourceBytes = await readFile(join(projectRoot, expectedSymbol.filePath));
    expect(sourceBytes[sourceBytes.length - 1]).toBe(0x0a);
    const goldenBytes = sourceBytes.subarray(expectedSymbol.startByte, expectedSymbol.endByte);
    const goldenContent = goldenBytes.toString('utf8');
    for (const arm of ['R', 'N'] as const) {
      expect(result.outcomes[arm].policy?.adoption).toMatchObject({
        filePath: expectedSymbol.filePath,
        startByte: expectedSymbol.startByte,
        endByte: expectedSymbol.endByte,
        content: goldenContent,
        sourceValidation: 'verified',
      });
    }

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
    expect(route.status).toBe('COVERED');

    for (const probe of route.probes) {
      expect(probe.probeId).toMatch(/^unit-q01|^Q01/);
      expect(probe.taskId).toBe(task.taskId);
      expect(probe.traceSequence).toBeGreaterThan(0);
    }
    expect(route.probeTrace.filter(({ state }) => state !== 'SETUP').map(({ sequence }) => sequence)).toEqual(
      route.probes.map(({ traceSequence }) => traceSequence),
    );
  }, 60_000);

  it('marks a route incomplete when expected discovery targets are absent', async () => {
    const task = await makeTask();
    const incompleteTask = { ...task, expectedFiles: [], expectedSymbols: [] };
    const [route] = await collectQualityRouteCoverage(
      incompleteTask,
      fixture,
      { signal: new AbortController().signal },
    );

    expect(route?.status).toBe('INCOMPLETE');
    expect(route?.probes.some(({ status }) => status === 'INCOMPLETE')).toBe(true);
  });

  it.each(['Q07@quality-v1', 'Q08@quality-v1'] as const)(
    'exercises paired retrieval against scenario-specific index state for %s',
    async (scenarioId) => {
      const scenarioFixture = await createQualityFixture([scenarioId], new AbortController().signal);
      try {
        const task = scenarioFixture.oracleCases[0];
        if (task === undefined) throw new Error(`${scenarioId} fixture missing`);

        if (scenarioId === 'Q07@quality-v1') {
          const root = scenarioFixture.roots.single;
          if (root === undefined) throw new Error('Q07 fixture root missing');
          const adapter = await createNexusAdapterForRoot(
            root,
            undefined,
            qualityRuntimeIndexSeed(scenarioFixture, task.taskId),
          );
          try {
            const observation = await adapter.invoke(
              'hybrid_search',
              { query: 'answer', topK: 20 },
              new AbortController().signal,
              { traceSequence: 1 },
            );
            expect(observation.status).toBe('ok');
            expect(observation.results.some(({ preview }) => preview?.includes('return 41'))).toBe(true);
            expect(observation.results.some(({ preview }) => preview?.includes('return 42'))).toBe(true);
          } finally {
            await adapter.close();
          }
        }

        const result = await runQualityPair(task, scenarioFixture, { signal: new AbortController().signal });
        const nTrace = result.outcomes.N.policy?.trace ?? [];

        expect(nTrace.some(({ tool }) => tool === 'hybrid_search')).toBe(true);
        if (scenarioId === 'Q07@quality-v1') {
          expect(task.mutationSchedule).toHaveLength(0);
          expect(result.outcomes.N.policy?.trace.some(({ resultDigest }) => resultDigest !== null)).toBe(true);
        } else {
          expect(task.mutationSchedule).toEqual(expect.arrayContaining([
            expect.objectContaining({ phase: 'during_request', operation: 'delete' }),
            expect.objectContaining({ phase: 'before_publication', operation: 'recreate' }),
          ]));
          // This policy-only baseline does not claim race coverage; the structured Contract Probe
          // exercises the mutation independently.
          expect(result.armFixtureDigests.R).toBe(result.armFixtureDigests.N);
          expect(result.outcomes.R.observation).toBe('WRONG_SOURCE');
          expect(result.outcomes.N.observation).toBe('WRONG_SOURCE');
          const request = result.outcomes.R.policy?.trace[0]?.requestSnapshotDigest;
          const publication = result.outcomes.R.adoptionHistory[0]?.publicationSnapshotDigest;
          expect(request).toMatch(/^[a-f0-9]{64}$/);
          expect(publication).toMatch(/^[a-f0-9]{64}$/);
          expect(request).toBe(publication);
        }
      } finally {
        await scenarioFixture.dispose();
      }
    },
    60_000,
  );

  it('records stale adoption across the Q06 delete/recreate race', async () => {
    const scenarioFixture = await createQualityFixture(['Q06@quality-v1'], new AbortController().signal);
    try {
      const task = scenarioFixture.oracleCases[0];
      if (task === undefined) throw new Error('Q06 fixture missing');
      const result = await runQualityPair(task, scenarioFixture, { signal: new AbortController().signal });

      for (const arm of ['R', 'N'] as const) {
        const trace = result.outcomes[arm].policy?.trace[0];
        const adoption = result.outcomes[arm].adoptionHistory[0];
        expect(result.outcomes[arm].observation).toBe('FALSE_FRESH');
        expect(trace?.requestSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(adoption?.publicationSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(trace?.requestSnapshotDigest).not.toBe(adoption?.publicationSnapshotDigest);
      }
    } finally {
      await scenarioFixture.dispose();
    }
  }, 60_000);
});
