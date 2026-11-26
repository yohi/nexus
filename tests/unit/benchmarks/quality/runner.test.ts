import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  applyQualityMutation,
  createQualityFixture,
} from '../../../../tests/benchmarks/quality/fixtures.js';
import { canonicalJson } from '../../../../tests/benchmarks/quality/canonical-json.js';
import {
  collectQualityRouteCoverage,
  createNexusAdapterForRoot,
  getLineSubmatches,
  isProbeCovered,
  LocalGrepEngine,
  runQualityPair,
} from '../../../../tests/benchmarks/quality/runner.js';

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

describe('quality route coverage', () => {
  it('returns immediately for an empty grep query without traversing the root', async () => {
    const engine = new LocalGrepEngine();

    await expect(engine.search({ query: '', cwd: join(tmpdir(), 'missing-quality-root') })).resolves.toEqual([]);
    await expect(engine.search({ query: 'answer', cwd: join(tmpdir(), 'missing-quality-root') })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects empty line-search needles while preserving non-empty matching', () => {
    expect(getLineSubmatches('', 'answer')).toEqual([]);
    expect(getLineSubmatches('wer', 'answer')).toEqual([
      { start: 3, end: 6, match: 'wer' },
    ]);
  });

  it('does not count empty discovery results as probe coverage', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');
      const probe = {
        probeId: 'Q01-empty-discovery',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'grep_search',
        expectedAction: 'discovery_current',
      } as const;
      const observation = {
        status: 'ok',
        results: [],
        exposedBytes: 0,
        sourceAdoptions: [],
        rawDigest: 'empty',
        normalizedPublicArgs: {},
      } as const;

      expect(isProbeCovered(probe, task, observation)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not count verified but stale source bytes as current-source coverage', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');
      const probe = {
        probeId: 'Q01-stale-source',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'get_context',
        expectedAction: 'current_source',
      } as const;
      const filePath = task.expectedFiles[0];
      if (filePath === undefined) throw new Error('Q01 expected file missing');
      const observation = {
        status: 'ok',
        results: [],
        exposedBytes: 10,
        sourceAdoptions: [{
          filePath,
          startByte: 0,
          endByte: 10,
          content: 'stale data',
          sourceValidation: 'verified',
        }],
        rawDigest: 'stale',
        normalizedPublicArgs: {},
      } as const;

      expect(isProbeCovered(probe, task, observation)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it('does not count a refusal that exposed source as safe-refusal coverage', async () => {
    const fixture = await createQualityFixture(['Q03@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q03 fixture missing');
      const probe = {
        probeId: 'Q03-leaking-refusal',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'get_symbol_source',
        expectedAction: 'safe_refusal',
      } as const;
      const observation = {
        status: 'stale_identity',
        results: [],
        exposedBytes: Buffer.byteLength('retired source'),
        sourceAdoptions: [],
        rawDigest: 'refusal-with-source',
        normalizedPublicArgs: {},
        reasonCode: 'SYMBOL_RETIRED',
      } as const;

      expect(isProbeCovered(probe, task, observation)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it('records a trace for each invoked Q01 probe with its sequence and normalized public arguments', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });

      expect(route?.status).toBe('COVERED');
      expect(route?.probes.map(({ traceSequence }) => traceSequence)).toEqual([1, 2]);
      expect(route?.probeTrace.map(({ sequence }) => sequence)).toEqual([1, 2]);
      expect(route?.probeTrace.map(({ resultStatus }) => resultStatus)).toEqual(
        route?.probes.map(({ observedStatus }) => observedStatus),
      );
      expect(route?.probes[1]?.publicArgsDigest).toBe(
        sha256(canonicalJson({ maxResults: 20 })),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['Q07@quality-v1', 'Q08@quality-v1', 'Q10@quality-v1'])(
    'covers fixture-backed search/source routes for %s',
    async (scenarioId) => {
      const fixture = await createQualityFixture([scenarioId], new AbortController().signal);
      try {
        const task = fixture.oracleCases[0];
        if (task === undefined) throw new Error(`${scenarioId} fixture missing`);

        const [route] = await collectQualityRouteCoverage(task, fixture, {
          signal: new AbortController().signal,
        });

        expect(route?.status).toBe('COVERED');
        expect(route?.probes.every(({ status }) => status === 'COVERED')).toBe(true);
        expect(route?.probeTrace).toHaveLength(route?.probes.length ?? 0);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it('rejects Q03 old identity and reads the renamed declaration with its current identity', async () => {
    const fixture = await createQualityFixture(['Q03@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q03 fixture missing');

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });

      const oldIdentity = route?.probes.find(({ expectedAction }) => expectedAction === 'safe_refusal');
      const currentIdentity = route?.probes.find(({ expectedAction }) => expectedAction === 'current_source');
      expect(oldIdentity?.observedStatus).toBe('stale_identity');
      expect(oldIdentity?.reasonCode).toBe('SYMBOL_RETIRED');
      expect(oldIdentity?.status).toBe('COVERED');
      expect(currentIdentity?.observedStatus).toBe('ok');
      expect(currentIdentity?.status).toBe('COVERED');
      expect(route?.status).toBe('COVERED');
    } finally {
      await fixture.dispose();
    }
  });

  it('retrieves Q10 declarations from the real file outline handler', async () => {
    const fixture = await createQualityFixture(['Q10@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      if (task === undefined || root === undefined) throw new Error('Q10 fixture missing');
      const adapter = await createNexusAdapterForRoot(root, task);
      const paths = [task.expectedFiles[0], 'Q10/scope-b.ts'];
      for (const [index, filePath] of paths.entries()) {
        if (filePath === undefined) throw new Error('Q10 outline path missing');
        const observation = await adapter.invoke(
          'get_file_outline',
          { filePath },
          new AbortController().signal,
          { traceSequence: index + 1 },
        );
        expect(observation.status).toBe('ok');
        expect(observation.results.some(({ filePath: resultPath, preview }) =>
          resultPath === filePath && preview === 'lookup')).toBe(true);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('does not invoke or trace any probe when already aborted', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');
      const controller = new AbortController();
      controller.abort();

      const [route] = await collectQualityRouteCoverage(task, fixture, { signal: controller.signal });

      expect(route?.probes.every(({ status }) => status === 'BLOCKED')).toBe(true);
      expect(route?.probes.every(({ traceSequence }) => traceSequence === null)).toBe(true);
      expect(route?.probeTrace).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('runs both Q06 arms from isolated fixtures and publishes the recreated value', async () => {
    const fixture = await createQualityFixture(['Q06@quality-v1'], new AbortController().signal);
    try {
      const generatedTask = fixture.oracleCases[0];
      if (generatedTask === undefined) throw new Error('Q06 fixture missing');

      const result = await runQualityPair(generatedTask, fixture, { signal: new AbortController().signal });

      expect(result.outcomes.R.observation).toBe('FALSE_FRESH');
      expect(result.outcomes.N.observation).toBe('FALSE_FRESH');
      expect(result.outcomes.R.policy?.adoption?.content).toContain('return 42');
      expect(result.outcomes.N.policy?.adoption?.content).toContain('return 42');
      expect(result.outcomes.R.adoptionHistory[0]?.publicationSnapshotDigest).not.toBeNull();
      expect(result.outcomes.N.adoptionHistory[0]?.publicationSnapshotDigest).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps Q06 fixture mutations isolated and recreates the expected value 43', async () => {
    const signal = new AbortController().signal;
    const first = await createQualityFixture(['Q06@quality-v1'], signal);
    const second = await createQualityFixture(['Q06@quality-v1'], signal);
    try {
      const firstTask = first.oracleCases[0];
      const secondTask = second.oracleCases[0];
      if (firstTask === undefined || secondTask === undefined) throw new Error('Q06 fixture missing');
      const firstPath = join(first.roots.single ?? '', firstTask.expectedFiles[0] ?? '');
      const secondPath = join(second.roots.single ?? '', secondTask.expectedFiles[0] ?? '');

      expect(firstPath).not.toBe(secondPath);
      await applyQualityMutation(first, firstTask.taskId, 'during_request');
      await expect(readFile(firstPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(secondPath, 'utf8')).toContain('return 42');
      await applyQualityMutation(first, firstTask.taskId, 'before_publication');

      expect(await readFile(firstPath, 'utf8')).toContain('return 43');
      expect(await readFile(secondPath, 'utf8')).toContain('return 42');
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });
});
