import { createHash } from 'node:crypto';
import type {
  QualityArm,
  QualityCaseManifest,
  ObservationKind,
  QualityExecutionStatus,
  QualityProfile,
  QualityRootKey,
} from './contracts.js';
import type {
  QualityObservation,
  QualityTool,
  RgExecutionSnapshot,
  RgSpawnObservation,
} from './adapters.js';
import type { QualityCumulativeCost, QualityPolicyResult, QualityTraceEvent } from './policy.js';
import { gradeTaskSource, checkSourceFreshness } from './oracle.js';
import type { SourceAdoption, SourceProvenance, SourceSnapshot } from './oracle.js';
import { canonicalJson } from './canonical-json.js';

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
  readonly observedSpawns: readonly RgSpawnObservation[];
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
  readonly profile: QualityProfile;
  readonly rootKey: QualityRootKey;
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
  readonly rootKey: QualityRootKey;
  readonly tool: QualityTool;
  readonly expectedAction: RequiredProbeAction;
}

export interface QualityProbeEvidence extends QualityRequiredProbe {
  readonly publicArgsDigest: string | null;
  readonly traceSequence: number | null;
  readonly observedStatus: QualityObservation['status'] | null;
  readonly reasonCode: string | null;
  readonly oracleVerdict: ObservationKind | null;
  readonly resultDigest: string | null;
  readonly locationSetDigest: string | null;
  readonly status: 'COVERED' | 'INCOMPLETE' | 'BLOCKED';
}

