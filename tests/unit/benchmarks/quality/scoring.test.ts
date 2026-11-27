import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QUALITY_BUDGETS_V1, type PublicQualityTask } from '../../../../tests/benchmarks/quality/contracts.js';
import {
  runQualityPolicy,
  type QualityPolicyResult,
  type QualityTraceEvent,
} from '../../../../tests/benchmarks/quality/policy.js';
import type { SourceProvenance, SourceSnapshot } from '../../../../tests/benchmarks/quality/oracle.js';
import {
  gradeQualityArm,
  gradeDiscovery,
  buildBaselineRgExecutionEvidence,
  type QualityPublicationEvidence,
} from '../../../../tests/benchmarks/quality/scoring.js';
import type { QualityAdapter, QualityObservation, RgExecutionSnapshot } from '../../../../tests/benchmarks/quality/adapters.js';

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const digestSnapshot = (hashes: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(hashes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return sha256(entries.map(([path, digest]) => `${path}\0${digest}`).join('\n'));
};

const source = 'export function answer(): number { return 42; }\n';
const bytes = new TextEncoder().encode(source);
const fileHash = sha256(bytes);
const sourceHashes: Readonly<Record<string, string>> = { 'src/answer.ts': fileHash };
const snapshotDigest = digestSnapshot(sourceHashes);
const canonicalRoot = '/tmp/quality-unit-root';

const baseTask = {
  taskId: 'unit-q01',
  scenarioId: 'Q01@quality-v1' as const,
  fixtureId: 'unit-fixture',
  sourceSnapshotDigest: snapshotDigest,
  taskDescription: 'unit task',
  initialClues: [] as readonly string[],
  worktreeIdentity: { rootKey: 'single' as const, role: 'single' as const },
  mutationSchedule: [] as const,
  expectedFiles: ['src/answer.ts'] as const,
  expectedSymbols: [
    { filePath: 'src/answer.ts', name: 'answer', startByte: 0, endByte: bytes.length },
  ] as const,
  expectedSourceHashes: { 'src/answer.ts': fileHash } as const,
  expectedLocations: [{ filePath: 'src/answer.ts', line: 1, character: 0 }] as const,
  expectedRefusalConditions: [] as const,
  evaluationEligibility: 'required_core' as const,
};

const snapshot: SourceSnapshot = {
  rootKey: 'single',
  canonicalProjectRoot: canonicalRoot,
  snapshotDigest,
  sourceHashes,
  sourceBytes: { 'src/answer.ts': bytes },
};

const provenance: SourceProvenance = {
  observedSourceRootKey: 'single',
  canonicalSourceRoot: canonicalRoot,
  sourceRootProofDigest: sha256(canonicalRoot),
};

const emptyPolicy: QualityPolicyResult = {
  status: 'EXHAUSTED',
  adoptionEvents: [],
  navigationEvents: [],
  trace: [],
  logicalOperations: 0,
  invocations: 0,
  contextBytes: 0,
  contextTokens: 0,
};

const refusalClues: PublicQualityTask = {
  taskDescription: 'inspect the retired symbol',
  initialClues: ['symbol:retired', 'id:retired'],
};

const runSymbolSourceAttempt = async (
  result: Pick<QualityObservation, 'status' | 'reasonCode' | 'exposedBytes'>,
  options: { signal?: AbortSignal; throws?: boolean } = {},
) => {
  let calls = 0;
  const adapter: QualityAdapter = {
    arm: 'N',
    invoke: (tool, _args, _signal, context) => {
      calls += 1;
      if (options.throws && tool === 'get_symbol_source') {
        return Promise.reject(new Error('private adapter failure'));
      }
      return Promise.resolve({
        ...(tool === 'get_symbol_source' ? result : { status: 'ok' as const, reasonCode: undefined, exposedBytes: 0 }),
        results: Object.freeze([]),
        sourceAdoptions: Object.freeze([]),
        rawDigest: sha256(`symbol-source:${context.traceSequence}`),
        normalizedPublicArgs: Object.freeze({ symbolId: 'retired' }),
      });
    },
  };
  const policy = await runQualityPolicy(
    refusalClues,
    adapter,
    QUALITY_BUDGETS_V1,
    options.signal ?? new AbortController().signal,
  );
  const task = {
    ...baseTask,
    initialClues: refusalClues.initialClues,
    expectedRefusalConditions: ['SYMBOL_NOT_FOUND'],
  };
  const graded = gradeQualityArm(task, snapshot, policy, []);
  return { calls, policy, graded };
};

const makeTraceEvent = (tool: QualityTraceEvent['tool'], status: QualityTraceEvent['resultStatus'], resultCount: number): QualityTraceEvent => ({
  sequence: 1,
  state: 'DISCOVER',
  tool,
  normalizedPublicArgs: Object.freeze({}),
  argsDigest: sha256('args'),
  queryDigest: null,
  resultDigest: sha256('result'),
  resultStatus: status,
  reasonCode: null,
  resultCount,
  exposedBytes: 0,
  logicalOperations: 1,
  invocationCount: 1,
  retries: 0,
  fallback: false,
});

const makeAdoptionEvent = (filePath: string, content: string) => ({
  sequence: 1,
  source: {
    filePath,
    startByte: 0,
    endByte: Buffer.byteLength(content, 'utf8'),
    content,
    sourceValidation: 'verified' as const,
  },
  cumulativeCost: { logicalOperations: 1, invocations: 1, contextBytes: Buffer.byteLength(content, 'utf8'), contextTokens: 1 },
  elapsedMs: 1,
});

const makePublication = (snapshot: SourceSnapshot, provenance: SourceProvenance): QualityPublicationEvidence => ({
  adoptionSequence: 1,
  snapshot,
  provenance,
  snapshotCapturedAtPublication: true,
});

describe('gradeQualityArm', () => {
  it('returns not_run when the policy was not run', () => {
    const result = gradeQualityArm(baseTask, snapshot, null, []);
    expect(result.executionStatus).toBe('not_run');
    expect(result.observation).toBeNull();
    expect(result.reasonCode).toBe('POLICY_NOT_RUN');
  });

  it('returns INCONCLUSIVE when the snapshot is missing', () => {
    const result = gradeQualityArm(baseTask, null, emptyPolicy, []);
    expect(result.executionStatus).toBe('executed');
    expect(result.observation).toBe('INCONCLUSIVE');
    expect(result.reasonCode).toBe('SNAPSHOT_MISSING');
  });

  it('returns CORRECT_CURRENT for a matching verified adoption', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      adoptionEvents: [makeAdoptionEvent('src/answer.ts', source)],
    };
    const result = gradeQualityArm(baseTask, snapshot, policy, [makePublication(snapshot, provenance)]);
    expect(result.executionStatus).toBe('executed');
    expect(result.observation).toBe('CORRECT_CURRENT');
    expect(result.correctSourceReached).toBe(true);
    expect(result.wrongSourceAdopted).toBe(false);
    expect(result.adoptionHistory).toHaveLength(1);
    expect(result.adoptionHistory[0]?.observation).toBe('CORRECT_CURRENT');
  });

  it('returns WRONG_SOURCE when the provenance root key mismatches', () => {
    const badProvenance: SourceProvenance = {
      ...provenance,
      observedSourceRootKey: 'primary',
    };
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      adoptionEvents: [makeAdoptionEvent('src/answer.ts', source)],
    };
    const result = gradeQualityArm(baseTask, snapshot, policy, [makePublication(snapshot, badProvenance)]);
    expect(result.observation).toBe('WRONG_SOURCE');
    expect(result.wrongSourceAdopted).toBe(true);
    expect(result.reasonCode).toBe('SAFETY_FAIL');
  });

  it('does not score an exhausted investigation as a correct refusal', () => {
    const refusalTask = { ...baseTask, expectedRefusalConditions: ['SYMBOL_NOT_FOUND'] };
    const result = gradeQualityArm(refusalTask, snapshot, emptyPolicy, []);
    expect(result.observation).toBe('INCONCLUSIVE');
    expect(result.correctSourceReached).toBe(false);
  });

  it('keeps a pre-start abort as not_run rather than scoring a refusal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, policy, graded } = await runSymbolSourceAttempt(
      { status: 'not_found', reasonCode: 'SYMBOL_NOT_FOUND', exposedBytes: 0 },
      { signal: controller.signal },
    );

    expect(calls).toBe(0);
    expect(policy.status).toBe('NOT_STARTED');
    expect(graded.executionStatus).toBe('not_run');
    expect(graded.observation).toBeNull();
    expect(graded.reasonCode).toBe('REQUEST_CANCELLED');
  });

  it('keeps an adapter execution failure inconclusive instead of treating it as a refusal', async () => {
    const { calls, policy, graded } = await runSymbolSourceAttempt(
      { status: 'not_found', reasonCode: 'SYMBOL_NOT_FOUND', exposedBytes: 0 },
      { throws: true },
    );

    expect(calls).toBe(2);
    expect(policy.trace[0]).toMatchObject({
      tool: 'get_symbol_source',
      resultStatus: 'error',
      reasonCode: 'ADAPTER_INVOKE_FAILED',
    });
    expect(graded.observation).toBe('INCONCLUSIVE');
    expect(graded.reasonCode).toBe('POLICY_EXECUTION_FAILED');
  });

  it('scores an executed refusal with the expected reason as CORRECT_REFUSAL', async () => {
    const { policy, graded } = await runSymbolSourceAttempt({
      status: 'not_found',
      reasonCode: 'SYMBOL_NOT_FOUND',
      exposedBytes: 0,
    });

    expect(policy.status).toBe('EXHAUSTED');
    expect(policy.trace[0]).toMatchObject({ tool: 'get_symbol_source', resultStatus: 'not_found' });
    expect(graded.observation).toBe('CORRECT_REFUSAL');
  });

  it('scores an executed refusal with an unexpected reason as FALSE_REFUSAL', async () => {
    const { policy, graded } = await runSymbolSourceAttempt({
      status: 'stale_identity',
      reasonCode: 'SYMBOL_RETIRED',
      exposedBytes: 0,
    });

    expect(policy.status).toBe('EXHAUSTED');
    expect(policy.trace[0]).toMatchObject({ tool: 'get_symbol_source', resultStatus: 'stale_identity' });
    expect(graded.observation).toBe('FALSE_REFUSAL');
    expect(graded.reasonCode).toBe('UNEXPECTED_REFUSAL');
  });

  it.each([
    ['get_symbol_source', { symbolId: 'different-symbol' }],
    ['get_context', { filePath: 'src/other.ts', startLine: 1, endLine: 2 }],
  ] as const)(
    'does not score a refusal for an unrelated target (%s)',
    (tool, normalizedPublicArgs) => {
      const task = {
        ...baseTask,
        initialClues: ['id:answer'],
        expectedRefusalConditions: ['SYMBOL_NOT_FOUND'],
      };
      const policy: QualityPolicyResult = {
        ...emptyPolicy,
        trace: [{
          ...makeTraceEvent(tool, 'not_found', 0),
          normalizedPublicArgs,
          reasonCode: 'SYMBOL_NOT_FOUND',
        }],
      };

      const graded = gradeQualityArm(task, snapshot, policy, []);

      expect(graded.observation).toBe('FALSE_REFUSAL');
      expect(graded.reasonCode).toBe('UNEXPECTED_REFUSAL');
    },
  );

  it('returns INCONCLUSIVE when policy exhausts without any adoption or refusal evidence', () => {
    const result = gradeQualityArm(baseTask, snapshot, emptyPolicy, []);
    expect(result.observation).toBe('INCONCLUSIVE');
    expect(result.correctSourceReached).toBe(false);
  });
});

