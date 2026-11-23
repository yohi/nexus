import { createHash } from 'node:crypto';
import { realpath, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  runQualityPair,
  collectQualityRouteCoverage,
  classifyCapabilityEvidence,
} from './runner.js';
import { createQualityFixture, createPrimaryLinkedQualityFixture } from './fixtures.js';
import type { QualityCaseManifest, QualityArm, QualityProfile, ObservationKind } from './contracts.js';
import type {
  PairedQualityResult,
  QualityRouteCoverage,
  QualityArmResult,
  GradedDiscoveryEvidence,
} from './scoring.js';
import type { QualityPolicyResult, QualityAdoptionEvent } from './policy.js';
import type { SourceAdoption } from './oracle.js';
import { sanitizedRgArgv, rgExclusions } from './adapters.js';

export interface QualityRate {
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly value: number | null;
  readonly reasonCode: string | null;
}

export interface GateSafetyReport {
  readonly status: 'SAFETY_PASS' | 'SAFETY_FAIL' | 'INCOMPLETE';
  readonly expected: number;
  readonly executed: number;
  readonly requiredCoverageCount: number;
  readonly coveredCoverageCount: number;
  readonly missingCoverageIds: readonly string[];
  readonly outcomeCounts: Readonly<Record<ObservationKind, number>>;
  readonly currentSourceCorrectnessRate: QualityRate;
  readonly symbolIdentityResolutionSuccessRate: QualityRate;
  readonly safeRefusalRate: QualityRate;
  readonly falseRefusalRate: QualityRate;
  readonly falseFreshRate: QualityRate;
  readonly wrongSourceAdoptionRate: QualityRate;
  readonly missingRate: QualityRate;
  readonly unavailableRate: QualityRate;
}

export interface GateDiscoveryReport {
  readonly status: 'MEASURED' | 'NOT_ESTABLISHED' | 'INCOMPLETE';
  readonly evaluatedQueries: number;
  readonly recallK: 10;
  readonly recallEligibleQueries: number;
  readonly mrrEligibleQueries: number;
  readonly recallAtK: number | null;
  readonly mrr: number | null;
  readonly eligibleFileTasks: number;
  readonly eligibleSymbolTasks: number;
  readonly labeledCandidates: number;
  readonly expectedFileDiscoveryRate: number | null;
  readonly expectedSymbolDiscoveryRate: number | null;
  readonly irrelevantCandidateRate: number | null;
  readonly metricReasons: Readonly<Partial<Record<
    'recallAtK' | 'mrr' |
    'expectedFileDiscoveryRate' | 'expectedSymbolDiscoveryRate' |
    'irrelevantCandidateRate',
    string
  >>>;
}

export interface QualityDistribution {
  readonly eligibleCount: number;
  readonly observedCount: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  readonly reasonCode: string | null;
}

export interface QualityFirstCorrectCost {
  readonly toolCalls: QualityDistribution;
  readonly logicalOperations: QualityDistribution;
  readonly contextBytes: QualityDistribution;
  readonly estimatedContextTokens: QualityDistribution;
  readonly elapsedMs: QualityDistribution;
}

export interface QualityArmLoopMetrics {
  readonly expectedTasks: number;
  readonly completedTasks: number;
  readonly failedTasks: number;
  readonly completionRate: QualityRate;
  readonly failureRate: QualityRate;
  readonly wrongSourceAdoptionRate: QualityRate;
  readonly fallbackTaskFrequency: QualityRate;
  readonly firstCorrectSource: QualityFirstCorrectCost;
}

export interface GateAgentLoopReport {
  readonly status: 'MEASURED' | 'INCOMPLETE';
  readonly bothSuccess: number;
  readonly baselineOnly: number;
  readonly nexusOnly: number;
  readonly bothFail: number;
  readonly byArm: Readonly<Record<QualityArm, QualityArmLoopMetrics>>;
  readonly bothSuccessOnlyCost: Readonly<Record<QualityArm, QualityFirstCorrectCost>>;
}

export interface QualityReportMetadata {
  readonly rgVersion: string;
  readonly rgExecutableIdentity: string;
  readonly rgFlags: readonly string[];
  readonly rgExclusions: readonly string[];
  readonly rgSearchScope: '.';
  readonly rgReadMaxBytesPerCall: 4096;
  readonly rgExecutionContractDigest: string;
  readonly recallK: 10;
  readonly nexusCommit: string | null;
  readonly nexusConfigDigest: string;
  readonly nexusToolRegistryDigest: string;
  readonly profile: QualityProfile;
  readonly fixtureVersion: string;
  readonly fixtureDigest: string;
  readonly oracleVersion: string;
  readonly oracleDigest: string;
  readonly manifestDigest: string;
  readonly policyVersion: 'quality-policy-v1';
  readonly nodeVersion: string;
  readonly platform: string;
  readonly tokenizerName: 'cl100k_base';
  readonly tokenizerLibrary: 'js-tiktoken';
  readonly tokenizerVersion: '1.0.21';
  readonly embeddingEvidenceClass: string;
  readonly lspStubVersion: string | null;
  readonly runStartedAt: string;
  readonly runFinishedAt: string;
  readonly semanticEvidence: 'NOT_ESTABLISHED' | 'PINNED_CORPUS';
  readonly lspEvidence: 'NOT_RUN' | 'STUB_ONLY' | 'REAL_SERVER';
}

