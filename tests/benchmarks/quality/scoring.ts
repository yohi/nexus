import { createHash } from 'node:crypto';
import type { QualityArm, QualityCaseManifest, ObservationKind, QualityExecutionStatus } from './contracts.js';
import type { QualityTool } from './adapters.js';
import type { QualityCumulativeCost, QualityPolicyResult, QualityTraceEvent } from './policy.js';
import { gradeTaskSource, checkSourceFreshness } from './oracle.js';
import type { SourceAdoption, SourceProvenance, SourceSnapshot } from './oracle.js';

export interface QualityPublicationEvidence {
  readonly adoptionSequence: number;
  readonly snapshot: SourceSnapshot;
  readonly provenance: SourceProvenance;
  readonly snapshotCapturedAtPublication: true;
}

export interface GradedQualityAdoption {
  readonly sequence: number;
  readonly observation: ObservationKind;
  readonly publicationSnapshotDigest: string | null;
  readonly cumulativeCost: QualityCumulativeCost;
  readonly elapsedMs: number | null;
}

export interface QualityArmResult {
  readonly executionStatus: QualityExecutionStatus;
  readonly observation: ObservationKind | null;
  readonly policy: QualityPolicyResult | null;
  readonly adoptionHistory: readonly GradedQualityAdoption[];
  readonly firstCorrectSourceCost: QualityCumulativeCost | null;
  readonly firstCorrectSourceElapsedMs: number | null;
  readonly firstCorrectSourceElapsedReason:
    | 'NOT_REACHED'
    | 'NOT_RUN'
    | 'SETUP_INCOMPLETE'
    | 'BLOCKED'
    | 'INCONCLUSIVE'
    | 'TIMING_MISSING'
    | null;
  readonly correctSourceReached: boolean;
  readonly wrongSourceAdopted: boolean;
  readonly reasonCode?: string;
}

export interface GradedDiscoveryEvidence {
  readonly evidenceStatus: 'EVALUATED' | 'NOT_ESTABLISHED' | 'INCOMPLETE';
  readonly candidateEvidenceDigest: string | null;
  readonly observedCandidateCount: number | null;
  readonly eligibleFileTask: boolean;
  readonly fileFound: boolean | null;
  readonly eligibleSymbolTask: boolean;
  readonly symbolFound: boolean | null;
  readonly labeledUniqueCandidates: number | null;
  readonly irrelevantUniqueCandidates: number | null;
  readonly expectedRelevantTargets: number | null;
  readonly hitsAtK: number | null;
  readonly reciprocalRank: number | null;
  readonly reasonCode?: string;
}

export interface BaselineRgEvidenceCommon {
  readonly initializedContractDigest: string;
  readonly spawnAttemptCount: number | null;
  readonly observedSpawns: readonly import('./adapters.js').RgSpawnObservation[];
  readonly traceComplete: boolean;
}

export type BaselineRgExecutionEvidence = BaselineRgEvidenceCommon & (
  | Readonly<{
      status: 'NOT_INVOKED';
      invocationCount: 0;
      baselineExecutionContractDigest: null;
      reasonCode: null;
    }>
  | Readonly<{
      status: 'INVOKED_VERIFIED';
      invocationCount: number;
      baselineExecutionContractDigest: string;
      reasonCode: null;
    }>
  | Readonly<{
      status: 'EVIDENCE_INCOMPLETE';
      invocationCount: number | null;
      baselineExecutionContractDigest: string | null;
      reasonCode:
        | 'RG_EXECUTION_EVIDENCE_MISSING'
        | 'RG_CONTRACT_MISMATCH'
        | 'RG_INVOCATION_STATUS_UNKNOWN';
    }>
);

export interface PairedQualityResult {
  readonly taskId: string;
  readonly profile: import('./contracts.js').QualityProfile;
  readonly rootKey: import('./contracts.js').QualityRootKey;
  readonly fixtureDigest: string;
  readonly policyVersion: 'quality-policy-v1';
  readonly baselineRgExecution: BaselineRgExecutionEvidence;
  readonly outcomes: Readonly<Record<QualityArm, QualityArmResult>>;
  readonly discovery: Readonly<Record<QualityArm, GradedDiscoveryEvidence>>;
}

export type RequiredProbeAction =
  | 'current_source'
  | 'safe_refusal'
  | 'navigation_locations'
  | 'discovery_current'
  | 'capability_status';

