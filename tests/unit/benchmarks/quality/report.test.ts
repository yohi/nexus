import { describe, it, expect } from 'vitest';
import { buildQualityReport, renderQualityMarkdown } from '../../../benchmarks/quality/report.js';
import type { QualityReportMetadata } from '../../../benchmarks/quality/report.js';
import type { PairedQualityResult, QualityRouteCoverage } from '../../../benchmarks/quality/scoring.js';

const baseMetadata: QualityReportMetadata = {
  rgVersion: '13.0.0',
  rgExecutableIdentity: 'abc',
  rgFlags: Object.freeze([]),
  rgExclusions: Object.freeze(['!.git/**', '!**/.git/**', '!node_modules/**', '!**/node_modules/**', '!.nexus/**', '!**/.nexus/**']),
  rgSearchScope: '.',
  rgReadMaxBytesPerCall: 4096,
  rgExecutionContractDigest: 'rg-contract',
  recallK: 10,
  nexusCommit: null,
  nexusConfigDigest: 'config',
  nexusToolRegistryDigest: 'registry',
  profile: 'quality-core-v1',
  fixtureVersion: 'quality-v1',
  fixtureDigest: 'fixture',
  oracleVersion: 'quality-v1',
  oracleDigest: 'oracle',
  manifestDigest: 'manifest',
  policyVersion: 'quality-policy-v1',
  nodeVersion: 'v24',
  platform: 'linux',
  tokenizerName: 'cl100k_base',
  tokenizerLibrary: 'js-tiktoken',
  tokenizerVersion: '1.0.21',
  embeddingEvidenceClass: 'FUNCTIONAL_ONLY',
  lspStubVersion: 'quality-lsp-stub-v1',
  runStartedAt: new Date().toISOString(),
  runFinishedAt: new Date().toISOString(),
  semanticEvidence: 'NOT_ESTABLISHED',
  lspEvidence: 'NOT_RUN',
};

function makePair(overrides: Partial<PairedQualityResult> = {}): PairedQualityResult {
  const armResult = {
    executionStatus: 'executed' as const,
    observation: 'CORRECT_CURRENT' as const,
    policy: null,
    adoptionHistory: Object.freeze([]),
    firstCorrectSourceCost: Object.freeze({ logicalOperations: 1, invocations: 1, contextBytes: 100, contextTokens: 20 }),
    firstCorrectSourceElapsedMs: 12,
    firstCorrectSourceElapsedReason: null,
    correctSourceReached: true,
    wrongSourceAdopted: false,
  };
  const discovery = Object.freeze({
    evidenceStatus: 'EVALUATED' as const,
    candidateEvidenceDigest: null,
    observedCandidateCount: 1,
    eligibleFileTask: true,
    fileFound: true,
    eligibleSymbolTask: true,
    symbolFound: true,
    labeledUniqueCandidates: 1,
    irrelevantUniqueCandidates: 0,
    expectedRelevantTargets: 1,
    hitsAtK: 1,
    reciprocalRank: 1,
  });
  return Object.freeze({
    taskId: 'Q01',
    profile: 'quality-core-v1' as const,
    rootKey: 'single' as const,
    fixtureDigest: 'fixture',
    armFixtureDigests: Object.freeze({ R: 'fixture-r', N: 'fixture-n' }),
    policyVersion: 'quality-policy-v1' as const,
    baselineRgExecution: Object.freeze({
      initializedContractDigest: 'rg-contract',
      spawnAttemptCount: 0,
      observedSpawns: Object.freeze([]),
      traceComplete: true,
      status: 'NOT_INVOKED' as const,
      invocationCount: 0,
      baselineExecutionContractDigest: null,
      reasonCode: null,
    }),
    outcomes: Object.freeze({ R: armResult, N: armResult }),
    discovery: Object.freeze({ R: discovery, N: discovery }),
    ...overrides,
  }) as PairedQualityResult;
}