export type PublicSourceAdoption = Omit<SourceAdoption, 'content'>;

export interface PublicQualityAdoptionEvent extends Omit<QualityAdoptionEvent, 'source'> {
  readonly source: PublicSourceAdoption;
}

export interface PublicQualityPolicyResult extends Omit<QualityPolicyResult, 'adoption' | 'adoptionEvents'> {
  readonly adoption?: PublicSourceAdoption;
  readonly adoptionEvents: readonly PublicQualityAdoptionEvent[];
}

export interface PublicQualityArmResult extends Omit<QualityArmResult, 'policy'> {
  readonly policy: PublicQualityPolicyResult | null;
}

export interface PublicPairedQualityResult extends Omit<PairedQualityResult, 'outcomes'> {
  readonly outcomes: Readonly<Record<QualityArm, PublicQualityArmResult>>;
}

export interface QualityReport {
  readonly schemaVersion: 1;
  readonly metadata: QualityReportMetadata;
  readonly profile: QualityProfile;
  readonly policyVersion: 'quality-policy-v1';
  readonly fixtureDigest: string;
  readonly nexusCommit: string | null;
  readonly rgVersion: string;
  readonly expectedTaskIds: readonly string[];
  readonly missingTaskIds: readonly string[];
  readonly pairs: readonly PublicPairedQualityResult[];
  readonly routeCoverage: readonly QualityRouteCoverage[];
  readonly gate1: GateSafetyReport;
  readonly gate2: Readonly<Record<QualityArm, GateDiscoveryReport>>;
  readonly gate3: GateAgentLoopReport;
  readonly semanticEvidence: 'NOT_ESTABLISHED' | 'PINNED_CORPUS';
  readonly lspEvidence: 'NOT_RUN' | 'STUB_ONLY' | 'REAL_SERVER';
  readonly limitations: readonly string[];
}

export interface QualitySuiteResult {
  readonly suiteId: 'quality-issue320-v1';
  readonly expectedTaskIds: readonly string[];
  readonly reports: Readonly<Record<QualityProfile, QualityReport>>;
  readonly aggregateStatus: 'SAFETY_PASS' | 'SAFETY_FAIL' | 'INCOMPLETE';
  readonly outputPaths: Readonly<{ json: string; markdown: string; sha256sums: string }>;
}

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, Object.keys(value as object).sort());

const digest = (value: unknown): string => sha256(utf8Bytes(canonicalJson(value)));

function redactSourceAdoption(source: SourceAdoption): PublicSourceAdoption {
  return {
    filePath: source.filePath,
    startByte: source.startByte,
    endByte: source.endByte,
    sourceValidation: source.sourceValidation,
  };
}

function redactPolicyResult(policy: QualityPolicyResult): PublicQualityPolicyResult {
  return {
    status: policy.status,
    adoption: policy.adoption === undefined ? undefined : redactSourceAdoption(policy.adoption),
    adoptionEvents: policy.adoptionEvents.map((event) => ({
      sequence: event.sequence,
      source: redactSourceAdoption(event.source),
      cumulativeCost: event.cumulativeCost,
      elapsedMs: event.elapsedMs,
    })),
    navigationEvents: policy.navigationEvents,
    trace: policy.trace,
    logicalOperations: policy.logicalOperations,
    invocations: policy.invocations,
    contextBytes: policy.contextBytes,
    contextTokens: policy.contextTokens,
  };
}

function toPublicPairedResult(pair: PairedQualityResult): PublicPairedQualityResult {
  return {
    taskId: pair.taskId,
    profile: pair.profile,
    rootKey: pair.rootKey,
    fixtureDigest: pair.fixtureDigest,
    policyVersion: pair.policyVersion,
    baselineRgExecution: pair.baselineRgExecution,
    outcomes: {
      R: { ...pair.outcomes.R, policy: pair.outcomes.R.policy === null ? null : redactPolicyResult(pair.outcomes.R.policy) },
      N: { ...pair.outcomes.N, policy: pair.outcomes.N.policy === null ? null : redactPolicyResult(pair.outcomes.N.policy) },
    },
    discovery: pair.discovery,
  };
}

function makeRate(numerator: number | null, denominator: number | null, reasonCode: string | null): QualityRate {
  if (numerator === null || denominator === null) {
    return { numerator, denominator, value: null, reasonCode };
  }
  if (denominator <= 0) {
    return { numerator, denominator, value: null, reasonCode: reasonCode ?? 'ZERO_DENOMINATOR' };
  }
  return { numerator, denominator, value: numerator / denominator, reasonCode };
}

