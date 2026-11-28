import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  applyQualityMutation,
  createQualityFixture,
} from '../../../../tests/benchmarks/quality/fixtures.js';
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

  it('requires the Q07 discovery candidate to contain the current source, while accepting it among stale candidates', async () => {
    const fixture = await createQualityFixture(['Q07@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q07 fixture missing');
      const probe = {
        probeId: 'Q07-current-source-candidate',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'hybrid_search',
        expectedAction: 'discovery_current',
      } as const;
      const observation = (previews: string[]) => ({
        status: 'ok' as const,
        results: previews.map((preview, index) => ({
          filePath: task.expectedFiles[0]!,
          symbolId: 'answer',
          rank: index + 1,
          preview,
        })),
        exposedBytes: 0,
        sourceAdoptions: [],
        rawDigest: 'discovery',
        normalizedPublicArgs: {},
      });

      expect(isProbeCovered(probe, task, observation(['export function answer() { return 41; }']))).toBe(false);
      expect(isProbeCovered(probe, task, observation([
        'export function answer() { return 41; }',
        'export function answer() { return 42; }',
      ]))).toBe(true);
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

  it('requires current-source coverage to use the exact range accepted by the Oracle', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const filePath = task?.expectedFiles[0];
      if (task === undefined || root === undefined || filePath === undefined) {
        throw new Error('Q01 fixture missing');
      }
      const content = await readFile(join(root, filePath), 'utf8');
      const sourceAdoptions = [{
        filePath,
        startByte: 0,
        endByte: Buffer.byteLength(content),
        content,
        sourceValidation: 'verified' as const,
      }];
      const snapshot = await oracle.captureOracleSnapshot(fixture, 'single', task.taskId);
      const probe = {
        probeId: 'Q01-whole-file-source',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'get_symbol_source',
        expectedAction: 'current_source',
      } as const;
      const observation = {
        status: 'ok' as const,
        results: [],
        exposedBytes: Buffer.byteLength(content),
        sourceAdoptions,
        rawDigest: 'whole-file-source',
        normalizedPublicArgs: {},
      };
      const adapter = {
        arm: 'N' as const,
        invoke: (tool: string) => Promise.resolve(tool === 'get_symbol_source' ? observation : {
          status: 'ok' as const,
          results: [],
          exposedBytes: 0,
          sourceAdoptions: [],
          rawDigest: 'empty',
          normalizedPublicArgs: {},
        }),
      };

      expect(isProbeCovered(probe, task, observation, snapshot)).toBe(false);
      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
        adapter,
      });
      expect(route?.probes.find(({ expectedAction }) => expectedAction === 'current_source')).toMatchObject({
        oracleVerdict: 'WRONG_SOURCE',
        status: 'INCOMPLETE',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the same current-source adoption for the Oracle verdict and Gate 1 coverage', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const filePath = task?.expectedFiles[0];
      const expectedRange = task?.expectedSymbols[0];
      if (task === undefined || root === undefined || filePath === undefined || expectedRange === undefined) {
        throw new Error('Q01 fixture missing');
      }
      const currentFile = new TextEncoder().encode(await readFile(join(root, filePath), 'utf8'));
      const currentSource = new TextDecoder().decode(currentFile.slice(expectedRange.startByte, expectedRange.endByte));
      const staleSource = currentSource.replace('return 42', 'return 41');
      const adoption = (content: string) => ({
        filePath,
        startByte: expectedRange.startByte,
        endByte: expectedRange.endByte,
        content,
        sourceValidation: 'verified' as const,
      });
      const misplacedSource = new TextDecoder().decode(currentFile.slice(1, expectedRange.endByte + 1));
      const misplacedAdoption = {
        filePath,
        startByte: 1,
        endByte: expectedRange.endByte + 1,
        content: misplacedSource,
        sourceValidation: 'verified' as const,
      };
      const collect = async (sourceAdoptions: readonly ReturnType<typeof adoption>[]) => {
        const adapter = {
          arm: 'N' as const,
          invoke(tool: string) {
            if (tool === 'get_symbol_source') {
              return Promise.resolve({
                status: 'ok' as const,
                results: [],
                exposedBytes: sourceAdoptions.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0),
                sourceAdoptions,
                rawDigest: 'multi-adoption',
                normalizedPublicArgs: {},
              });
            }
            return Promise.resolve({
              status: 'ok' as const,
              results: [],
              exposedBytes: 0,
              sourceAdoptions: [],
              rawDigest: 'empty',
              normalizedPublicArgs: {},
            });
          },
        };
        return collectQualityRouteCoverage(task, fixture, {
          signal: new AbortController().signal,
          adapter,
        });
      };
      const [mixedRoute] = await collect([adoption(staleSource), adoption(currentSource)]);
      const [wrongRoute] = await collect([misplacedAdoption]);
      const mixedProbe = mixedRoute?.probes.find(({ expectedAction }) => expectedAction === 'current_source');
      const wrongProbe = wrongRoute?.probes.find(({ expectedAction }) => expectedAction === 'current_source');

      expect(mixedProbe).toMatchObject({ oracleVerdict: 'FALSE_FRESH', status: 'INCOMPLETE' });
      expect(wrongProbe).toMatchObject({ oracleVerdict: 'WRONG_SOURCE', status: 'INCOMPLETE' });
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

  it('does not cover navigation with a non-oracle location set', async () => {
    const fixture = await createQualityFixture(['Q13@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases.find(({ taskId }) => taskId === 'Q13-definition');
      const expected = task?.expectedLocations[0];
      if (task === undefined || expected === undefined) throw new Error('Q13 fixture missing');
      const probe = {
        probeId: 'Q13-definition',
        taskId: task.taskId,
        rootKey: task.worktreeIdentity.rootKey,
        tool: 'get_definition',
        expectedAction: 'navigation_locations',
      } as const;
      const observation = {
        status: 'ok',
        results: [],
        exposedBytes: 0,
        sourceAdoptions: [],
        rawDigest: 'wrong-location',
        normalizedPublicArgs: {},
        navigation: {
          capability: 'supported',
          locations: [{
            filePath: 'other.ts',
            startLine: expected.line,
            startCharacter: expected.character,
            endLine: expected.line,
            endCharacter: expected.character + 6,
          }],
          truncated: false,
          sourceValidation: 'verified',
        },
      } as const;

      expect(isProbeCovered(probe, task, observation)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ['Q03@quality-v1', 'get_symbol_source', 'stale', 'SYMBOL_RETIRED'],
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
      expect(route?.probes.map(({ traceSequence }) => traceSequence)).toEqual([2, 3]);
      expect(route?.probeTrace.filter(({ state }) => state !== 'SETUP').map(({ sequence }) => sequence)).toEqual([2, 3]);
      const contractTrace = route?.probeTrace.filter(({ state }) => state !== 'SETUP') ?? [];
      expect(contractTrace.map(({ argsDigest }) => argsDigest)).toEqual(
        route?.probes.map(({ publicArgsDigest }) => publicArgsDigest),
      );
      expect(contractTrace.map(({ resultStatus }) => resultStatus)).toEqual(
        route?.probes.map(({ observedStatus }) => observedStatus),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ['Q02@quality-v1', ['Q02-index_status', 'Q02-dirty-source'], 'COVERED', 'CORRECT_CURRENT'],
    ['Q06@quality-v1', ['Q06-index_status', 'Q06-recreated-source'], 'INCOMPLETE', 'FALSE_FRESH'],
    ['Q11@quality-v1', ['Q11-index_status', 'Q11-declaration-source'], 'COVERED', 'CORRECT_CURRENT'],
  ] as const)(
    'uses the frozen get_symbol_source route for %s',
    async (scenarioId, expectedProbeIds, expectedCoverage, expectedVerdict) => {
    const fixture = await createQualityFixture([scenarioId], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error(`${scenarioId} fixture missing`);
      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });
      expect(route?.status).toBe(expectedCoverage);
      expect(route?.probes.map(({ probeId }) => probeId)).toEqual(expectedProbeIds);
      const sourceProbe = route?.probes.find(({ expectedAction }) => expectedAction === 'current_source');
      expect(sourceProbe?.tool).toBe('get_symbol_source');
      expect(sourceProbe?.observedStatus).toBe('ok');
      expect(sourceProbe?.oracleVerdict).toBe(expectedVerdict);
      const sourceTrace = route?.probeTrace.find(({ sequence }) => sequence === sourceProbe?.traceSequence);
      expect(sourceTrace?.normalizedPublicArgs.symbolId).not.toBe(task.expectedSymbols[0]?.name);
    } finally {
      await fixture.dispose();
    }
    },
  );

  it.each([
    ['Q07@quality-v1', 'INCOMPLETE', ['Q07-index_status', 'Q07-hybrid']],
    ['Q08@quality-v1', 'COVERED', ['Q08-index_status', 'Q08-generation-race']],
    ['Q10@quality-v1', 'COVERED', ['Q10-index_status', 'Q10-outline', 'Q10-scoped-source']],
  ] as const)(
    'records fixture-backed search/source routes for %s',
    async (scenarioId, expectedCoverage, expectedProbeIds) => {
      const fixture = await createQualityFixture([scenarioId], new AbortController().signal);
      try {
        const task = fixture.oracleCases[0];
        if (task === undefined) throw new Error(`${scenarioId} fixture missing`);

        const [route] = await collectQualityRouteCoverage(task, fixture, {
          signal: new AbortController().signal,
        });
        expect(route?.status).toBe(expectedCoverage);
        expect(route?.requiredProbeIds).toEqual(expectedProbeIds);
        expect(route?.probes[0]).toMatchObject({
          probeId: `${task.taskId}-index_status`,
          status: 'COVERED',
        });
        if (scenarioId === 'Q08@quality-v1') {
          expect(route?.probes[1]).toMatchObject({
            expectedAction: 'stale_during_request',
            requestMutationApplied: true,
            observedStatus: 'stale',
            reasonCode: 'INDEX_FILE_MISSING',
            oracleVerdict: 'CORRECT_REFUSAL',
            status: 'COVERED',
          });
        }
        expect(route?.probeTrace.filter(({ state }) => state !== 'SETUP')).toHaveLength(route?.probes.length ?? 0);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it('keeps the Q08 race probe incomplete when no in-request mutation was observed', async () => {
    const fixture = await createQualityFixture(['Q08@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q08 fixture missing');
      const adapter = {
        arm: 'N' as const,
        invoke(tool: string) {
          return Promise.resolve({
            status: tool === 'get_symbol_source' ? 'stale' as const : 'ok' as const,
            results: [],
            exposedBytes: 0,
            sourceAdoptions: [],
            rawDigest: 'result',
            normalizedPublicArgs: {},
            ...(tool === 'get_symbol_source' ? { reasonCode: 'INDEX_FILE_MISSING' } : {}),
          });
        },
      };

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
        adapter,
      });

      expect(route?.status).toBe('INCOMPLETE');
      expect(route?.probes.at(-1)).toMatchObject({
        expectedAction: 'stale_during_request',
        requestMutationApplied: false,
        observedStatus: 'stale',
        reasonCode: 'INDEX_FILE_MISSING',
        oracleVerdict: 'INCONCLUSIVE',
        status: 'INCOMPLETE',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('covers the retired and current Q03 identities through indexed symbol IDs', async () => {
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
      expect(route?.requiredProbeIds).toEqual([
        'Q03-index_status',
        'Q03-old-identity-refusal',
        'Q03-new-identity-source',
      ]);
      expect(oldIdentity).toMatchObject({
        tool: 'get_symbol_source',
        observedStatus: 'stale',
        reasonCode: 'INDEX_FILE_MISSING',
        oracleVerdict: 'INCONCLUSIVE',
        status: 'INCOMPLETE',
      });
      expect(currentIdentity).toMatchObject({
        tool: 'get_symbol_source',
        observedStatus: 'ok',
        oracleVerdict: 'CORRECT_CURRENT',
        status: 'COVERED',
      });
      expect(route?.status).toBe('INCOMPLETE');
    } finally {
      await fixture.dispose();
    }
  });

  it('queries the Q05 identity acquired before deletion and accepts the specified stale refusal', async () => {
    const fixture = await createQualityFixture(['Q05@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q05 fixture missing');
      expect(task.mutationSchedule).toEqual([
        expect.objectContaining({ phase: 'before_publication', operation: 'delete' }),
      ]);
      expect(task.expectedRefusalConditions).toContain('INDEX_FILE_MISSING');

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });

      expect(route?.status).toBe('COVERED');
      expect(route?.probes.at(-1)).toMatchObject({
        probeId: 'Q05-retired-refusal',
        tool: 'get_symbol_source',
        observedStatus: 'stale',
        reasonCode: 'INDEX_FILE_MISSING',
        oracleVerdict: 'CORRECT_REFUSAL',
        status: 'COVERED',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('records adapter exceptions as sanitized evidence and continues to later probes', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');
      let outlineCalls = 0;
      const adapter = {
        arm: 'N' as const,
        invoke(tool: string) {
          if (tool === 'get_file_outline' && outlineCalls++ === 0) {
            return Promise.reject(new Error('private setup failure'));
          }
          if (tool === 'get_symbol_source') return Promise.reject(new Error('private probe failure'));
          return Promise.resolve({
            status: 'ok' as const,
            results: [],
            exposedBytes: 0,
            sourceAdoptions: [],
            rawDigest: 'result',
            normalizedPublicArgs: {},
          });
        },
      };

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
        adapter,
      });

      expect(route?.probeTrace[0]).toMatchObject({
        state: 'SETUP',
        resultStatus: 'error',
        reasonCode: 'ADAPTER_INVOKE_FAILED',
      });
      expect(route?.setupProofDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(route?.probeTrace.filter(({ state }) => state === 'CONTRACT_PROBE')).toHaveLength(2);
      expect(route?.probes.at(-1)).toMatchObject({
        observedStatus: 'error',
        reasonCode: 'ADAPTER_INVOKE_FAILED',
      });
      expect(JSON.stringify(route?.probeTrace)).not.toContain('private setup failure');
      expect(JSON.stringify(route?.probes)).not.toContain('private probe failure');
    } finally {
      await fixture.dispose();
    }
  });

  it('returns stub navigation results only for the expected URI and coordinates', async () => {
    const fixture = await createQualityFixture(['Q13@quality-v1'], new AbortController().signal);
    let close: (() => Promise<void>) | undefined;
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const location = task?.expectedLocations[0];
      if (task === undefined || root === undefined || location === undefined) {
        throw new Error('Q13 fixture missing');
      }
      const stubLocations = {
        definition: [{
          filePath: location.filePath,
          startLine: location.line,
          startCharacter: location.character,
          endLine: location.line,
          endCharacter: location.character + 6,
        }],
        references: [],
        implementations: [],
      };
      const adapter = await createNexusAdapterForRoot(root, stubLocations);
      close = adapter.close;
      const signal = new AbortController().signal;
      const valid = await adapter.invoke(
        'get_definition',
        { filePath: location.filePath, line: location.line, character: location.character },
        signal,
        { traceSequence: 1 },
      );
      const invalid = await adapter.invoke(
        'get_definition',
        { filePath: location.filePath, line: location.line, character: location.character + 1 },
        signal,
        { traceSequence: 2 },
      );

      expect(valid.navigation?.locations).toHaveLength(1);
      expect(invalid.navigation?.locations).toEqual([]);
    } finally {
      await close?.();
      await fixture.dispose();
    }
  });

  it('grades the Q06 request-time source against the later recreated publication snapshot', async () => {
    const fixture = await createQualityFixture(['Q06@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q06 fixture missing');

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });
      const probe = route?.probes.find(({ probeId }) => probeId === 'Q06-recreated-source');
      const trace = route?.probeTrace.find(({ sequence }) => sequence === probe?.traceSequence);

      expect(probe?.setupProofDigest).toBe(route?.setupProofDigest);
      expect(trace?.requestSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(probe?.publicationSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(trace?.requestSnapshotDigest).not.toBe(probe?.publicationSnapshotDigest);
      expect(probe?.oracleVerdict).toBe('FALSE_FRESH');
      expect(probe?.status).toBe('INCOMPLETE');
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
      expect(route?.requiredProbeIds).toEqual([
        'Q14-index_status',
        'Q14-definition',
        'Q14-references',
        'Q14-implementations',
      ]);
      expect(route?.probes.filter(({ expectedAction }) => expectedAction === 'safe_refusal')).toEqual([
        expect.objectContaining({
          tool: 'get_definition',
          expectedAction: 'safe_refusal',
          observedStatus: 'unavailable',
          reasonCode: 'LSP_NOT_CONFIGURED',
          status: 'COVERED',
        }),
        expect.objectContaining({
          tool: 'get_references',
          expectedAction: 'safe_refusal',
          observedStatus: 'unavailable',
          reasonCode: 'LSP_NOT_CONFIGURED',
          status: 'COVERED',
        }),
        expect.objectContaining({
          tool: 'get_implementations',
          expectedAction: 'safe_refusal',
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
      const adapter = await createNexusAdapterForRoot(root);
      try {
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
        await adapter.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the indexed Nexus structured retrieval path without receiving the Golden manifest', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    let close: (() => Promise<void>) | undefined;
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const filePath = task?.expectedFiles[0];
      if (task === undefined || root === undefined || filePath === undefined) {
        throw new Error('Q01 fixture missing');
      }

      const adapter = await createNexusAdapterForRoot(root);
      close = adapter.close;
      const signal = new AbortController().signal;
      const outline = await adapter.invoke(
        'get_file_outline',
        { filePath },
        signal,
        { traceSequence: 1 },
      );
      const symbolId = outline.results.find((candidate) => candidate.preview === 'answer')?.symbolId;
      expect(outline.status).toBe('ok');
      expect(symbolId).toMatch(/^symbol_v1_[A-Za-z0-9_-]{43}$/);
      expect(symbolId).not.toBe('answer');

      if (symbolId === undefined) throw new Error('indexed symbol identity missing');
      const source = await adapter.invoke(
        'get_symbol_source',
        { symbolId },
        signal,
        { traceSequence: 2 },
      );
      expect(source.status).toBe('ok');
      expect(source.sourceAdoptions[0]?.content).toContain('return 42');
    } finally {
      await close?.();
      await fixture.dispose();
    }
  });

  it('reports indexed outline freshness after a fixture file is deleted', async () => {
    const fixture = await createQualityFixture(['Q05@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      const filePath = task?.expectedFiles[0];
      const symbol = task?.expectedSymbols[0];
      if (task === undefined || root === undefined || filePath === undefined || symbol === undefined) {
        throw new Error('Q05 fixture missing');
      }
      const adapter = await createNexusAdapterForRoot(root);
      try {
        const outline = await adapter.invoke(
          'get_file_outline',
          { filePath },
          new AbortController().signal,
          { traceSequence: 1 },
        );
        const symbolId = outline.results.find(({ preview }) => preview === symbol.name)?.symbolId;
        if (symbolId === undefined) throw new Error('Q05 indexed symbol missing');
        await applyQualityMutation(fixture, task.taskId, 'before_publication');
        const source = await adapter.invoke(
          'get_symbol_source',
          { symbolId },
          new AbortController().signal,
          { traceSequence: 2 },
        );
        const staleOutline = await adapter.invoke(
          'get_file_outline',
          { filePath },
          new AbortController().signal,
          { traceSequence: 3 },
        );

        expect(outline.status).toBe('ok');
        expect(source).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_MISSING' });
        expect(staleOutline).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_MISSING' });
      } finally {
        await adapter.close();
      }
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
    let snapshotCaptureCount = 0;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const snapshotStarted = new Promise<void>((resolve) => { announceSnapshotStart = resolve; });
    const originalCapture = oracle.captureOracleSnapshot;
    const captureSpy = vi.spyOn(oracle, 'captureOracleSnapshot').mockImplementation(async (current, rootKey, taskId) => {
      snapshotCaptureCount += 1;
      if (snapshotCaptureCount === 3) {
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