function makeRoute(taskId: string): QualityRouteCoverage {
  return Object.freeze({
    taskId,
    scenarioId: `${taskId}@quality-v1`,
    rootKey: 'single' as const,
    requiredProbeIds: Object.freeze([`${taskId}-index_status`]),
    probes: Object.freeze([{
      probeId: `${taskId}-index_status`,
      taskId,
      rootKey: 'single' as const,
      tool: 'index_status' as const,
      expectedAction: 'capability_status' as const,
      publicArgsDigest: null,
      traceSequence: 1,
      observedStatus: 'ok' as const,
      reasonCode: null,
      oracleVerdict: null,
      setupProofDigest: 'setup-digest',
      publicationSnapshotDigest: null,
      resultDigest: null,
      locationSetDigest: null,
      status: 'COVERED' as const,
    }]),
    probeTrace: Object.freeze([]),
    setupProofDigest: 'setup',
    status: 'COVERED' as const,
  });
}

describe('buildQualityReport', () => {
  it('builds a report with all required Gate 1/2/3 fields', () => {
    const pair = makePair();
    const route = makeRoute('Q01');
    const report = buildQualityReport(['Q01'], [pair], [route], baseMetadata);

    expect(report.schemaVersion).toBe(2);
    expect(report.profile).toBe('quality-core-v1');
    expect(report.gate1.status).toBe('SAFETY_PASS');
    expect(report.gate1.expected).toBe(1);
    expect(report.gate1.executed).toBe(2);
    expect(report.gate2.R.status).toBe('MEASURED');
    expect(report.gate3.status).toBe('MEASURED');
    expect(report.gate3.bothSuccess).toBe(1);
    expect(report.pairs.length).toBe(1);
    expect(report.limitations).not.toContain('RG_EXCLUSIONS_COUNT_MISMATCH');
  });

  it('marks INCOMPLETE when coverage is missing', () => {
    const pair = makePair();
    const report = buildQualityReport(['Q01'], [pair], [], baseMetadata);
    expect(report.gate1.status).toBe('INCOMPLETE');
    expect(report.gate1.missingCoverageIds.length).toBeGreaterThan(0);
  });

  it('marks SAFETY_FAIL on wrong source adoption', () => {
    const pair = makePair({
      outcomes: Object.freeze({
        R: { ...makePair().outcomes.R, observation: 'WRONG_SOURCE' as const, correctSourceReached: false, wrongSourceAdopted: true },
        N: makePair().outcomes.N,
      }),
    });
    const route = makeRoute('Q01');
    const report = buildQualityReport(['Q01'], [pair], [route], baseMetadata);
    expect(report.gate1.status).toBe('SAFETY_FAIL');
  });

  it('marks Gate 1 incomplete when an arm was not executed', () => {
    const pair = makePair({
      outcomes: Object.freeze({
        R: { ...makePair().outcomes.R, executionStatus: 'not_run' as const },
        N: makePair().outcomes.N,
      }),
    });
    const report = buildQualityReport(['Q01'], [pair], [makeRoute('Q01')], baseMetadata);
    expect(report.gate1.status).toBe('INCOMPLETE');
  });

  it.each(['FALSE_FRESH', 'WRONG_SOURCE'] as const)(
    'marks Gate 1 safety-failed for an unsafe required probe verdict: %s',
    (oracleVerdict) => {
      const route = makeRoute('Q01');
      const incompleteRoute: QualityRouteCoverage = {
        ...route,
        status: 'INCOMPLETE',
        probes: route.probes.map((probe) => ({
          ...probe,
          oracleVerdict,
          status: 'INCOMPLETE',
        })),
      };
      const report = buildQualityReport(['Q01'], [makePair()], [incompleteRoute], baseMetadata);

      expect(report.gate1.status).toBe('SAFETY_FAIL');
      expect(report.gate1.missingCoverageIds).toContain('Q01-index_status');
    },
  );

  it('uses required task count for Gate 3 denominator and incomplete status', () => {
    const report = buildQualityReport(['Q01', 'Q02'], [makePair()], [makeRoute('Q01')], baseMetadata);
    expect(report.gate3.status).toBe('INCOMPLETE');
    expect(report.gate3.byArm.R.expectedTasks).toBe(2);
    expect(report.gate3.byArm.R.completionRate.value).toBe(0.5);
  });

  it('publishes both arm fixture digests', () => {
    const report = buildQualityReport(['Q01'], [makePair()], [makeRoute('Q01')], baseMetadata);
    expect(report.pairs[0]?.armFixtureDigests).toEqual({ R: 'fixture-r', N: 'fixture-n' });
  });

  it('includes single-arm successes in each arm first-correct-source cost', () => {
    const basePair = makePair();
    const baselineOnly = makePair({
      outcomes: Object.freeze({
        R: {
          ...basePair.outcomes.R,
          firstCorrectSourceCost: { logicalOperations: 1, invocations: 2, contextBytes: 100, contextTokens: 20 },
        },
        N: { ...basePair.outcomes.N, observation: 'MISSING' as const, correctSourceReached: false },
      }),
    });
    const nexusOnly = makePair({
      taskId: 'Q02',
      outcomes: Object.freeze({
        R: { ...basePair.outcomes.R, observation: 'MISSING' as const, correctSourceReached: false },
        N: {
          ...basePair.outcomes.N,
          firstCorrectSourceCost: { logicalOperations: 1, invocations: 3, contextBytes: 100, contextTokens: 20 },
        },
      }),
    });
    const report = buildQualityReport(
      ['Q01', 'Q02'],
      [baselineOnly, nexusOnly],
      [makeRoute('Q01'), makeRoute('Q02')],
      baseMetadata,
    );

    expect(report.gate3.byArm.R.firstCorrectSource.toolCalls).toMatchObject({ eligibleCount: 1, min: 2 });
    expect(report.gate3.byArm.N.firstCorrectSource.toolCalls).toMatchObject({ eligibleCount: 1, min: 3 });
    expect(report.gate3.bothSuccessOnlyCost.R.toolCalls.eligibleCount).toBe(0);
    expect(report.gate3.bothSuccessOnlyCost.N.toolCalls.eligibleCount).toBe(0);
  });

  it('redacts source content in public pairs', () => {
    const armResult = {
      executionStatus: 'executed' as const,
      observation: 'CORRECT_CURRENT' as const,
      policy: {
        status: 'COMPLETE' as const,
        adoption: { filePath: 'a.ts', startByte: 0, endByte: 10, content: 'secret source', sourceValidation: 'verified' as const },
        adoptionEvents: Object.freeze([]),
        navigationEvents: Object.freeze([]),
        trace: Object.freeze([]),
        logicalOperations: 1,
        invocations: 1,
        contextBytes: 10,
        contextTokens: 2,
      },
      adoptionHistory: Object.freeze([]),
      firstCorrectSourceCost: Object.freeze({ logicalOperations: 1, invocations: 1, contextBytes: 10, contextTokens: 2 }),
      firstCorrectSourceElapsedMs: 5,
      firstCorrectSourceElapsedReason: null,
      correctSourceReached: true,
      wrongSourceAdopted: false,
    };
    const pair = makePair({ outcomes: Object.freeze({ R: armResult, N: armResult }) });
    const route = makeRoute('Q01');
    const report = buildQualityReport(['Q01'], [pair], [route], baseMetadata);
    const publicPolicy = report.pairs[0]?.outcomes.R.policy;
    expect(publicPolicy?.adoption).not.toHaveProperty('content');
    expect(JSON.stringify(report)).not.toContain('secret source');
  });

  it('renders markdown without source text or absolute paths', () => {
    const pair = makePair();
    const route = makeRoute('Q01');
    const report = buildQualityReport(['Q01'], [pair], [route], baseMetadata);
    const markdown = renderQualityMarkdown(report);
    expect(markdown).toContain('Gate 1');
    expect(markdown).toContain('SAFETY_PASS');
    expect(markdown).not.toContain('secret');
    expect(markdown).not.toContain('/home/');
  });

  it('states that LSP results are stub-only and distinguishes unbounded Recall from ranked MRR', () => {
    const report = buildQualityReport(
      ['Q13-definition'],
      [],
      [],
      { ...baseMetadata, profile: 'quality-lsp-v1', lspEvidence: 'STUB_ONLY' },
    );
    const markdown = renderQualityMarkdown(report);

    expect(markdown).toContain('LSP evidence: STUB_ONLY');
    expect(markdown).toContain('Q13 uses a stub adapter; it is not a real LSP validation.');
    expect(markdown).toContain('Recall (unique related candidates; no rank limit)');
    expect(markdown).toContain('MRR uses ranked adoption evidence.');
    expect(markdown).toContain('Unranked relevant hits count as 0 in MRR.');
  });

  it('escapes pipe characters and line breaks in reason-code table cells', () => {
    const route = {
      ...makeRoute('Q01'),
      probes: [{
        ...makeRoute('Q01').probes[0]!,
        reasonCode: 'PRIVATE|DETAIL\nSECOND LINE',
      }],
    } as QualityRouteCoverage;
    const report = buildQualityReport(['Q01'], [makePair()], [route], baseMetadata);
    const markdown = renderQualityMarkdown(report);

    expect(markdown).toContain('PRIVATE\\|DETAIL<br>SECOND LINE');
    expect(markdown).not.toContain('PRIVATE|DETAIL\nSECOND LINE');
  });

  it('reports zero-candidate evaluated query with known golden as measured zero rates', () => {
    const discovery = Object.freeze({
      evidenceStatus: 'EVALUATED' as const,
      candidateEvidenceDigest: null,
      observedCandidateCount: 0,
      eligibleFileTask: true,
      fileFound: false,
      eligibleSymbolTask: true,
      symbolFound: false,
      labeledUniqueCandidates: 0,
      irrelevantUniqueCandidates: 0,
      expectedRelevantTargets: 2,
      hitsAtK: 0,
      reciprocalRank: 0,
    });
    const pair = makePair({ discovery: Object.freeze({ R: discovery, N: discovery }) });
    const route = makeRoute('Q01');
    const report = buildQualityReport(['Q01'], [pair], [route], baseMetadata);
    expect(report.gate2.R.status).toBe('MEASURED');
    expect(report.gate2.R.recallAtK).toBe(0);
    expect(report.gate2.R.mrr).toBe(0);
    expect(report.gate2.R.expectedFileDiscoveryRate).toBe(0);
    expect(report.gate2.R.expectedSymbolDiscoveryRate).toBe(0);
    expect(report.gate2.R.irrelevantCandidateRate).toBeNull();
    expect(report.gate2.R.metricReasons.irrelevantCandidateRate).toBe('NO_LABELED_CANDIDATES');
  });

  it('averages per-query Recall@10 ratios and excludes queries with no relevant targets', () => {
    const relevant = Object.freeze({
      ...makePair().discovery.R,
      expectedRelevantTargets: 2,
      hitsAtK: 1,
    });
    const noRelevantTargets = Object.freeze({
      ...makePair().discovery.R,
      expectedRelevantTargets: 0,
      hitsAtK: 0,
    });
    const report = buildQualityReport(
      ['Q01', 'Q02'],
      [
        makePair({ discovery: Object.freeze({ R: relevant, N: relevant }) }),
        makePair({ taskId: 'Q02', discovery: Object.freeze({ R: noRelevantTargets, N: noRelevantTargets }) }),
      ],
      [makeRoute('Q01'), makeRoute('Q02')],
      baseMetadata,
    );
    expect(report.gate2.R.recallAtK).toBe(0.5);
    expect(report.gate2.R.recallEligibleQueries).toBe(1);
  });

  it('validates metadata and records issues in limitations', () => {
    const badMetadata = { ...baseMetadata, rgExclusions: Object.freeze([]) };
    const pair = makePair();
    const route = makeRoute('Q01');
    const report = buildQualityReport(['Q01'], [pair], [route], badMetadata);
    expect(report.limitations).toContain('RG_EXCLUSIONS_COUNT_MISMATCH');
  });
});