function emptyDistribution(eligibleCount: number, reasonCode: string | null): QualityDistribution {
  return { eligibleCount, observedCount: 0, min: null, median: null, p95: null, max: null, reasonCode };
}

function distribution(values: number[], eligibleCount: number, reasonCode: string | null): QualityDistribution {
  if (values.length === 0) return emptyDistribution(eligibleCount, reasonCode);
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0] ?? null;
  const max = sorted[sorted.length - 1] ?? null;
  const median = sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)] ?? null
    : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95 = sorted[p95Index] ?? null;
  return { eligibleCount, observedCount: values.length, min, median, p95, max, reasonCode };
}

function buildFirstCorrectCost(successes: QualityArmResult[]): QualityFirstCorrectCost {
  const eligibleCount = successes.length;
  if (successes.length === 0) {
    return {
      toolCalls: emptyDistribution(eligibleCount, 'NO_FIRST_CORRECT_SOURCE'),
      logicalOperations: emptyDistribution(eligibleCount, 'NO_FIRST_CORRECT_SOURCE'),
      contextBytes: emptyDistribution(eligibleCount, 'NO_FIRST_CORRECT_SOURCE'),
      estimatedContextTokens: emptyDistribution(eligibleCount, 'NO_FIRST_CORRECT_SOURCE'),
      elapsedMs: emptyDistribution(eligibleCount, 'NO_FIRST_CORRECT_SOURCE'),
    };
  }
  const toolCalls = distribution(successes.map((s) => s.firstCorrectSourceCost?.invocations ?? 0).filter(Number.isFinite), eligibleCount, null);
  const logicalOperations = distribution(successes.map((s) => s.firstCorrectSourceCost?.logicalOperations ?? 0).filter(Number.isFinite), eligibleCount, null);
  const contextBytes = distribution(successes.map((s) => s.firstCorrectSourceCost?.contextBytes ?? 0).filter(Number.isFinite), eligibleCount, null);
  const estimatedContextTokens = distribution(successes.map((s) => s.firstCorrectSourceCost?.contextTokens ?? 0).filter(Number.isFinite), eligibleCount, null);
  const elapsedMs = distribution(successes.map((s) => s.firstCorrectSourceElapsedMs).filter((v): v is number => v !== null && Number.isFinite(v)), eligibleCount, null);
  return { toolCalls, logicalOperations, contextBytes, estimatedContextTokens, elapsedMs };
}