export interface QualityRequiredProbe {
  readonly probeId: string;
  readonly taskId: string;
  readonly rootKey: import('./contracts.js').QualityRootKey;
  readonly tool: QualityTool;
  readonly expectedAction: RequiredProbeAction;
}

export interface QualityProbeEvidence extends QualityRequiredProbe {
  readonly publicArgsDigest: string | null;
  readonly traceSequence: number | null;
  readonly observedStatus: import('./adapters.js').QualityObservation['status'] | null;
  readonly reasonCode: string | null;
  readonly oracleVerdict: ObservationKind | null;
  readonly resultDigest: string | null;
  readonly locationSetDigest: string | null;
  readonly status: 'COVERED' | 'INCOMPLETE' | 'BLOCKED';
}

export interface QualityRouteCoverage {
  readonly taskId: string;
  readonly scenarioId: string;
  readonly rootKey: import('./contracts.js').QualityRootKey;
  readonly requiredProbeIds: readonly string[];
  readonly probes: readonly QualityProbeEvidence[];
  readonly probeTrace: readonly QualityTraceEvent[];
  readonly setupProofDigest: string | null;
  readonly status: 'COVERED' | 'INCOMPLETE' | 'BLOCKED';
  readonly reasonCode?: string;
}

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, Object.keys(value as object).sort());

const digest = (value: unknown): string => sha256(utf8Bytes(canonicalJson(value)));

const isUnsafeObservation = (observation: ObservationKind): boolean =>
  observation === 'FALSE_FRESH' || observation === 'WRONG_SOURCE';

const isCorrectObservation = (observation: ObservationKind): boolean =>
  observation === 'CORRECT_CURRENT';

const emptyCost = (): QualityCumulativeCost =>
  Object.freeze({ logicalOperations: 0, invocations: 0, contextBytes: 0, contextTokens: 0 });

function profileForEligibility(
  eligibility: QualityCaseManifest['evaluationEligibility'],
): import('./contracts.js').QualityProfile {
  switch (eligibility) {
    case 'conditional_worktree':
      return 'quality-worktree-v1';
    case 'conditional_lsp':
      return 'quality-lsp-v1';
    case 'required_core':
    default:
      return 'quality-core-v1';
  }
}

function verifiedAdoptionIfProven(
  adoption: SourceAdoption,
  snapshot: SourceSnapshot | undefined,
): SourceAdoption {
  if (adoption.sourceValidation !== 'partial' || snapshot === undefined) {
    return adoption;
  }
  if (checkSourceFreshness(snapshot, adoption) === 'FRESH_BYTES') {
    return Object.freeze({ ...adoption, sourceValidation: 'verified' as const });
  }
  return adoption;
}

