import { describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  qualityArmOrder,
  runQualityPolicy,
  type QualityPolicyObserver,
  type QualityPolicyResult,
} from '../../../benchmarks/quality/policy.js';
import {
  queryDigest,
  type QualityAdapter,
  type QualityObservation,
  type QualityTool,
} from '../../../benchmarks/quality/adapters.js';
import type { PublicQualityTask } from '../../../benchmarks/quality/contracts.js';
import { QUALITY_BUDGETS_V1 } from '../../../benchmarks/quality/contracts.js';

const okObservation = (
  results: QualityObservation['results'],
  overrides: Partial<QualityObservation> = {},
): QualityObservation => ({
  status: 'ok',
  results: Object.freeze([...results]),
  exposedBytes: results.reduce((sum, r) => sum + Buffer.byteLength(r.preview ?? '', 'utf8'), 0),
  sourceAdoptions: Object.freeze([]),
  rawDigest: 'raw-digest',
  normalizedPublicArgs: Object.freeze({}),
  ...overrides,
});

const readObservation = (filePath: string, content: string): QualityObservation => ({
  status: 'ok',
  results: Object.freeze([{ filePath, preview: content, rank: 1 }]),
  exposedBytes: Buffer.byteLength(content, 'utf8'),
  sourceAdoptions: Object.freeze([{
    filePath,
    startByte: 0,
    endByte: Buffer.byteLength(content, 'utf8'),
    content,
    sourceValidation: 'verified',
  }]),
  rawDigest: 'read-digest',
  normalizedPublicArgs: Object.freeze({ filePath }),
});

const errorObservation = (reasonCode: string): QualityObservation => ({
  status: 'error',
  results: Object.freeze([]),
  exposedBytes: 0,
  sourceAdoptions: Object.freeze([]),
  rawDigest: 'error-digest',
  normalizedPublicArgs: Object.freeze({}),
  reasonCode,
});

const emptyOk = (): QualityObservation => okObservation([]);

const fakeAdapter = (
  arm: QualityAdapter['arm'],
  handler: (tool: QualityTool, args: Readonly<Record<string, unknown>>, callIndex: number) => QualityObservation,
): QualityAdapter => {
  let calls = 0;
  return {
    arm,
    invoke: async (tool, args, _signal, context) => {
      calls += 1;
      const observation = handler(tool, args, calls);
      // Enforce traceSequence is recorded by returning a stable digest that includes it.
      return {
        ...observation,
        rawDigest: `${observation.rawDigest}:${context.traceSequence}:${calls}`,
      };
    },
  };
};

const makeTask = (clues: readonly string[]): PublicQualityTask =>
  Object.freeze({ taskDescription: 'test', initialClues: Object.freeze([...clues]) });

describe('canonicalJson', () => {
  it('preserves nested values and sorts every object by code-unit key order', () => {
    expect(canonicalJson({
      z: 1,
      A: 2,
      a: 3,
      nested: { zebra: false, Alpha: true },
      list: [{ value: 1, id: 'first' }],
    })).toBe('{"A":2,"a":3,"list":[{"id":"first","value":1}],"nested":{"Alpha":true,"zebra":false},"z":1}');
  });
});

describe('qualityArmOrder', () => {
  it('orders even indices as R then N', () => {
    expect(qualityArmOrder(0)).toEqual(['R', 'N']);
    expect(qualityArmOrder(2)).toEqual(['R', 'N']);
  });

  it('orders odd indices as N then R', () => {
    expect(qualityArmOrder(1)).toEqual(['N', 'R']);
    expect(qualityArmOrder(3)).toEqual(['N', 'R']);
  });
});