describe('gradeDiscovery', () => {
  it('returns NOT_ESTABLISHED when the policy was not run', () => {
    const result = gradeDiscovery(baseTask, 'N', null);
    expect(result.evidenceStatus).toBe('NOT_ESTABLISHED');
    expect(result.reasonCode).toBe('POLICY_NOT_RUN');
  });

  it('returns INCOMPLETE when no discovery tools were invoked', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      trace: [makeTraceEvent('read_file', 'ok', 1)],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.evidenceStatus).toBe('INCOMPLETE');
    expect(result.reasonCode).toBe('NO_DISCOVERY_TRACE');
  });

  it('marks fileFound true when the expected file appears in an adoption', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 1)],
      adoptionEvents: [{ ...makeAdoptionEvent('src/answer.ts', source), candidateRank: 1 }],
    };
    expect(policy.adoptionEvents[0]?.candidateRank).toBe(1);
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.evidenceStatus).toBe('EVALUATED');
    expect(result.fileFound).toBe(true);
    expect(result.symbolFound).toBe(true);
    expect(result.labeledUniqueCandidates).toBe(1);
    expect(result.hitsAtK).toBe(1);
    expect(result.reciprocalRank).toBe(1);
  });

  it('preserves successful adoptions when a completed discovery query was empty', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 0)],
      adoptionEvents: [{ ...makeAdoptionEvent('src/answer.ts', source), candidateRank: 1 }],
    };

    const result = gradeDiscovery(baseTask, 'N', policy);

    expect(result.fileFound).toBe(true);
    expect(result.symbolFound).toBe(true);
    expect(result.hitsAtK).toBe(1);
  });

  it('leaves symbol discovery ineligible for file-only tasks after an empty query', () => {
    const fileOnlyTask = { ...baseTask, expectedSymbols: [] };
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 0)],
      adoptionEvents: [makeAdoptionEvent('src/answer.ts', source)],
    };

    const result = gradeDiscovery(fileOnlyTask, 'N', policy);

    expect(result.fileFound).toBe(true);
    expect(result.symbolFound).toBeNull();
  });

  it('marks fileFound false when discovery succeeds but no expected target is adopted', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 1)],
      adoptionEvents: [makeAdoptionEvent('src/other.ts', ' unrelated content\n')],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.evidenceStatus).toBe('EVALUATED');
    expect(result.fileFound).toBe(false);
    expect(result.symbolFound).toBe(false);
    expect(result.irrelevantUniqueCandidates).toBe(1);
  });

  it('does not mark a same-named declaration in another file as the expected symbol', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 1)],
      adoptionEvents: [makeAdoptionEvent('src/other.ts', source)],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.symbolFound).toBe(false);
    expect(result.hitsAtK).toBe(0);
  });

  it('does not mark a same-file declaration at a different range as the expected symbol', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 1)],
    adoptionEvents: [{
      ...makeAdoptionEvent('src/answer.ts', source),
      source: { ...makeAdoptionEvent('src/answer.ts', source).source, endByte: bytes.length - 1 },
    }],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.symbolFound).toBe(false);
    expect(result.hitsAtK).toBe(0);
  });

  it('counts repeated adoptions of one file and declaration range once', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 2)],
      adoptionEvents: [
        makeAdoptionEvent('src/answer.ts', source),
        { ...makeAdoptionEvent('src/answer.ts', source), sequence: 2 },
      ],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.labeledUniqueCandidates).toBe(1);
    expect(result.hitsAtK).toBe(1);
  });

  it('counts one file range once when an initially irrelevant adoption is later correctly classified', () => {
    const wrongContent = 'export function other(): number { return 42; }\n';
    const firstAdoption = makeAdoptionEvent('src/answer.ts', wrongContent);
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 2)],
      adoptionEvents: [
        {
          ...firstAdoption,
          source: { ...firstAdoption.source, startByte: 0, endByte: bytes.length },
        },
        { ...makeAdoptionEvent('src/answer.ts', source), sequence: 2 },
      ],
    };

    const result = gradeDiscovery(baseTask, 'N', policy);

    expect(result.irrelevantUniqueCandidates).toBe(0);
    expect(result.labeledUniqueCandidates).toBe(1);
    expect(result.symbolFound).toBe(true);
    expect(result.hitsAtK).toBe(1);
  });

  it('counts distinct declaration ranges in one file as distinct candidates', () => {
    const taskWithDifferentGoldenRange = {
      ...baseTask,
      expectedSymbols: [{ filePath: 'src/answer.ts', name: 'answer', startByte: 5, endByte: 6 }],
    };
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 2)],
      adoptionEvents: [
        makeAdoptionEvent('src/answer.ts', source),
        {
          ...makeAdoptionEvent('src/answer.ts', source),
          sequence: 2,
          source: { ...makeAdoptionEvent('src/answer.ts', source).source, startByte: 1, endByte: bytes.length },
        },
      ],
    };
    const result = gradeDiscovery(taskWithDifferentGoldenRange, 'N', policy);
    expect(result.irrelevantUniqueCandidates).toBe(2);
    expect(result.labeledUniqueCandidates).toBe(0);
    expect(result.hitsAtK).toBe(0);
  });

  it('counts repeated irrelevant adoptions of one range once', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('grep_search', 'ok', 2)],
      adoptionEvents: [
        makeAdoptionEvent('src/other.ts', 'export function unrelated(): number { return 1; }\n'),
        {
          ...makeAdoptionEvent('src/other.ts', 'export function unrelated(): number { return 1; }\n'),
          sequence: 2,
        },
      ],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.irrelevantUniqueCandidates).toBe(1);
  });

  it('does not infer reciprocal rank from discovery-call position without a candidate rank', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [
        { ...makeTraceEvent('grep_search', 'ok', 1), sequence: 1 },
        { ...makeTraceEvent('hybrid_search', 'ok', 1), sequence: 4, adoptionSequence: 3 },
      ],
      adoptionEvents: [{ ...makeAdoptionEvent('src/answer.ts', source), sequence: 3 }],
    };
    const result = gradeDiscovery(baseTask, 'N', policy);
    expect(result.reciprocalRank).toBeNull();
  });

  it('uses the adopted candidate rank when rank 1 cannot be read', async () => {
    const adapter: QualityAdapter = {
      arm: 'N',
      invoke: (tool, args) => {
        if (tool === 'grep_search') {
          return Promise.resolve({
            status: 'ok',
            results: Object.freeze([
              { filePath: 'src/unreadable.ts', rank: 1 },
              { filePath: 'src/answer.ts', rank: 2 },
            ]),
            exposedBytes: 0,
            sourceAdoptions: Object.freeze([]),
            rawDigest: 'ranked-search',
            normalizedPublicArgs: Object.freeze({}),
          });
        }
        if (tool === 'read_file' && args.filePath === 'src/unreadable.ts') {
          return Promise.resolve({
            status: 'not_found',
            results: Object.freeze([]),
            exposedBytes: 0,
            sourceAdoptions: Object.freeze([]),
            rawDigest: 'unreadable-candidate',
            normalizedPublicArgs: Object.freeze({}),
          });
        }
        if (tool === 'read_file' && args.filePath === 'src/answer.ts') {
          return Promise.resolve({
            status: 'ok',
            results: Object.freeze([{ filePath: 'src/answer.ts', preview: source, rank: 1 }]),
            exposedBytes: bytes.length,
            sourceAdoptions: Object.freeze([{
              filePath: 'src/answer.ts',
              startByte: 0,
              endByte: bytes.length,
              content: source,
              sourceValidation: 'verified',
            }]),
            rawDigest: 'read-answer',
            normalizedPublicArgs: Object.freeze({}),
          });
        }
        return Promise.reject(new Error(`unexpected tool: ${tool}`));
      },
    };
    const policy = await runQualityPolicy(
      { taskDescription: 'find answer', initialClues: ['id:answer'] },
      adapter,
      QUALITY_BUDGETS_V1,
      new AbortController().signal,
    );
    const declarationTask = {
      ...baseTask,
      expectedSymbols: [{
        ...baseTask.expectedSymbols[0],
        endByte: bytes.length - 1,
      }],
    };
    const result = gradeDiscovery(declarationTask, 'N', policy);

    expect(policy.adoptionEvents[0]?.candidateRank).toBe(2);
    expect(result.reciprocalRank).toBe(0.5);
  });

  it('does not invent a reciprocal rank when an adoption has no candidate rank', () => {
    const policy: QualityPolicyResult = {
      ...emptyPolicy,
      status: 'COMPLETE',
      trace: [makeTraceEvent('get_file_outline', 'ok', 1)],
      adoptionEvents: [makeAdoptionEvent('src/answer.ts', source)],
    };

    const result = gradeDiscovery(baseTask, 'N', policy);

    expect(result.evidenceStatus).toBe('EVALUATED');
    expect(result.reciprocalRank).toBeNull();
  });
});