export function gradeQualityArm(
  task: QualityCaseManifest,
  snapshot: SourceSnapshot | null,
  policyResult: QualityPolicyResult | null,
  publications: readonly QualityPublicationEvidence[],
): QualityArmResult {
  if (policyResult === null) {
    return Object.freeze({
      executionStatus: 'not_run',
      observation: null,
      policy: null,
      adoptionHistory: Object.freeze([]),
      firstCorrectSourceCost: null,
      firstCorrectSourceElapsedMs: null,
      firstCorrectSourceElapsedReason: 'NOT_RUN',
      correctSourceReached: false,
      wrongSourceAdopted: false,
      reasonCode: 'POLICY_NOT_RUN',
    });
  }

  if (snapshot === null) {
    return Object.freeze({
      executionStatus: 'executed',
      observation: 'INCONCLUSIVE',
      policy: policyResult,
      adoptionHistory: Object.freeze([]),
      firstCorrectSourceCost: null,
      firstCorrectSourceElapsedMs: null,
      firstCorrectSourceElapsedReason: 'INCONCLUSIVE',
      correctSourceReached: false,
      wrongSourceAdopted: false,
      reasonCode: 'SNAPSHOT_MISSING',
    });
  }

  const adoptionHistory: GradedQualityAdoption[] = [];
  let correctSourceReached = false;
  let wrongSourceAdopted = false;
  let firstCorrectSourceCost: QualityCumulativeCost | null = null;
  let firstCorrectSourceElapsedMs: number | null = null;
  let firstUnsafeObservation: ObservationKind | null = null;
  let finalObservation: ObservationKind | null = null;

  for (const event of policyResult.adoptionEvents) {
    const publication = publications.find((p) => p.adoptionSequence === event.sequence);
    const publicationSnapshot = publication?.snapshot;
    const provenance = publication?.provenance;
    const sourceToGrade =
      publicationSnapshot === undefined || provenance === undefined
        ? event.source
        : verifiedAdoptionIfProven(event.source, publicationSnapshot);

    const observation =
      publicationSnapshot === undefined || provenance === undefined
        ? 'INCONCLUSIVE'
        : gradeTaskSource(task, publicationSnapshot, sourceToGrade, provenance);

    adoptionHistory.push(
      Object.freeze({
        sequence: event.sequence,
        observation,
        publicationSnapshotDigest: publicationSnapshot?.snapshotDigest ?? null,
        cumulativeCost: event.cumulativeCost,
        elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : null,
      }),
    );

    if (isCorrectObservation(observation)) {
      if (!correctSourceReached) {
        correctSourceReached = true;
        firstCorrectSourceCost = event.cumulativeCost;
        firstCorrectSourceElapsedMs = Number.isFinite(event.elapsedMs) ? event.elapsedMs : null;
      }
      if (finalObservation === null || !isUnsafeObservation(finalObservation)) {
        finalObservation = 'CORRECT_CURRENT';
      }
    }

    if (isUnsafeObservation(observation)) {
      wrongSourceAdopted = true;
      if (firstUnsafeObservation === null) {
        firstUnsafeObservation = observation;
      }
      if (finalObservation === null || !isCorrectObservation(finalObservation)) {
        finalObservation = observation;
      }
    }
  }

  if (finalObservation === null) {
    if (policyResult.adoptionEvents.length > 0) {
      finalObservation = adoptionHistory[adoptionHistory.length - 1]?.observation ?? 'INCONCLUSIVE';
    } else if (task.expectedRefusalConditions.length > 0) {
      finalObservation = 'CORRECT_REFUSAL';
    } else {
      finalObservation = 'FALSE_REFUSAL';
    }
  }

  let elapsedReason: QualityArmResult['firstCorrectSourceElapsedReason'] = correctSourceReached
    ? null
    : 'NOT_REACHED';
  if (!correctSourceReached && policyResult.adoptionEvents.length === 0) {
    elapsedReason = task.expectedRefusalConditions.length > 0 ? 'NOT_REACHED' : 'NOT_REACHED';
  }

  const reasonCode = wrongSourceAdopted
    ? 'SAFETY_FAIL'
    : correctSourceReached
      ? undefined
      : 'NOT_REACHED';

  return Object.freeze({
    executionStatus: 'executed',
    observation: finalObservation,
    policy: policyResult,
    adoptionHistory: Object.freeze(adoptionHistory),
    firstCorrectSourceCost,
    firstCorrectSourceElapsedMs,
    firstCorrectSourceElapsedReason: elapsedReason,
    correctSourceReached,
    wrongSourceAdopted,
    reasonCode,
  });
}

const DISCOVERY_TOOLS = new Set<QualityTool>([
  'rg_search',
  'grep_search',
  'semantic_search',
  'hybrid_search',
  'get_file_outline',
  'get_symbol_source',
  'get_symbol_context',
]);

function isDiscoveryTool(tool: QualityTool): boolean {
  return DISCOVERY_TOOLS.has(tool);
}