describe('runQualityPolicy', () => {
  it('returns EXHAUSTED for invalid clues', async () => {
    const adapter = fakeAdapter('N', () => emptyOk());
    const result = await runQualityPolicy(makeTask(['unknown:foo']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('EXHAUSTED');
    expect(result.trace).toHaveLength(0);
  });

  it.each([
    'position:src/answer.ts@12abc:3',
    'position:src/answer.ts@1.5:2',
    'position:src/answer.ts@1:3tail',
    'position:@1:2',
    'position:src/answer.ts@9007199254740993:3',
  ])('rejects malformed navigation position clue %s before tool calls', async (position) => {
    let calls = 0;
    const adapter = fakeAdapter('N', () => {
      calls += 1;
      return emptyOk();
    });
    const result = await runQualityPolicy(
      makeTask(['nav:definition', position]),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(result.status).toBe('EXHAUSTED');
    expect(result.trace).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('reserves a unique trace sequence for every adapter call', async () => {
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') return okObservation([{ filePath: 'a.ts', line: 1, preview: 'id foo', rank: 1 }]);
      return readObservation('a.ts', 'id foo');
    });
    const result = await runQualityPolicy(makeTask(['id:foo']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    const sequences = result.trace.map((t) => t.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([1, 2]);
    expect(result.trace.find((event) => event.adoptionSequence !== undefined)).toMatchObject({
      sequence: 2,
      adoptionSequence: 1,
    });
    expect(result.adoptionEvents[0]?.sequence).toBe(1);
  });

  it('counts adopted bytes and tokens only once', async () => {
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') return okObservation([{ filePath: 'a.ts', line: 1, preview: 'x', rank: 1 }]);
      return readObservation('a.ts', 'x');
    });
    const result = await runQualityPolicy(makeTask(['id:x']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);

    expect(result.status).toBe('COMPLETE');
    expect(result.contextBytes).toBe(2);
    expect(result.contextTokens).toBe(2);
    expect(result.adoptionEvents[0]?.cumulativeCost).toMatchObject({ contextBytes: 2, contextTokens: 2 });
  });

  it('does not double-count a rejected tentative adoption', async () => {
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') return okObservation([{ filePath: 'a.ts', line: 1, preview: 'answer', rank: 1 }]);
      return readObservation('a.ts', 'other');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);

    expect(result.status).toBe('EXHAUSTED');
    expect(result.adoption).toBeUndefined();
    expect(result.adoptionEvents[0]?.cumulativeCost.contextBytes).toBe(11);
  });

  it('keeps raw queries out of normalizedPublicArgs and trace queryDigest is present', async () => {
    const adapter = fakeAdapter('N', (tool, args) => {
      if (tool === 'grep_search') {
        expect(args).toEqual({ pattern: 'secret', maxResults: 20 });
        return okObservation([{ filePath: 'a.ts', line: 1, preview: 'secret', rank: 1 }]);
      }
      return readObservation('a.ts', 'secret');
    });
    const result = await runQualityPolicy(makeTask(['id:secret']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    const searchTrace = result.trace.find((t) => t.tool === 'grep_search');
    expect(searchTrace).toBeDefined();
    expect(searchTrace?.normalizedPublicArgs).not.toHaveProperty('pattern');
    expect(searchTrace?.queryDigest).toBe(queryDigest('secret'));
  });

  it('adopts a file clue via bounded get_context on N', async () => {
    const adapter = fakeAdapter('N', (tool, args) => {
      if (tool === 'get_file_outline') {
        return okObservation([{ filePath: 'src/answer.ts', preview: 'answer', rank: 1 }]);
      }
      expect(tool).toBe('get_context');
      expect(args.filePath).toBe('src/answer.ts');
      return readObservation('src/answer.ts', 'export function answer(): number');
    });
    const result = await runQualityPolicy(makeTask(['file:src/answer.ts']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    expect(result.adoption?.filePath).toBe('src/answer.ts');
    expect(result.trace.some((t) => t.tool === 'get_file_outline')).toBe(true);
    expect(result.trace.some((t) => t.tool === 'get_context')).toBe(true);
  });

  it('adopts a symbol clue via get_symbol_source on N', async () => {
    const adapter = fakeAdapter('N', (tool, args) => {
      if (tool === 'get_symbol_source') {
        const content = 'export function answer(): number';
        expect(args.symbolId).toBe('answer');
        return okObservation(
          [{ filePath: 'src/answer.ts', symbolId: 'answer', preview: content, rank: 1 }],
          { sourceAdoptions: readObservation('src/answer.ts', content).sourceAdoptions },
        );
      }
      return emptyOk();
    });
    const result = await runQualityPolicy(makeTask(['symbol:answer', 'file:src/answer.ts']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    expect(result.adoption?.content).toContain('answer');
  });

  it('does not promote unverified N-arm previews to verified adoptions', async () => {
    const content = 'export function answer(): number';
    const partialSource = readObservation('src/answer.ts', content).sourceAdoptions[0];
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'get_symbol_source') {
        return okObservation(
          [{ filePath: 'src/answer.ts', symbolId: 'answer', preview: content, rank: 1 }],
          {
            sourceAdoptions: partialSource
              ? [Object.freeze({ ...partialSource, sourceValidation: 'partial' })]
              : [],
          },
        );
      }
      return emptyOk();
    });
    const result = await runQualityPolicy(
      makeTask(['symbol:answer', 'file:src/answer.ts']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(result.status).toBe('EXHAUSTED');
    expect(result.adoption).toBeUndefined();
    expect(result.adoptionEvents[0]?.source.sourceValidation).toBe('partial');
  });

  it('treats missing N-arm source validation as unknown', async () => {
    const content = 'export function answer(): number';
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'get_symbol_source') {
        return okObservation([{ filePath: 'src/answer.ts', symbolId: 'answer', preview: content, rank: 1 }]);
      }
      return emptyOk();
    });
    const result = await runQualityPolicy(
      makeTask(['symbol:answer', 'file:src/answer.ts']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(result.status).toBe('EXHAUSTED');
    expect(result.adoption).toBeUndefined();
    expect(result.adoptionEvents[0]?.source.sourceValidation).toBe('unknown');
  });

  it('treats missing R-arm source validation as unknown', async () => {
    const content = 'export function answer(): number';
    const adapter = fakeAdapter('R', (tool) => {
      expect(tool).toBe('read_file');
      return okObservation([{ filePath: 'src/answer.ts', preview: content, rank: 1 }]);
    });
    const result = await runQualityPolicy(
      makeTask(['file:src/answer.ts']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(result.status).toBe('EXHAUSTED');
    expect(result.adoption).toBeUndefined();
    expect(result.adoptionEvents[0]?.source.sourceValidation).toBe('unknown');
  });

  it('requires an id clue to match content even when the file clue matches', async () => {
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'get_file_outline') return okObservation([{ filePath: 'src/answer.ts', preview: 'answer', rank: 1 }]);
      if (tool === 'grep_search') return emptyOk();
      expect(tool).toBe('get_context');
      return readObservation('src/answer.ts', 'export function unrelated(): number');
    });
    const result = await runQualityPolicy(
      makeTask(['file:src/answer.ts', 'id:answer']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );
    expect(result.status).toBe('EXHAUSTED');
    expect(result.adoption).toBeUndefined();
  });

  it('requires a symbol clue to match content when id and file clues also match', async () => {
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'get_symbol_source') {
        return okObservation([{ filePath: 'src/answer.ts', symbolId: 'answer', preview: 'export function answer(): number', rank: 1 }]);
      }
      if (tool === 'get_context') return readObservation('src/answer.ts', 'export function answer(): number');
      return emptyOk();
    });
    const result = await runQualityPolicy(
      makeTask(['file:src/answer.ts', 'id:answer', 'symbol:expectedSymbol']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );
    expect(result.status).toBe('EXHAUSTED');
    expect(result.adoption).toBeUndefined();
  });

  it('adopts an R-arm read matching a nav position file', async () => {
    const adapter = fakeAdapter('R', (tool) => {
      expect(tool).toBe('read_file');
      return readObservation('src/answer.ts', 'export function answer(): number');
    });
    const result = await runQualityPolicy(
      makeTask(['nav:definition', 'position:src/answer.ts@4:2']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.adoption?.filePath).toBe('src/answer.ts');
  });

  it('adopts the N-arm fallback read matching a nav position file', async () => {
    const adapter = fakeAdapter('N', (tool, args) => {
      if (tool === 'get_definition') return emptyOk();
      expect(tool).toBe('get_context');
      expect(args.filePath).toBe('src/answer.ts');
      expect(args.startLine).toBe(2);
      expect(args.endLine).toBe(6);
      return readObservation('src/answer.ts', 'export function answer(): number');
    });
    const result = await runQualityPolicy(
      makeTask(['nav:definition', 'position:src/answer.ts@4:2']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.adoption?.filePath).toBe('src/answer.ts');
    expect(result.trace.some((event) => event.fallback)).toBe(true);
    expect(result.trace.some((event) => event.tool === 'grep_search')).toBe(false);
  });

  it('tries the N-arm nav position read after id search does not adopt', async () => {
    const calls: QualityTool[] = [];
    const adapter = fakeAdapter('N', (tool, args) => {
      calls.push(tool);
      if (tool === 'get_definition' || tool === 'grep_search') return emptyOk();
      expect(tool).toBe('get_context');
      expect(args.filePath).toBe('src/answer.ts');
      return readObservation('src/answer.ts', 'export function answer(): number');
    });
    const result = await runQualityPolicy(
      makeTask(['nav:definition', 'position:src/answer.ts@4:2', 'id:answer']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(calls).toEqual(['get_definition', 'grep_search', 'get_context']);
    expect(result.status).toBe('COMPLETE');
    expect(result.adoption?.filePath).toBe('src/answer.ts');
  });

  it('adopts an id clue via rg_search on R', async () => {
    const adapter = fakeAdapter('R', (tool, args) => {
      if (tool === 'rg_search') {
        return okObservation([{ filePath: 'src/answer.ts', line: 1, preview: 'answer', rank: 1 }]);
      }
      return readObservation('src/answer.ts', 'export function answer(): number');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    expect(result.adoption?.filePath).toBe('src/answer.ts');
  });

  it('reads R-arm candidates from a bounded window around the matched byte offset', async () => {
    let readArgs: Readonly<Record<string, unknown>> | undefined;
    const adapter = fakeAdapter('R', (tool, args) => {
      if (tool === 'rg_search') {
        const candidate = Object.assign(
          { filePath: 'src/deep.ts', line: 700, preview: 'answer', rank: 1 },
          { matchStartByte: 8192 },
        );
        return okObservation([candidate]);
      }
      readArgs = args;
      return readObservation('src/deep.ts', 'answer');
    });

    const result = await runQualityPolicy(
      makeTask(['id:answer']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(readArgs).toEqual({
      filePath: 'src/deep.ts',
      startByte: 6144,
      endByte: 10240,
      alignUtf8Boundaries: true,
    });
    expect(result.status).toBe('COMPLETE');
  });

  it('aligns an R-arm line-based candidate read to UTF-8 boundaries', async () => {
    let readArgs: Readonly<Record<string, unknown>> | undefined;
    const adapter = fakeAdapter('R', (tool, args) => {
      if (tool === 'rg_search') {
        return okObservation([{ filePath: 'src/deep.ts', line: 700, preview: 'answer', rank: 1 }]);
      }
      readArgs = args;
      return readObservation('src/deep.ts', 'answer');
    });

    const result = await runQualityPolicy(
      makeTask(['id:answer']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(readArgs).toEqual({
      filePath: 'src/deep.ts',
      startLine: 700,
      alignUtf8Boundaries: true,
    });
    expect(result.status).toBe('COMPLETE');
  });

  it('reads an R-arm position route from its requested line', async () => {
    let readArgs: Readonly<Record<string, unknown>> | undefined;
    const adapter = fakeAdapter('R', (_tool, args) => {
      readArgs = args;
      return readObservation('src/deep.ts', 'answer');
    });

    const result = await runQualityPolicy(
      makeTask(['nav:definition', 'position:src/deep.ts@700:2']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(readArgs).toEqual({ filePath: 'src/deep.ts', startLine: 700, alignUtf8Boundaries: true });
    expect(result.status).toBe('COMPLETE');
  });

  it('does not repeat an R-arm search for a one-word concept', async () => {
    const queries: string[] = [];
    const adapter = fakeAdapter('R', (tool, args) => {
      if (tool === 'rg_search') {
        queries.push(String(args.query));
        return emptyOk();
      }
      return emptyOk();
    });
    const result = await runQualityPolicy(
      makeTask(['concept:foo']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(queries).toEqual(['foo']);
    expect(result.logicalOperations).toBe(1);
  });

  it('falls back along the concept route on N when hybrid is empty', async () => {
    const calls: QualityTool[] = [];
    const adapter = fakeAdapter('N', (tool) => {
      calls.push(tool);
      if (tool === 'hybrid_search') return emptyOk();
      if (tool === 'semantic_search') return okObservation([{ filePath: 'a.ts', line: 1, preview: 'concept hit', rank: 1 }]);
      return readObservation('a.ts', 'concept hit');
    });
    const result = await runQualityPolicy(makeTask(['concept:foo']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    expect(calls).toEqual(['hybrid_search', 'semantic_search', 'get_context']);
    expect(result.trace[0]?.fallback).toBe(false);
    expect(result.trace[1]?.fallback).toBe(true);
  });

  it('retries an error at most maxRetries times then follows fallback', async () => {
    let errors = 0;
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') {
        errors += 1;
        if (errors <= 2) return errorObservation('TOOL_ERROR');
        return okObservation([{ filePath: 'a.ts', line: 1, preview: 'answer', rank: 1 }]);
      }
      return readObservation('a.ts', 'answer');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    const grepTraces = result.trace.filter((t) => t.tool === 'grep_search');
    expect(grepTraces).toHaveLength(3);
    expect(grepTraces[0]?.retries).toBe(0);
    expect(grepTraces[1]?.retries).toBe(1);
    expect(grepTraces[2]?.retries).toBe(2);
    expect(grepTraces.map((event) => event.logicalOperations)).toEqual([1, 1, 1]);
    expect(grepTraces.map((event) => event.invocationCount)).toEqual([1, 2, 3]);
    expect(result.logicalOperations).toBe(2);
    expect(result.invocations).toBe(4);
  });

  it('allows retries when the logical-operation budget is already full', async () => {
    let semanticCalls = 0;
    const adapter = fakeAdapter('N', (tool, args) => {
      if (tool === 'grep_search') {
        return okObservation(Array.from({ length: 10 }, (_, index) => ({
          filePath: `f${index}.ts`,
          line: 1,
          preview: 'foo',
          rank: index + 1,
        })));
      }
      if (tool === 'get_context') return readObservation(String(args.filePath ?? ''), 'unrelated');
      if (tool === 'semantic_search') {
        semanticCalls += 1;
        return semanticCalls === 1 ? errorObservation('TOOL_ERROR') : emptyOk();
      }
      return emptyOk();
    });

    const result = await runQualityPolicy(makeTask(['id:foo']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    const semanticTraces = result.trace.filter((event) => event.tool === 'semantic_search');

    expect(result.status).toBe('EXHAUSTED');
    expect(semanticTraces.map((event) => event.retries)).toEqual([0, 1]);
    expect(result.logicalOperations).toBe(12);
    expect(result.invocations).toBe(13);
  });

  it('records and retries adapter rejections as error observations', async () => {
    let searchCalls = 0;
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') {
        searchCalls += 1;
        if (searchCalls === 1) throw new Error('private adapter failure');
        return okObservation([{ filePath: 'a.ts', line: 1, preview: 'answer', rank: 1 }]);
      }
      return readObservation('a.ts', 'answer');
    });

    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    const searchTraces = result.trace.filter((event) => event.tool === 'grep_search');

    expect(result.status).toBe('COMPLETE');
    expect(searchTraces).toHaveLength(2);
    expect(searchTraces[0]).toMatchObject({
      resultStatus: 'error',
      reasonCode: 'ADAPTER_INVOKE_FAILED',
      retries: 0,
    });
    expect(searchTraces[1]).toMatchObject({ resultStatus: 'ok', retries: 1 });
    expect(result.logicalOperations).toBe(2);
    expect(result.invocations).toBe(3);
    expect(JSON.stringify(result.trace)).not.toContain('private adapter failure');
  });

  it('records retries per search operation instead of carrying them into fallback attempts', async () => {
    let hybridCalls = 0;
    let semanticCalls = 0;
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'hybrid_search') {
        hybridCalls += 1;
        return hybridCalls === 1 ? errorObservation('TOOL_ERROR') : emptyOk();
      }
      if (tool === 'semantic_search') {
        semanticCalls += 1;
        return semanticCalls === 1
          ? errorObservation('TOOL_ERROR')
          : okObservation([{ filePath: 'a.ts', line: 1, preview: 'concept hit', rank: 1 }]);
      }
      return readObservation('a.ts', 'concept hit');
    });
    const result = await runQualityPolicy(makeTask(['concept:foo']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    expect(result.trace.filter((event) => event.tool === 'hybrid_search').map((event) => event.retries)).toEqual([0, 1]);
    expect(result.trace.filter((event) => event.tool === 'semantic_search').map((event) => event.retries)).toEqual([0, 1]);
  });

  it('stops retries and fallback routes after cancellation during a search', async () => {
    const controller = new AbortController();
    let adapterCalls = 0;
    const adapter = fakeAdapter('N', () => {
      adapterCalls += 1;
      controller.abort();
      return errorObservation('TOOL_ERROR');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, controller.signal);
    expect(adapterCalls).toBe(1);
    expect(result.trace).toHaveLength(1);
    expect(result.logicalOperations).toBe(1);
  });

  it.each(['verified', 'partial', 'unknown'] as const)(
    'records %s navigation events without adopting locations as source',
    async (sourceValidation) => {
      const locations = [
        { filePath: 'a.ts', startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4 },
        { filePath: 'a.ts', startLine: 1, startCharacter: 10, endLine: 1, endCharacter: 14 },
      ];
      const adapter = fakeAdapter('N', (tool) =>
        tool === 'get_references'
          ? okObservation([], {
              navigation: {
                locations: Object.freeze([...locations]),
                truncated: false,
                sourceValidation,
                capability: 'supported',
              },
            })
          : emptyOk(),
      );
      const result = await runQualityPolicy(
        makeTask(['position:a.ts@1:5', 'nav:references']),
        adapter,
        QUALITY_BUDGETS_V1,
        new AbortController().signal,
      );
      expect(result.status).toBe('EXHAUSTED');
      expect(result.adoption).toBeUndefined();
      expect(result.adoptionEvents).toHaveLength(0);
      expect(result.navigationEvents).toHaveLength(1);
      expect(result.navigationEvents[0]?.locations).toHaveLength(2);
      expect(result.navigationEvents[0]?.tool).toBe('get_references');
      expect(result.navigationEvents[0]?.sourceValidation).toBe(sourceValidation);
    },
  );

  it('notifies the observer at each adoption without allowing observer errors to abort policy', async () => {
    const events: Array<QualityPolicyResult['adoptionEvents'][number]> = [];
    const observer: QualityPolicyObserver = {
      onAdoptionPublished: async (event) => {
        events.push(event);
        throw new Error('observer must not abort');
      },
    };
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') return okObservation([{ filePath: 'a.ts', line: 1, preview: 'answer', rank: 1 }]);
      return readObservation('a.ts', 'answer');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal, observer);
    expect(result.status).toBe('COMPLETE');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(result.adoptionEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('returns EXHAUSTED when the logical operation budget is exceeded', async () => {
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') {
        return okObservation(Array.from({ length: 20 }, (_, i) => ({
          filePath: `f${i}.ts`,
          line: 1,
          preview: `candidate ${i}`,
          rank: i + 1,
        })));
      }
      return readObservation('f0.ts', 'no match');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('EXHAUSTED');
    expect(result.logicalOperations).toBeLessThanOrEqual(QUALITY_BUDGETS_V1.maxLogicalOperations);
  });

  it('rejects an observation that exceeds the context byte budget without adopting it', async () => {
    let invocations = 0;
    const adapter = fakeAdapter('N', (tool) => {
      invocations += 1;
      if (tool === 'grep_search') {
        return okObservation([{ filePath: 'a.ts', line: 1, preview: 'answer', rank: 1 }]);
      }
      if (tool === 'get_context') {
        return {
          ...readObservation('a.ts', 'answer'),
          exposedBytes: QUALITY_BUDGETS_V1.maxContextBytes + 1,
        };
      }
      return emptyOk();
    });

    const result = await runQualityPolicy(
      makeTask(['id:answer']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(result.status).toBe('EXHAUSTED');
    expect(result.contextBytes).toBe(Buffer.byteLength('answer', 'utf8'));
    expect(result.adoption).toBeUndefined();
    expect(result.adoptionEvents).toHaveLength(0);
    expect(invocations).toBe(2);
  });

  it('does not charge or continue after a search observation exceeds the remaining context budget', async () => {
    let invocations = 0;
    const adapter = fakeAdapter('N', (tool) => {
      invocations += 1;
      if (tool === 'grep_search') {
        return okObservation([{
          filePath: 'a.ts',
          line: 1,
          preview: 'x'.repeat(QUALITY_BUDGETS_V1.maxContextBytes + 1),
          rank: 1,
        }]);
      }
      return emptyOk();
    });

    const result = await runQualityPolicy(
      makeTask(['id:answer']),
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );

    expect(result.status).toBe('EXHAUSTED');
    expect(result.contextBytes).toBe(0);
    expect(result.adoption).toBeUndefined();
    expect(invocations).toBe(1);
  });

  it('recognizes Unicode identifiers without matching them inside another identifier', async () => {
    const run = async (content: string): Promise<QualityPolicyResult> => {
      const adapter = fakeAdapter('N', (tool) => {
        if (tool === 'grep_search') {
          return okObservation([{ filePath: 'a.ts', line: 1, preview: content, rank: 1 }]);
        }
        return readObservation('a.ts', content);
      });
      return runQualityPolicy(
        makeTask(['id:変数']),
        adapter,
        QUALITY_BUDGETS_V1,
        new AbortController().signal,
      );
    };

    const exactIdentifier = await run('const 変数 = 1;');
    const embeddedIdentifier = await run('const 別変数 = 1;');

    expect(exactIdentifier.status).toBe('COMPLETE');
    expect(embeddedIdentifier.status).toBe('EXHAUSTED');
  });

  it('returns when the observer is still pending after the request signal aborts', async () => {
    const controller = new AbortController();
    const observer: QualityPolicyObserver = {
      onAdoptionPublished: () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        return new Promise<void>(() => undefined);
      },
    };
    const adapter = fakeAdapter('N', (tool) => {
      if (tool === 'grep_search') {
        return okObservation([{ filePath: 'a.ts', line: 1, preview: 'answer', rank: 1 }]);
      }
      return readObservation('a.ts', 'answer');
    });

    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, controller.signal, observer)
        .then((value) => ({ kind: 'result' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), 1_000);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);

    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(outcome.value.status).toBe('COMPLETE');
      expect(outcome.value.adoptionEvents).toHaveLength(1);
    }
  });

  it('stamps monotonic nonnegative elapsedMs on adoption events', async () => {
    const adapter = fakeAdapter('N', (tool, args) => {
      if (tool === 'grep_search') {
        return okObservation([
          { filePath: 'tentative.ts', line: 1, preview: 'answer', rank: 1 },
          { filePath: 'final.ts', line: 1, preview: 'answer', rank: 2 },
        ]);
      }
      const filePath = String(args.filePath);
      return readObservation(filePath, filePath === 'tentative.ts' ? 'other' : 'answer');
    });
    const result = await runQualityPolicy(makeTask(['id:answer']), adapter, QUALITY_BUDGETS_V1, new AbortController().signal);
    expect(result.status).toBe('COMPLETE');
    expect(result.adoptionEvents).toHaveLength(2);
    for (const event of result.adoptionEvents) {
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.elapsedMs)).toBe(true);
    }
    for (let i = 1; i < result.adoptionEvents.length; i += 1) {
      expect(result.adoptionEvents[i]?.elapsedMs).toBeGreaterThanOrEqual(result.adoptionEvents[i - 1]?.elapsedMs ?? 0);
    }
  });

  it('selects fallback tokens in code-unit order independent of locale collation', async () => {
    const queries: string[] = [];
    const localeCompareSpy = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
      this: string,
      compareString: string,
    ) {
      return this < compareString ? 1 : this > compareString ? -1 : 0;
    });

    try {
      const adapter = fakeAdapter('R', (tool, args) => {
        expect(tool).toBe('rg_search');
        queries.push(String(args.query));
        return emptyOk();
      });
      const result = await runQualityPolicy(
        makeTask(['concept:alpha bravo charlie delta echo']),
        adapter,
        QUALITY_BUDGETS_V1,
        new AbortController().signal,
      );

      expect(result.status).toBe('EXHAUSTED');
      expect(queries).toEqual([
        'alpha bravo charlie delta echo',
        'charlie',
        'alpha',
        'bravo',
      ]);
    } finally {
      localeCompareSpy.mockRestore();
    }
  });
});