describe('buildBaselineRgExecutionEvidence', () => {
  const contractDigest = sha256('contract');

  const makeSnapshot = (overrides: Partial<RgExecutionSnapshot>): RgExecutionSnapshot => ({
    initializedContractDigest: contractDigest,
    rgSearchInvocationCount: 0,
    spawnAttemptCount: 0,
    spawns: [],
    evidenceComplete: true,
    ...overrides,
  });

  it('reports NOT_INVOKED when no rg_search activity occurred', () => {
    const result = buildBaselineRgExecutionEvidence(makeSnapshot({}), []);
    expect(result.status).toBe('NOT_INVOKED');
    expect(result.invocationCount).toBe(0);
    expect(result.baselineExecutionContractDigest).toBeNull();
  });

  it('reports INVOKED_VERIFIED when spawns and trace are consistent', () => {
    const spawn = {
      spawnOrdinal: 1,
      policyTraceSequence: 1,
      rootKey: 'single' as const,
      searchScope: '.' as const,
      normalizedObservedArgv: [] as readonly string[],
      queryDigest: sha256('q'),
      observedExclusions: [] as readonly string[],
      readMaxBytesPerCall: 4096 as const,
      observedContractDigest: contractDigest,
    };
    const snapshot = makeSnapshot({
      rgSearchInvocationCount: 1,
      spawnAttemptCount: 1,
      spawns: [spawn],
    });
    const trace = [makeTraceEvent('rg_search', 'ok', 1)];
    const result = buildBaselineRgExecutionEvidence(snapshot, trace);
    expect(result.status).toBe('INVOKED_VERIFIED');
    expect(result.invocationCount).toBe(1);
    expect(result.baselineExecutionContractDigest).toBe(contractDigest);
  });

  it('reports EVIDENCE_INCOMPLETE when a spawn is missing from the policy trace', () => {
    const spawn = {
      spawnOrdinal: 1,
      policyTraceSequence: 2,
      rootKey: 'single' as const,
      searchScope: '.' as const,
      normalizedObservedArgv: [] as readonly string[],
      queryDigest: sha256('q'),
      observedExclusions: [] as readonly string[],
      readMaxBytesPerCall: 4096 as const,
      observedContractDigest: contractDigest,
    };
    const snapshot = makeSnapshot({
      rgSearchInvocationCount: 1,
      spawnAttemptCount: 1,
      spawns: [spawn],
    });
    const result = buildBaselineRgExecutionEvidence(snapshot, [makeTraceEvent('rg_search', 'ok', 1)]);
    expect(result.status).toBe('EVIDENCE_INCOMPLETE');
    expect(result.reasonCode).toBe('RG_EXECUTION_EVIDENCE_MISSING');
  });
});