function buildGate1(
  expected: readonly string[],
  pairs: readonly PairedQualityResult[],
  routeCoverage: readonly QualityRouteCoverage[],
): GateSafetyReport {
  const outcomeCounts: Record<ObservationKind, number> = {
    CORRECT_CURRENT: 0,
    CORRECT_REFUSAL: 0,
    FALSE_REFUSAL: 0,
    FALSE_FRESH: 0,
    WRONG_SOURCE: 0,
    MISSING: 0,
    UNAVAILABLE: 0,
    INCONCLUSIVE: 0,
  };

  let executed = 0;
  let safetyFail = false;
  let currentSourceNumerator = 0;
  let currentSourceDenominator = 0;
  let symbolNumerator = 0;
  let symbolDenominator = 0;
  let safeRefusalNumerator = 0;
  let safeRefusalDenominator = 0;
  let falseRefusalNumerator = 0;
  let falseRefusalDenominator = 0;
  let falseFreshNumerator = 0;
  let falseFreshDenominator = 0;
  let wrongSourceNumerator = 0;
  let wrongSourceDenominator = 0;
  let missingNumerator = 0;
  let missingDenominator = 0;
  let unavailableNumerator = 0;
  let unavailableDenominator = 0;

  for (const pair of pairs) {
    for (const arm of ['R', 'N'] as QualityArm[]) {
      const outcome = pair.outcomes[arm];
      if (outcome === undefined) continue;
      if (outcome.observation !== null) {
        executed += 1;
        outcomeCounts[outcome.observation] += 1;
      }
      if (outcome.wrongSourceAdopted) safetyFail = true;

      if (outcome.executionStatus === 'executed') {
        currentSourceDenominator += 1;
        symbolDenominator += 1;
        safeRefusalDenominator += 1;
        falseRefusalDenominator += 1;
        falseFreshDenominator += 1;
        wrongSourceDenominator += 1;
        missingDenominator += 1;
        unavailableDenominator += 1;

        if (outcome.observation === 'CORRECT_CURRENT') currentSourceNumerator += 1;
        if (outcome.observation === 'CORRECT_CURRENT') symbolNumerator += 1;
        if (outcome.observation === 'CORRECT_REFUSAL') safeRefusalNumerator += 1;
        if (outcome.observation === 'FALSE_REFUSAL') falseRefusalNumerator += 1;
        if (outcome.observation === 'FALSE_FRESH') falseFreshNumerator += 1;
        if (outcome.observation === 'WRONG_SOURCE') wrongSourceNumerator += 1;
        if (outcome.observation === 'MISSING') missingNumerator += 1;
        if (outcome.observation === 'UNAVAILABLE') unavailableNumerator += 1;
      }
    }
  }

  const requiredCoverageIds = new Set(routeCoverage.flatMap((r) => r.requiredProbeIds));
  const coveredIds = new Set(
    routeCoverage.flatMap((r) => r.probes.filter((p) => p.status === 'COVERED').map((p) => p.probeId)),
  );
  const allExpectedCovered = expected.every((id) =>
    routeCoverage.some((r) => r.taskId === id && r.status === 'COVERED'),
  );
  const requiredExpectedProbeIds = expected.flatMap((id) =>
    routeCoverage.some((r) => r.taskId === id) ? [] : [id],
  );
  const missingCoverageIds = [
    ...requiredCoverageIds,
    ...requiredExpectedProbeIds,
  ].filter((id) => !coveredIds.has(id));
  const coveredCoverageCount = [...requiredCoverageIds].filter((id) => coveredIds.has(id)).length;

  let status: GateSafetyReport['status'] = 'SAFETY_PASS';
  if (safetyFail) {
    status = 'SAFETY_FAIL';
  } else if (
    missingCoverageIds.length > 0 ||
    pairs.length < expected.length ||
    !allExpectedCovered ||
    requiredExpectedProbeIds.length > 0
  ) {
    status = 'INCOMPLETE';
  }

  return {
    status,
    expected: expected.length,
    executed,
    requiredCoverageCount: requiredCoverageIds.size,
    coveredCoverageCount,
    missingCoverageIds,
    outcomeCounts,
    currentSourceCorrectnessRate: makeRate(currentSourceNumerator, currentSourceDenominator, currentSourceDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    symbolIdentityResolutionSuccessRate: makeRate(symbolNumerator, symbolDenominator, symbolDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    safeRefusalRate: makeRate(safeRefusalNumerator, safeRefusalDenominator, safeRefusalDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    falseRefusalRate: makeRate(falseRefusalNumerator, falseRefusalDenominator, falseRefusalDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    falseFreshRate: makeRate(falseFreshNumerator, falseFreshDenominator, falseFreshDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    wrongSourceAdoptionRate: makeRate(wrongSourceNumerator, wrongSourceDenominator, wrongSourceDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    missingRate: makeRate(missingNumerator, missingDenominator, missingDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
    unavailableRate: makeRate(unavailableNumerator, unavailableDenominator, unavailableDenominator > 0 ? null : 'NO_EXECUTED_TASKS'),
  };
}

function buildGate2Arm(pairs: readonly PairedQualityResult[], arm: QualityArm): GateDiscoveryReport {
  const evaluated: GradedDiscoveryEvidence[] = pairs.map((p) => p.discovery[arm]).filter((d): d is GradedDiscoveryEvidence => d !== undefined);

  let evaluatedQueries = 0;
  let recallEligibleQueries = 0;
  let mrrEligibleQueries = 0;
  let recallSum = 0;
  let mrrSum = 0;
  let eligibleFileTasks = 0;
  let fileFoundCount = 0;
  let eligibleSymbolTasks = 0;
  let symbolFoundCount = 0;
  let labeledCandidates = 0;
  let irrelevantUniqueCandidates = 0;

  const metricReasons: Partial<Record<'recallAtK' | 'mrr' | 'expectedFileDiscoveryRate' | 'expectedSymbolDiscoveryRate' | 'irrelevantCandidateRate', string>> = {};

  for (const ev of evaluated) {
    if (ev.evidenceStatus === 'EVALUATED') {
      evaluatedQueries += 1;
      recallEligibleQueries += 1;
      mrrEligibleQueries += 1;
      recallSum += ev.hitsAtK ?? 0;
      mrrSum += ev.reciprocalRank === null || !Number.isFinite(ev.reciprocalRank) ? 0 : ev.reciprocalRank;
    }
    if (ev.eligibleFileTask) {
      eligibleFileTasks += 1;
      if (ev.fileFound === true) fileFoundCount += 1;
    }
    if (ev.eligibleSymbolTask) {
      eligibleSymbolTasks += 1;
      if (ev.symbolFound === true) symbolFoundCount += 1;
    }
    if (ev.labeledUniqueCandidates !== null) labeledCandidates += ev.labeledUniqueCandidates;
    if (ev.irrelevantUniqueCandidates !== null) irrelevantUniqueCandidates += ev.irrelevantUniqueCandidates;
  }

  const status: GateDiscoveryReport['status'] = evaluatedQueries > 0 ? 'MEASURED' : 'NOT_ESTABLISHED';

  const recallAtK = recallEligibleQueries > 0 ? recallSum / recallEligibleQueries : null;
  const mrr = mrrEligibleQueries > 0 ? mrrSum / mrrEligibleQueries : null;

  if (recallEligibleQueries === 0) metricReasons.recallAtK = 'NO_ELIGIBLE_QUERIES';
  if (mrrEligibleQueries === 0) metricReasons.mrr = 'NO_ELIGIBLE_QUERIES';

  const expectedFileDiscoveryRate = eligibleFileTasks > 0 ? fileFoundCount / eligibleFileTasks : null;
  const expectedSymbolDiscoveryRate = eligibleSymbolTasks > 0 ? symbolFoundCount / eligibleSymbolTasks : null;
  if (eligibleFileTasks === 0) metricReasons.expectedFileDiscoveryRate = 'NO_ELIGIBLE_FILE_TASKS';
  if (eligibleSymbolTasks === 0) metricReasons.expectedSymbolDiscoveryRate = 'NO_ELIGIBLE_SYMBOL_TASKS';

  let irrelevantCandidateRate: number | null = null;
  if (labeledCandidates === 0) {
    metricReasons.irrelevantCandidateRate = 'NO_LABELED_CANDIDATES';
  } else {
    irrelevantCandidateRate = irrelevantUniqueCandidates / labeledCandidates;
  }

  return {
    status,
    evaluatedQueries,
    recallK: 10 as const,
    recallEligibleQueries,
    mrrEligibleQueries,
    recallAtK,
    mrr,
    eligibleFileTasks,
    eligibleSymbolTasks,
    labeledCandidates,
    expectedFileDiscoveryRate,
    expectedSymbolDiscoveryRate,
    irrelevantCandidateRate,
    metricReasons,
  };
}

function buildGate3(expected: readonly string[], pairs: readonly PairedQualityResult[]): GateAgentLoopReport {
  let bothSuccess = 0;
  let baselineOnly = 0;
  let nexusOnly = 0;
  let bothFail = 0;

  const rSuccesses: QualityArmResult[] = [];
  const nSuccesses: QualityArmResult[] = [];
  const rAll: QualityArmResult[] = [];
  const nAll: QualityArmResult[] = [];

  for (const pair of pairs) {
    const r = pair.outcomes.R;
    const n = pair.outcomes.N;
    const rOk = r.correctSourceReached;
    const nOk = n.correctSourceReached;
    if (rOk && nOk) {
      bothSuccess += 1;
      rSuccesses.push(r);
      nSuccesses.push(n);
    } else if (rOk && !nOk) {
      baselineOnly += 1;
    } else if (!rOk && nOk) {
      nexusOnly += 1;
    } else {
      bothFail += 1;
    }
    rAll.push(r);
    nAll.push(n);
  }

  const effectiveExpected = pairs.length;

  function armMetrics(all: QualityArmResult[], successes: QualityArmResult[]): QualityArmLoopMetrics {
    const completedTasks = all.filter((a) => a.correctSourceReached).length;
    const failedTasks = all.filter((a) => a.wrongSourceAdopted || a.observation === 'FALSE_FRESH' || a.observation === 'MISSING').length;
    const wrongAdoptions = all.filter((a) => a.wrongSourceAdopted).length;
    const fallbackTasks = all.filter((a) => a.policy !== null && a.policy.trace.some((t) => t.fallback)).length;
    return {
      expectedTasks: effectiveExpected,
      completedTasks,
      failedTasks,
      completionRate: makeRate(completedTasks, effectiveExpected, effectiveExpected > 0 ? null : 'NO_PAIRS'),
      failureRate: makeRate(failedTasks, effectiveExpected, effectiveExpected > 0 ? null : 'NO_PAIRS'),
      wrongSourceAdoptionRate: makeRate(wrongAdoptions, effectiveExpected, effectiveExpected > 0 ? null : 'NO_PAIRS'),
      fallbackTaskFrequency: makeRate(fallbackTasks, effectiveExpected, effectiveExpected > 0 ? null : 'NO_PAIRS'),
      firstCorrectSource: buildFirstCorrectCost(successes),
    };
  }

  return {
    status: pairs.length > 0 ? 'MEASURED' : 'INCOMPLETE',
    bothSuccess,
    baselineOnly,
    nexusOnly,
    bothFail,
    byArm: {
      R: armMetrics(rAll, rSuccesses),
      N: armMetrics(nAll, nSuccesses),
    },
    bothSuccessOnlyCost: {
      R: buildFirstCorrectCost(rSuccesses),
      N: buildFirstCorrectCost(nSuccesses),
    },
  };
}

function validateMetadata(metadata: QualityReportMetadata): string[] {
  const issues: string[] = [];
  if (metadata.rgExclusions.length !== 6) issues.push('RG_EXCLUSIONS_COUNT_MISMATCH');
  if (metadata.rgSearchScope !== '.') issues.push('RG_SCOPE_MISMATCH');
  if (metadata.rgReadMaxBytesPerCall !== 4096) issues.push('RG_READ_BYTES_MISMATCH');
  if (metadata.recallK !== 10) issues.push('RECALL_K_MISMATCH');
  if (metadata.policyVersion !== 'quality-policy-v1') issues.push('POLICY_VERSION_MISMATCH');
  if (metadata.tokenizerName !== 'cl100k_base') issues.push('TOKENIZER_NAME_MISMATCH');
  if (metadata.tokenizerLibrary !== 'js-tiktoken') issues.push('TOKENIZER_LIBRARY_MISMATCH');
  if (metadata.tokenizerVersion !== '1.0.21') issues.push('TOKENIZER_VERSION_MISMATCH');
  return issues;
}

export function buildQualityReport(
  expected: readonly string[],
  pairs: readonly PairedQualityResult[],
  routeCoverage: readonly QualityRouteCoverage[],
  metadata: QualityReportMetadata,
): QualityReport {
  const metadataIssues = validateMetadata(metadata);
  const publicPairs = pairs.map(toPublicPairedResult);
  const missingTaskIds = expected.filter((id) => !pairs.some((p) => p.taskId === id));
  const fixtureDigest = metadata.fixtureDigest;

  const gate1 = buildGate1(expected, pairs, routeCoverage);
  const gate2R = buildGate2Arm(pairs, 'R');
  const gate2N = buildGate2Arm(pairs, 'N');
  const gate3 = buildGate3(expected, pairs);

  const limitations: string[] = [...metadataIssues];
  if (missingTaskIds.length > 0) limitations.push(`MISSING_TASKS:${missingTaskIds.join(',')}`);
  if (metadata.semanticEvidence === 'NOT_ESTABLISHED') limitations.push('SEMANTIC_RELEVANCE_NOT_ESTABLISHED');
  if (metadata.lspEvidence === 'NOT_RUN') limitations.push('REAL_LSP_NOT_RUN');

  return {
    schemaVersion: 1,
    metadata,
    profile: metadata.profile,
    policyVersion: metadata.policyVersion,
    fixtureDigest,
    nexusCommit: metadata.nexusCommit,
    rgVersion: metadata.rgVersion,
    expectedTaskIds: [...expected],
    missingTaskIds: [...missingTaskIds],
    pairs: publicPairs,
    routeCoverage: [...routeCoverage],
    gate1,
    gate2: { R: gate2R, N: gate2N },
    gate3,
    semanticEvidence: metadata.semanticEvidence,
    lspEvidence: metadata.lspEvidence,
    limitations,
  };
}

export function renderQualityMarkdown(report: QualityReport): string {
  const lines: string[] = [
    `# Retrieval Quality Benchmark Report — ${report.profile}`,
    '',
    `- Profile: \`${report.profile}\``,
    `- Policy version: \`${report.policyVersion}\``,
    `- Fixture digest: \`${report.fixtureDigest}\``,
    `- Nexus commit: \`${report.nexusCommit ?? 'unknown'}\``,
    `- rg version: \`${report.rgVersion}\``,
    `- Run: ${report.metadata.runStartedAt} → ${report.metadata.runFinishedAt}`,
    '',
    '## Expected tasks',
    '',
    report.expectedTaskIds.map((id) => `- ${id}`).join('\n'),
    '',
  ];

  if (report.missingTaskIds.length > 0) {
    lines.push('## Missing tasks', '', report.missingTaskIds.map((id) => `- ${id}`).join('\n'), '');
  }

  lines.push(
    '## Gate 1 — Safety',
    '',
    `- Status: **${report.gate1.status}**`,
    `- Expected: ${report.gate1.expected}, executed: ${report.gate1.executed}`,
    `- Coverage: ${report.gate1.coveredCoverageCount}/${report.gate1.requiredCoverageCount}`,
    `- Missing coverage: ${report.gate1.missingCoverageIds.length > 0 ? report.gate1.missingCoverageIds.join(', ') : 'none'}`,
    '',
    '### Outcome counts',
    '',
    Object.entries(report.gate1.outcomeCounts).map(([kind, count]) => `- ${kind}: ${count}`).join('\n'),
    '',
    '### Rates',
    '',
    `- Current-source correctness: ${rateText(report.gate1.currentSourceCorrectnessRate)}`,
    `- Symbol identity resolution: ${rateText(report.gate1.symbolIdentityResolutionSuccessRate)}`,
    `- Safe refusal: ${rateText(report.gate1.safeRefusalRate)}`,
    `- False refusal: ${rateText(report.gate1.falseRefusalRate)}`,
    `- False fresh: ${rateText(report.gate1.falseFreshRate)}`,
    `- Wrong source: ${rateText(report.gate1.wrongSourceAdoptionRate)}`,
    `- Missing: ${rateText(report.gate1.missingRate)}`,
    `- Unavailable: ${rateText(report.gate1.unavailableRate)}`,
    '',
    '## Gate 2 — Discovery',
    '',
  );

  for (const arm of ['R', 'N'] as QualityArm[]) {
    const g = report.gate2[arm];
    lines.push(
      `### ${arm} arm`,
      '',
      `- Status: ${g.status}`,
      `- Evaluated queries: ${g.evaluatedQueries}`,
      `- Recall@${g.recallK}: ${g.recallAtK === null ? 'N/A' : g.recallAtK.toFixed(4)}`,
      `- MRR: ${g.mrr === null ? 'N/A' : g.mrr.toFixed(4)}`,
      `- File discovery: ${g.expectedFileDiscoveryRate === null ? 'N/A' : g.expectedFileDiscoveryRate.toFixed(4)}`,
      `- Symbol discovery: ${g.expectedSymbolDiscoveryRate === null ? 'N/A' : g.expectedSymbolDiscoveryRate.toFixed(4)}`,
      `- Irrelevant candidate rate: ${g.irrelevantCandidateRate === null ? 'N/A' : g.irrelevantCandidateRate.toFixed(4)}`,
      '',
    );
  }

  lines.push(
    '## Gate 3 — Agent loop',
    '',
    `- Status: ${report.gate3.status}`,
    `- Both success: ${report.gate3.bothSuccess}`,
    `- Baseline only: ${report.gate3.baselineOnly}`,
    `- Nexus only: ${report.gate3.nexusOnly}`,
    `- Both fail: ${report.gate3.bothFail}`,
    '',
    '## Limitations',
    '',
    report.limitations.length > 0 ? report.limitations.map((l) => `- ${l}`).join('\n') : '- None',
    '',
  );

  return lines.join('\n');
}

function rateText(rate: QualityRate): string {
  if (rate.value === null) return `N/A (${rate.reasonCode ?? 'no data'})`;
  return `${rate.value.toFixed(4)} (${rate.numerator}/${rate.denominator})`;
}

function rgExecutableIdentity(rgExecutable: string, rgVersion: string): string {
  return digest({ name: rgExecutable.split(/[\\/]/).pop() ?? rgExecutable, version: rgVersion });
}

export async function runQualitySuite(options: Readonly<{
  suiteId: 'quality-issue320-v1';
  outputRoot: string;
  rgExecutable: string;
  signal: AbortSignal;
}>): Promise<QualitySuiteResult> {
  if (options.suiteId !== 'quality-issue320-v1') throw new Error('unsupported_suite_id');

  const resolvedOutputRoot = await realpath(resolve(options.outputRoot)).catch(() => null);
  if (resolvedOutputRoot === null) throw new Error('output_root_not_resolved');
  const tmpRoot = await realpath('/tmp').catch(() => null);
  const varTmpRoot = await realpath('/var/tmp').catch(() => null);
  if (
    resolvedOutputRoot !== tmpRoot &&
    resolvedOutputRoot !== varTmpRoot &&
    !resolvedOutputRoot.startsWith(`${tmpRoot ?? '/tmp'}/`) &&
    !resolvedOutputRoot.startsWith(`${varTmpRoot ?? '/var/tmp'}/`)
  ) {
    throw new Error('output_root_not_in_temp');
  }

  const coreTaskIds = [
    'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q14',
  ] as const;
  const expectedTaskIds: readonly string[] = [
    ...coreTaskIds,
    'Q12-primary', 'Q12-linked',
    'Q13-definition', 'Q13-references', 'Q13-implementations',
  ];

  const startedAt = new Date().toISOString();

  const coreFixture = await createQualityFixture(coreTaskIds.map((id) => `${id}@quality-v1`), options.signal);
  const primaryLinkedFixture = await createPrimaryLinkedQualityFixture(options.signal);
  const lspFixture = await createQualityFixture(['Q13@quality-v1'], options.signal);

  const taskManifests = new Map<string, QualityCaseManifest>();
  for (const task of coreFixture.oracleCases) taskManifests.set(task.taskId, task);
  for (const task of primaryLinkedFixture.oracleCases) taskManifests.set(task.taskId, task);
  for (const task of lspFixture.oracleCases) taskManifests.set(task.taskId, task);

  const pairs: PairedQualityResult[] = [];
  const coverage: QualityRouteCoverage[] = [];
  const missing: string[] = [];

  for (const taskId of expectedTaskIds) {
    const task = taskManifests.get(taskId);
    if (task === undefined) {
      missing.push(taskId);
      continue;
    }
    const fixture = taskId.startsWith('Q12')
      ? primaryLinkedFixture
      : taskId.startsWith('Q13')
        ? lspFixture
        : coreFixture;
    try {
      const pair = await runQualityPair(task, fixture, { signal: options.signal, rgExecutable: options.rgExecutable });
      pairs.push(pair);
    } catch {
      missing.push(taskId);
    }
    try {
      const routeCoverage = await collectQualityRouteCoverage(task, fixture, { signal: options.signal });
      coverage.push(...routeCoverage);
    } catch {
      // Coverage failures remain incomplete in report.
    }
  }

  const rgVersion = options.rgExecutable;
  const rgExecutableIdentityValue = rgExecutableIdentity(options.rgExecutable, rgVersion);
  const rgFlags = [...sanitizedRgArgv('<public-query>')];
  const rgExclusionsList = [...rgExclusions];
  const rgExecutionContractDigest = digest({ argv: rgFlags, rootKey: 'single', searchScope: '.', readMaxBytesPerCall: 4096, policyVersion: 'quality-policy-v1' });

  const commonMetadataBase = {
    rgVersion,
    rgExecutableIdentity: rgExecutableIdentityValue,
    rgFlags,
    rgExclusions: rgExclusionsList,
    rgSearchScope: '.' as const,
    rgReadMaxBytesPerCall: 4096 as const,
    rgExecutionContractDigest,
    recallK: 10 as const,
    nexusCommit: null,
    nexusConfigDigest: digest({}),
    nexusToolRegistryDigest: digest({}),
    fixtureVersion: 'quality-v1',
    oracleVersion: 'quality-v1',
    policyVersion: 'quality-policy-v1' as const,
    nodeVersion: process.version,
    platform: process.platform,
    tokenizerName: 'cl100k_base' as const,
    tokenizerLibrary: 'js-tiktoken' as const,
    tokenizerVersion: '1.0.21' as const,
    embeddingEvidenceClass: classifyCapabilityEvidence({ route: 'synthetic', executed: true, ownerApproved: false }),
    lspStubVersion: 'quality-lsp-stub-v1',
    runStartedAt: startedAt,
    runFinishedAt: new Date().toISOString(),
    semanticEvidence: 'NOT_ESTABLISHED' as const,
    lspEvidence: 'STUB_ONLY' as const,
  };

  const grouped = new Map<QualityProfile, PairedQualityResult[]>();
  for (const pair of pairs) {
    const list = grouped.get(pair.profile) ?? [];
    list.push(pair);
    grouped.set(pair.profile, list);
  }

  const routeByProfile = new Map<QualityProfile, QualityRouteCoverage[]>();
  for (const route of coverage) {
    const task = taskManifests.get(route.taskId);
    if (task === undefined) continue;
    const profile: QualityProfile = task.evaluationEligibility === 'conditional_worktree'
      ? 'quality-worktree-v1'
      : task.evaluationEligibility === 'conditional_lsp'
        ? 'quality-lsp-v1'
        : 'quality-core-v1';
    const list = routeByProfile.get(profile) ?? [];
    list.push(route);
    routeByProfile.set(profile, list);
  }

  const reports: Partial<Record<QualityProfile, QualityReport>> = {};
  for (const [profile, profilePairs] of grouped) {
    const profileCoverage = routeByProfile.get(profile) ?? [];
    const fixtureDigest = profilePairs[0]?.fixtureDigest ?? digest({ profile });
    const manifestDigest = digest({ expected: expectedTaskIds });
    const oracleDigest = digest({ expected: expectedTaskIds });
    const metadata: QualityReportMetadata = {
      ...commonMetadataBase,
      profile,
      fixtureDigest,
      oracleDigest,
      manifestDigest,
    };
    reports[profile] = buildQualityReport(expectedTaskIds, profilePairs, profileCoverage, metadata);
  }

  for (const profile of ['quality-core-v1', 'quality-worktree-v1', 'quality-lsp-v1'] as QualityProfile[]) {
    if (reports[profile] === undefined) {
      const metadata: QualityReportMetadata = {
        ...commonMetadataBase,
        profile,
        fixtureDigest: digest({ profile }),
        oracleDigest: digest({ profile }),
        manifestDigest: digest({ profile }),
      };
      reports[profile] = buildQualityReport(expectedTaskIds, [], [], metadata);
    }
  }

  let aggregateStatus: QualitySuiteResult['aggregateStatus'] = 'SAFETY_PASS';
  for (const report of Object.values(reports)) {
    if (report === undefined) continue;
    if (report.gate1.status === 'SAFETY_FAIL') aggregateStatus = 'SAFETY_FAIL';
    else if (aggregateStatus !== 'SAFETY_FAIL' && report.gate1.status === 'INCOMPLETE') aggregateStatus = 'INCOMPLETE';
  }

  await mkdir(resolvedOutputRoot, { recursive: true });
  const jsonPath = join(resolvedOutputRoot, `${options.suiteId}.json`);
  const mdPath = join(resolvedOutputRoot, `${options.suiteId}.md`);
  const shaPath = join(resolvedOutputRoot, 'SHA256SUMS');

  const suiteResult: QualitySuiteResult = {
    suiteId: options.suiteId,
    expectedTaskIds: [...expectedTaskIds],
    reports: reports as Record<QualityProfile, QualityReport>,
    aggregateStatus,
    outputPaths: { json: jsonPath, markdown: mdPath, sha256sums: shaPath },
  };

  const jsonBytes = utf8Bytes(JSON.stringify(suiteResult, null, 2));
  await writeFile(jsonPath, jsonBytes);
  const mdContent = Object.values(reports).map((r) => r === undefined ? '' : renderQualityMarkdown(r)).join('\n---\n');
  const mdBytes = utf8Bytes(mdContent);
  await writeFile(mdPath, mdBytes);
  const sums = [
    `${sha256(jsonBytes)}  ${options.suiteId}.json`,
    `${sha256(mdBytes)}  ${options.suiteId}.md`,
  ].join('\n') + '\n';
  await writeFile(shaPath, sums);

  return suiteResult;
}