export interface QualityRouteCoverage {
  readonly taskId: string;
  readonly scenarioId: string;
  readonly rootKey: QualityRootKey;
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

const digest = (value: unknown): string => sha256(utf8Bytes(canonicalJson(value)));

const isUnsafeObservation = (observation: ObservationKind): boolean =>
  observation === 'FALSE_FRESH' || observation === 'WRONG_SOURCE';

const isCorrectObservation = (observation: ObservationKind): boolean =>
  observation === 'CORRECT_CURRENT';

function profileForEligibility(
  eligibility: QualityCaseManifest['evaluationEligibility'],
): QualityProfile {
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

interface AdoptionGradingState {
  correctSourceReached: boolean;
  wrongSourceAdopted: boolean;
  firstCorrectSourceCost: QualityCumulativeCost | null;
  firstCorrectSourceElapsedMs: number | null;
  finalObservation: ObservationKind | null;
}

const REFUSAL_STATUSES = new Set<QualityTraceEvent['resultStatus']>([
  'not_found',
  'stale_identity',
  'unsupported',
  'unavailable',
]);

const EXECUTION_FAILURE_STATUSES = new Set<QualityTraceEvent['resultStatus']>(['error', 'timeout']);

function expectedSymbolTargets(task: QualityCaseManifest): readonly string[] {
  const fromClues = task.initialClues.flatMap((clue) => {
    const match = /^(?:id|symbol):(.+)$/.exec(clue);
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return fromClues.length > 0 ? fromClues : task.expectedSymbols.map(({ name }) => name);
}

function refusalTargetsExpectedTask(
  event: QualityTraceEvent,
  task: QualityCaseManifest,
): boolean {
  const args = event.normalizedPublicArgs;
  switch (event.tool) {
    case 'get_symbol_source':
    case 'get_symbol_context':
      return typeof args.symbolId === 'string' &&
        expectedSymbolTargets(task).includes(args.symbolId);
    case 'get_definition':
    case 'get_references':
    case 'get_implementations':
      if (typeof args.symbolId === 'string') {
        if (!expectedSymbolTargets(task).includes(args.symbolId)) return false;
        const expectedSymbol = task.expectedSymbols.find(({ name }) => name === args.symbolId);
        return args.filePath === undefined ||
          (expectedSymbol !== undefined && args.filePath === expectedSymbol.filePath);
      }
      return task.expectedLocations.some((location) =>
        args.filePath === location.filePath &&
        args.line === location.line &&
        args.character === location.character,
      );
    case 'read_file':
    case 'get_context':
    case 'get_file_outline': {
      if (typeof args.filePath !== 'string' || !task.expectedFiles.includes(args.filePath)) {
        return false;
      }
      return typeof args.symbolName !== 'string' ||
        expectedSymbolTargets(task).includes(args.symbolName);
    }
    default:
      // Search terms are intentionally redacted from normalized arguments, so their target
      // cannot be proven from the public trace.
      return false;
  }
}

function recordAdoptionObservation(
  state: AdoptionGradingState,
  observation: ObservationKind,
  event: QualityPolicyResult['adoptionEvents'][number],
): void {
  if (isCorrectObservation(observation)) {
    if (!state.correctSourceReached) {
      state.correctSourceReached = true;
      state.firstCorrectSourceCost = event.cumulativeCost;
      state.firstCorrectSourceElapsedMs = Number.isFinite(event.elapsedMs) ? event.elapsedMs : null;
    }
    if (state.finalObservation === null || !isUnsafeObservation(state.finalObservation)) {
      state.finalObservation = 'CORRECT_CURRENT';
    }
  }
  if (!isUnsafeObservation(observation)) return;

  state.wrongSourceAdopted = true;
  if (state.finalObservation === null || !isCorrectObservation(state.finalObservation)) {
    state.finalObservation = observation;
  }
}

function resolveFinalObservation(
  state: AdoptionGradingState,
  task: QualityCaseManifest,
  policyResult: QualityPolicyResult,
  history: readonly GradedQualityAdoption[],
): ObservationKind {
  if (state.finalObservation !== null) return state.finalObservation;
  if (policyResult.adoptionEvents.length > 0) {
    return history.at(-1)?.observation ?? 'INCONCLUSIVE';
  }
  const expectedRefusal = new Set(task.expectedRefusalConditions);
  const refusalEvents = policyResult.trace.filter((event) => REFUSAL_STATUSES.has(event.resultStatus));
  const refusedForExpectedReason = expectedRefusal.size > 0 && refusalEvents.some((event) =>
    event.reasonCode !== null &&
    expectedRefusal.has(event.reasonCode) &&
    event.exposedBytes === 0 &&
    refusalTargetsExpectedTask(event, task),
  );
  if (refusedForExpectedReason) return 'CORRECT_REFUSAL';
  if (refusalEvents.length > 0) return 'FALSE_REFUSAL';
  return 'INCONCLUSIVE';
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

  if (policyResult.status === 'NOT_STARTED') {
    return Object.freeze({
      executionStatus: 'not_run',
      observation: null,
      policy: policyResult,
      adoptionHistory: Object.freeze([]),
      firstCorrectSourceCost: null,
      firstCorrectSourceElapsedMs: null,
      firstCorrectSourceElapsedReason: 'NOT_RUN',
      correctSourceReached: false,
      wrongSourceAdopted: false,
      reasonCode: 'REQUEST_CANCELLED',
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
  const state: AdoptionGradingState = {
    correctSourceReached: false,
    wrongSourceAdopted: false,
    firstCorrectSourceCost: null,
    firstCorrectSourceElapsedMs: null,
    finalObservation: null,
  };

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

    recordAdoptionObservation(state, observation, event);
  }

  const finalObservation = resolveFinalObservation(state, task, policyResult, adoptionHistory);
  const elapsedReason: QualityArmResult['firstCorrectSourceElapsedReason'] = state.correctSourceReached
    ? null
    : 'NOT_REACHED';
  const executionFailure = policyResult.trace.some((event) => EXECUTION_FAILURE_STATUSES.has(event.resultStatus));
  const wasCancelled = policyResult.trace.some((event) => event.resultStatus === 'cancelled');
  const reasonCode = state.wrongSourceAdopted
    ? 'SAFETY_FAIL'
    : state.correctSourceReached
      ? undefined
      : finalObservation === 'CORRECT_REFUSAL'
        ? undefined
        : finalObservation === 'FALSE_REFUSAL'
          ? 'UNEXPECTED_REFUSAL'
          : executionFailure
            ? 'POLICY_EXECUTION_FAILED'
            : wasCancelled
              ? 'REQUEST_CANCELLED'
              : 'NOT_REACHED';

  return Object.freeze({
    executionStatus: 'executed',
    observation: finalObservation,
    policy: policyResult,
    adoptionHistory: Object.freeze(adoptionHistory),
    firstCorrectSourceCost: state.firstCorrectSourceCost,
    firstCorrectSourceElapsedMs: state.firstCorrectSourceElapsedMs,
    firstCorrectSourceElapsedReason: elapsedReason,
    correctSourceReached: state.correctSourceReached,
    wrongSourceAdopted: state.wrongSourceAdopted,
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

interface DiscoveryAdoptionSummary {
  labeledUniqueCandidates: number;
  irrelevantUniqueCandidates: number;
  fileFound: boolean | null;
  symbolFound: boolean | null;
  firstRelevantRank: number | null;
}

function summarizeDiscoveryAdoptions(
  task: QualityCaseManifest,
  eligibleFileTask: boolean,
  eligibleSymbolTask: boolean,
  observedCandidateCount: number,
  hasEmptyCompletedResult: boolean,
  policyResult: QualityPolicyResult,
): DiscoveryAdoptionSummary {
  const relevantFiles = new Set(task.expectedFiles);
  const relevantSymbols = task.expectedSymbols;
  const seenCandidateClassifications = new Map<string, 'relevant' | 'irrelevant'>();
  const summary: DiscoveryAdoptionSummary = {
    labeledUniqueCandidates: 0,
    irrelevantUniqueCandidates: 0,
    fileFound: null,
    symbolFound: null,
    firstRelevantRank: null,
  };

  for (const event of policyResult.adoptionEvents) {
    const { source } = event;
    const fileRelevant = relevantFiles.has(source.filePath);
    const matchingSymbols = relevantSymbols.filter((symbol) =>
      symbol.filePath === source.filePath &&
      symbol.startByte === source.startByte &&
      symbol.endByte === source.endByte &&
      source.content.includes(symbol.name),
    );
    const symbolRelevant = eligibleSymbolTask && matchingSymbols.length > 0;
    const candidateRelevant = symbolRelevant || (fileRelevant && !eligibleSymbolTask);
    const candidateKey = `${source.filePath}\0${source.startByte}\0${source.endByte}`;
    if (!candidateRelevant) {
      if (!seenCandidateClassifications.has(candidateKey)) {
        seenCandidateClassifications.set(candidateKey, 'irrelevant');
        summary.irrelevantUniqueCandidates += 1;
      }
      if (fileRelevant) summary.fileFound = true;
      continue;
    }

    const previousClassification = seenCandidateClassifications.get(candidateKey);
    if (previousClassification !== 'relevant') {
      if (previousClassification === 'irrelevant') summary.irrelevantUniqueCandidates -= 1;
      seenCandidateClassifications.set(candidateKey, 'relevant');
      summary.labeledUniqueCandidates += 1;
    }
    if (summary.firstRelevantRank === null && event.candidateRank !== undefined) {
      summary.firstRelevantRank = event.candidateRank;
    }
    if (fileRelevant) summary.fileFound = true;
    if (symbolRelevant) summary.symbolFound = true;
  }

  if (observedCandidateCount === 0 && hasEmptyCompletedResult) {
    if (summary.fileFound === null && eligibleFileTask) summary.fileFound = false;
    if (summary.symbolFound === null && eligibleSymbolTask) summary.symbolFound = false;
  } else if (observedCandidateCount > 0) {
    if (summary.fileFound === null && eligibleFileTask) summary.fileFound = false;
    if (summary.symbolFound === null && eligibleSymbolTask) summary.symbolFound = false;
  }
  return summary;
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

  const adoptionSummary = summarizeDiscoveryAdoptions(
    task,
    eligibleFileTask,
    eligibleSymbolTask,
    observedCandidateCount,
    hasEmptyCompletedResult,
    policyResult,
  );
  const hitsAtK = Math.max(0, adoptionSummary.labeledUniqueCandidates);
  const reciprocalRank =
    adoptionSummary.firstRelevantRank === null ? null : 1 / adoptionSummary.firstRelevantRank;

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
      candidateRank: event.candidateRank ?? null,
    })),
  });

  return Object.freeze({
    evidenceStatus: 'EVALUATED',
    candidateEvidenceDigest,
    observedCandidateCount,
    eligibleFileTask,
    fileFound: adoptionSummary.fileFound,
    eligibleSymbolTask,
    symbolFound: adoptionSummary.symbolFound,
    labeledUniqueCandidates: adoptionSummary.labeledUniqueCandidates,
    irrelevantUniqueCandidates: adoptionSummary.irrelevantUniqueCandidates,
    expectedRelevantTargets,
    hitsAtK,
    reciprocalRank,
  });
}

export function buildBaselineRgExecutionEvidence(
  snapshot: RgExecutionSnapshot,
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