export function gradeDiscovery(
  task: QualityCaseManifest,
  _arm: QualityArm,
  policyResult: QualityPolicyResult | null,
): GradedDiscoveryEvidence {
  if (policyResult === null) {
    return Object.freeze({
      evidenceStatus: 'NOT_ESTABLISHED',
      candidateEvidenceDigest: null,
      observedCandidateCount: null,
      eligibleFileTask: task.expectedFiles.length > 0,
      fileFound: null,
      eligibleSymbolTask: task.expectedSymbols.length > 0,
      symbolFound: null,
      labeledUniqueCandidates: null,
      irrelevantUniqueCandidates: null,
      expectedRelevantTargets: null,
      hitsAtK: null,
      reciprocalRank: null,
      reasonCode: 'POLICY_NOT_RUN',
    });
  }

  const searchEvents = policyResult.trace.filter((event) => isDiscoveryTool(event.tool));

  if (searchEvents.length === 0) {
    return Object.freeze({
      evidenceStatus: 'INCOMPLETE',
      candidateEvidenceDigest: null,
      observedCandidateCount: null,
      eligibleFileTask: task.expectedFiles.length > 0,
      fileFound: null,
      eligibleSymbolTask: task.expectedSymbols.length > 0,
      symbolFound: null,
      labeledUniqueCandidates: null,
      irrelevantUniqueCandidates: null,
      expectedRelevantTargets: null,
      hitsAtK: null,
      reciprocalRank: null,
      reasonCode: 'NO_DISCOVERY_TRACE',
    });
  }

  const eligibleFileTask = task.expectedFiles.length > 0;
  const eligibleSymbolTask = task.expectedSymbols.length > 0;
  const expectedRelevantTargets = task.expectedFiles.length + task.expectedSymbols.length;

  const completedOkEvents = searchEvents.filter((event) => event.resultStatus === 'ok');
  const hasEmptyCompletedResult = completedOkEvents.some((event) => event.resultCount === 0);

  if (completedOkEvents.length === 0) {
    return Object.freeze({
      evidenceStatus: 'NOT_ESTABLISHED',
      candidateEvidenceDigest: null,
      observedCandidateCount: null,
      eligibleFileTask,
      fileFound: null,
      eligibleSymbolTask,
      symbolFound: null,
      labeledUniqueCandidates: null,
      irrelevantUniqueCandidates: null,
      expectedRelevantTargets,
      hitsAtK: null,
      reciprocalRank: null,
      reasonCode: 'DISCOVERY_NOT_COMPLETED',
    });
  }

  const observedCandidateCount = completedOkEvents.reduce(
    (max, event) => Math.max(max, event.resultCount),
    0,
  );

  const relevantFiles = new Set(task.expectedFiles);
  const relevantSymbolNames = new Set(task.expectedSymbols.map((symbol) => symbol.name));

  let labeledUniqueCandidates = 0;
  let irrelevantUniqueCandidates = 0;
  let fileFound: boolean | null = null;
  let symbolFound: boolean | null = null;
  let firstRelevantSequence: number | null = null;
  const seenRelevantKeys = new Set<string>();

  for (const event of policyResult.adoptionEvents) {
    const source = event.source;
    const fileRelevant = relevantFiles.has(source.filePath);
    const symbolRelevant =
      eligibleSymbolTask &&
      Array.from(relevantSymbolNames).some((name) => source.content.includes(name));
    const relevantKey = `${source.filePath}\0${Array.from(relevantSymbolNames)
      .filter((name) => source.content.includes(name))
      .join(',')}`;

    if (fileRelevant || symbolRelevant) {
      if (!seenRelevantKeys.has(relevantKey)) {
        seenRelevantKeys.add(relevantKey);
        labeledUniqueCandidates += 1;
      }
      if (firstRelevantSequence === null) {
        firstRelevantSequence = event.sequence;
      }
      if (fileRelevant) {
        fileFound = true;
      }
      if (symbolRelevant) {
        symbolFound = true;
      }
    } else {
      irrelevantUniqueCandidates += 1;
    }
  }

  if (observedCandidateCount === 0 && hasEmptyCompletedResult) {
    fileFound = false;
    symbolFound = false;
  } else if (observedCandidateCount > 0) {
    if (fileFound === null && eligibleFileTask) {
      fileFound = false;
    }
    if (symbolFound === null && eligibleSymbolTask) {
      symbolFound = false;
    }
  }

  const hitsAtK = labeledUniqueCandidates > 0 ? labeledUniqueCandidates : 0;
  const reciprocalRank =
    firstRelevantSequence === null ? null : 1 / firstRelevantSequence;

  const candidateEvidenceDigest = digest({
    arm: _arm,
    searchEvents: searchEvents.map((event) => ({
      tool: event.tool,
      status: event.resultStatus,
      count: event.resultCount,
      argsDigest: event.argsDigest,
    })),
    adoptions: policyResult.adoptionEvents.map((event) => ({
      sequence: event.sequence,
      filePath: event.source.filePath,
    })),
  });

  return Object.freeze({
    evidenceStatus: 'EVALUATED',
    candidateEvidenceDigest,
    observedCandidateCount,
    eligibleFileTask,
    fileFound,
    eligibleSymbolTask,
    symbolFound,
    labeledUniqueCandidates,
    irrelevantUniqueCandidates,
    expectedRelevantTargets,
    hitsAtK,
    reciprocalRank,
  });
}

