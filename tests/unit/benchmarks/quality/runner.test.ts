import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  applyQualityMutation,
  createQualityFixture,
} from '../../../../tests/benchmarks/quality/fixtures.js';
import { canonicalJson } from '../../../../tests/benchmarks/quality/canonical-json.js';
import * as oracle from '../../../../tests/benchmarks/quality/oracle.js';
import {
  collectQualityRouteCoverage,
  createNexusAdapterForRoot,
  getLineSubmatches,
  isProbeCovered,
  LocalGrepEngine,
  normalizeProbeArgs,
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

  it('does not count oracle-matching source as current when the fixture has changed', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const filePath = task?.expectedFiles[0];
      const expected = task?.expectedSymbols[0];
      if (task === undefined || root === undefined || filePath === undefined || expected === undefined) {
        throw new Error('Q01 fixture missing');
      }
      const oldContent = 'export function answer(): number { return 42; }';
      await writeFile(join(root, filePath), 'export function answer(): number { return 99; }\n');
      const currentSnapshot = await oracle.captureOracleSnapshot(fixture, 'single', task.taskId);
      const observation = {
        status: 'ok',
        results: [],
        exposedBytes: Buffer.byteLength(oldContent),
        sourceAdoptions: [{
          filePath,
          startByte: expected.startByte,
          endByte: expected.endByte,
          content: oldContent,
          sourceValidation: 'verified',
        }],
        rawDigest: 'stale-but-oracle-matching',
        normalizedPublicArgs: {},
      } as const;
      const probe = {
        probeId: 'Q01-stale-but-oracle-matching-source',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'get_context',
        expectedAction: 'current_source',
      } as const;

      expect(isProbeCovered(probe, task, observation, currentSnapshot)).toBe(false);
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

  it.each([
    ['Q03@quality-v1', 'get_symbol_source', 'stale_identity', 'SYMBOL_RETIRED'],
    ['Q14@quality-v1', 'get_definition', 'unavailable', 'LSP_NOT_CONFIGURED'],
  ] as const)(
    'requires the expected refusal reason for %s route coverage',
    async (scenarioId, tool, status, expectedReason) => {
      const fixture = await createQualityFixture([scenarioId], new AbortController().signal);
      try {
        const task = fixture.oracleCases[0];
        if (task === undefined) throw new Error(`${scenarioId} fixture missing`);
        const probe = {
          probeId: `${task.taskId}-safe-refusal`,
          taskId: task.taskId,
          rootKey: task.worktreeIdentity.rootKey,
          tool,
          expectedAction: 'safe_refusal',
        } as const;
        const observation = (reasonCode?: string) => ({
          status,
          results: [],
          exposedBytes: 0,
          sourceAdoptions: [],
          rawDigest: 'safe-refusal',
          normalizedPublicArgs: {},
          ...(reasonCode === undefined ? {} : { reasonCode }),
        });

        expect(isProbeCovered(probe, task, observation())).toBe(false);
        expect(isProbeCovered(probe, task, observation('UNEXPECTED_REASON'))).toBe(false);
        expect(isProbeCovered(probe, task, observation(expectedReason))).toBe(true);
        expect(isProbeCovered(
          probe,
          { ...task, expectedRefusalConditions: [] },
          observation(expectedReason),
        )).toBe(false);
      } finally {
        await fixture.dispose();
      }
    },
  );

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
      expect(task.expectedRefusalConditions).toEqual(['SYMBOL_RETIRED']);

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

  it('covers Q14 navigation probes only for the configured-LSP refusal reason', async () => {
    const fixture = await createQualityFixture(['Q14@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q14 fixture missing');
      expect(task.expectedRefusalConditions).toEqual(['LSP_NOT_CONFIGURED']);

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });

      expect(route?.status).toBe('COVERED');
      expect(route?.probes.filter(({ expectedAction }) => expectedAction === 'safe_refusal')).toEqual([
        expect.objectContaining({
          observedStatus: 'unavailable',
          reasonCode: 'LSP_NOT_CONFIGURED',
          status: 'COVERED',
        }),
        expect.objectContaining({
          observedStatus: 'unavailable',
          reasonCode: 'LSP_NOT_CONFIGURED',
          status: 'COVERED',
        }),
        expect.objectContaining({
          observedStatus: 'unavailable',
          reasonCode: 'LSP_NOT_CONFIGURED',
          status: 'COVERED',
        }),
      ]);
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

  it('returns not_found for outline and symbol requests after a fixture file is deleted', async () => {
    const fixture = await createQualityFixture(['Q05@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const filePath = task?.expectedFiles[0];
      const symbol = task?.expectedSymbols[0];
      if (task === undefined || root === undefined || filePath === undefined || symbol === undefined) {
        throw new Error('Q05 fixture missing');
      }
      const adapter = await createNexusAdapterForRoot(root, task);
      await applyQualityMutation(fixture, task.taskId, 'before_publication');

      const outline = await adapter.invoke(
        'get_file_outline',
        { filePath },
        new AbortController().signal,
        { traceSequence: 1 },
      );
      const source = await adapter.invoke(
        'get_symbol_source',
        { symbolId: symbol.name },
        new AbortController().signal,
        { traceSequence: 2 },
      );

      expect(outline).toMatchObject({ status: 'not_found', reasonCode: 'FILE_NOT_FOUND' });
      expect(source).toMatchObject({ status: 'not_found', reasonCode: 'SYMBOL_NOT_FOUND' });
    } finally {
      await fixture.dispose();
    }
  });

  it('omits undefined keys from fallback probe arguments', () => {
    const normalizedArgs = normalizeProbeArgs('grep_search', { maxResults: 20 });

    expect(Object.keys(normalizedArgs)).toEqual(['maxResults']);
    expect(normalizedArgs.maxResults).toBe(20);
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

  it('excludes an observer publication that completes after request abort', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    let releaseSnapshot: (() => void) | undefined;
    let announceSnapshotStart: (() => void) | undefined;
    let delayNextSnapshot = true;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const snapshotStarted = new Promise<void>((resolve) => { announceSnapshotStart = resolve; });
    const originalCapture = oracle.captureOracleSnapshot;
    const captureSpy = vi.spyOn(oracle, 'captureOracleSnapshot').mockImplementation(async (current, rootKey, taskId) => {
      if (delayNextSnapshot) {
        delayNextSnapshot = false;
        announceSnapshotStart?.();
        await snapshotGate;
      }
      return originalCapture(current, rootKey, taskId);
    });

    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');
      const controller = new AbortController();
      let returned = false;
      const resultPromise = runQualityPair(task, fixture, { signal: controller.signal }).then((result) => {
        returned = true;
        return result;
      });

      await snapshotStarted;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);

      releaseSnapshot?.();
      const result = await resultPromise;

      expect(result.outcomes.R.policy?.adoptionEvents).toHaveLength(1);
      expect(result.outcomes.R.adoptionHistory[0]?.publicationSnapshotDigest).toBeNull();
      expect(result.outcomes.R.observation).toBe('INCONCLUSIVE');
    } finally {
      releaseSnapshot?.();
      captureSpy.mockRestore();
      await fixture.dispose();
    }
  });

  it('returns not_run for both arms when cancellation precedes fixture setup', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');

      const result = await runQualityPair(task, fixture, { signal: AbortSignal.abort() });

      expect(result.outcomes.R).toMatchObject({ executionStatus: 'not_run', reasonCode: 'REQUEST_CANCELLED' });
      expect(result.outcomes.N).toMatchObject({ executionStatus: 'not_run', reasonCode: 'REQUEST_CANCELLED' });
    } finally {
      await fixture.dispose();
    }
  });

  it('grades against the generated task when the caller passes a public manifest entry', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const generatedTask = fixture.oracleCases[0];
      if (generatedTask === undefined) throw new Error('Q01 fixture missing');
      const publicManifest = {
        ...generatedTask,
        expectedFiles: [],
        expectedSymbols: [],
        expectedSourceHashes: {},
      };

      const result = await runQualityPair(publicManifest, fixture, { signal: new AbortController().signal });

      expect(result.discovery.N).toMatchObject({
        eligibleFileTask: true,
        eligibleSymbolTask: true,
        fileFound: true,
        symbolFound: true,
        hitsAtK: 1,
      });
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