export function buildBaselineRgExecutionEvidence(
  snapshot: import('./adapters.js').RgExecutionSnapshot,
  rTrace: readonly QualityTraceEvent[],
): BaselineRgExecutionEvidence {
  const traceComplete = rTrace.length > 0;
  const rgSearchTraceEvents = rTrace.filter((event) => event.tool === 'rg_search');
  const initializedDigest = snapshot.initializedContractDigest;

  if (snapshot.evidenceComplete === false && snapshot.rgSearchInvocationCount === 0 && snapshot.spawns.length === 0) {
    return Object.freeze({
      initializedContractDigest: initializedDigest,
      spawnAttemptCount: null,
      observedSpawns: Object.freeze([]),
      traceComplete,
      status: 'EVIDENCE_INCOMPLETE',
      invocationCount: null,
      baselineExecutionContractDigest: initializedDigest,
      reasonCode: 'RG_EXECUTION_EVIDENCE_MISSING',
    });
  }

  if (
    snapshot.rgSearchInvocationCount === 0 &&
    snapshot.spawnAttemptCount === 0 &&
    snapshot.spawns.length === 0 &&
    rgSearchTraceEvents.length === 0
  ) {
    return Object.freeze({
      initializedContractDigest: initializedDigest,
      spawnAttemptCount: 0,
      observedSpawns: Object.freeze([]),
      traceComplete,
      status: 'NOT_INVOKED',
      invocationCount: 0,
      baselineExecutionContractDigest: null,
      reasonCode: null,
    });
  }

  if (snapshot.spawnAttemptCount !== snapshot.spawns.length) {
    return Object.freeze({
      initializedContractDigest: initializedDigest,
      spawnAttemptCount: snapshot.spawnAttemptCount,
      observedSpawns: Object.freeze([...snapshot.spawns]),
      traceComplete,
      status: 'EVIDENCE_INCOMPLETE',
      invocationCount: snapshot.rgSearchInvocationCount,
      baselineExecutionContractDigest: initializedDigest,
      reasonCode: 'RG_EXECUTION_EVIDENCE_MISSING',
    });
  }

  const traceSequences = new Set(rgSearchTraceEvents.map((event) => event.sequence));
  for (const spawn of snapshot.spawns) {
    if (!traceSequences.has(spawn.policyTraceSequence)) {
      return Object.freeze({
        initializedContractDigest: initializedDigest,
        spawnAttemptCount: snapshot.spawnAttemptCount,
        observedSpawns: Object.freeze([...snapshot.spawns]),
        traceComplete,
        status: 'EVIDENCE_INCOMPLETE',
        invocationCount: snapshot.rgSearchInvocationCount,
        baselineExecutionContractDigest: initializedDigest,
        reasonCode: 'RG_EXECUTION_EVIDENCE_MISSING',
      });
    }
  }

  const observedContractDigests = new Set(
    snapshot.spawns.map((spawn) => spawn.observedContractDigest),
  );
  if (observedContractDigests.size !== 1 || !observedContractDigests.has(initializedDigest)) {
    return Object.freeze({
      initializedContractDigest: initializedDigest,
      spawnAttemptCount: snapshot.spawnAttemptCount,
      observedSpawns: Object.freeze([...snapshot.spawns]),
      traceComplete,
      status: 'EVIDENCE_INCOMPLETE',
      invocationCount: snapshot.rgSearchInvocationCount,
      baselineExecutionContractDigest:
        [...observedContractDigests][0] ?? initializedDigest,
      reasonCode: 'RG_CONTRACT_MISMATCH',
    });
  }

  return Object.freeze({
    initializedContractDigest: initializedDigest,
    spawnAttemptCount: snapshot.spawnAttemptCount,
    observedSpawns: Object.freeze([...snapshot.spawns]),
    traceComplete,
    status: 'INVOKED_VERIFIED',
    invocationCount: snapshot.rgSearchInvocationCount,
    baselineExecutionContractDigest: initializedDigest,
    reasonCode: null,
  });
}

export { profileForEligibility };
