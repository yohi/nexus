import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve as resolvePath, relative, dirname } from 'node:path';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { NexusServerOptions } from '../../../src/server/tools/types.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { LocalContentStore } from '../../../src/storage/local/local-content-store.js';
import type {
  IGrepEngine,
  GrepMatch,
  GrepParams,
  IVectorStore,
  IMetadataStore,
  IIndexPipeline,
  IndexEvent,
} from '../../../src/types/index.js';
import type { PluginRegistry } from '../../../src/plugins/registry.js';
import type { ISemanticSearch } from '../../../src/search/semantic.js';
import type { SearchOrchestrator } from '../../../src/search/orchestrator.js';
import { QUALITY_BUDGETS_V1 } from './contracts.js';
import {
  runQualityPolicy,
  type QualityPolicyObserver,
  type QualityPolicyResult,
  type QualityTraceEvent,
} from './policy.js';
import {
  createNexusAdapter,
  createRipgrepAdapter,
  type QualityAdapter,
  type QualityObservation,
  type QualityInvocationContext,
  type QualityTool as AdapterQualityTool,
  type PublicJsonValue,
} from './adapters.js';
import { publicTask, type QualityCaseManifest, type QualityArm, type QualityRootKey } from './contracts.js';
import { captureOracleSnapshot, type SourceSnapshot, type SourceProvenance } from './oracle.js';
import type { OwnedQualityFixture } from './fixtures.js';
import {
  gradeQualityArm,
  gradeDiscovery,
  buildBaselineRgExecutionEvidence,
  type QualityPublicationEvidence,
  type PairedQualityResult,
  type QualityRouteCoverage,
  type QualityRequiredProbe,
  type QualityProbeEvidence,
} from './scoring.js';
import { canonicalJson } from './canonical-json.js';

export type {
  QualityPublicationEvidence,
  GradedQualityAdoption,
  QualityArmResult,
  GradedDiscoveryEvidence,
  BaselineRgEvidenceCommon,
  BaselineRgExecutionEvidence,
  PairedQualityResult,
  RequiredProbeAction,
  QualityRequiredProbe,
  QualityProbeEvidence,
  QualityRouteCoverage,
} from './scoring.js';

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const digest = (value: unknown): string => sha256(utf8Bytes(canonicalJson(value)));

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.nexus']);

interface LocalGrepContext {
  readonly root: string;
  readonly needle: string;
  readonly caseSensitive: boolean;
  readonly glob: string[] | undefined;
  readonly limit: number;
  readonly results: GrepMatch[];
  readonly abortSignal: AbortSignal | undefined;
}

function matchGlob(filePath: string, glob?: string[]): boolean {
  if (glob === undefined || glob.length === 0) {
    return true;
  }
  let included = false;
  for (const pattern of glob) {
    const negative = pattern.startsWith('!');
    const raw = negative ? pattern.slice(1) : pattern;
    const matches = simpleGlobMatch(filePath, raw);
    if (matches) {
      if (negative) {
        return false;
      }
      included = true;
    }
  }
  return included;
}

function simpleGlobMatch(filePath: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**/*') {
    return true;
  }
  if (pattern.startsWith('*.') && filePath.endsWith(pattern.slice(1))) {
    return true;
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.replaceAll('*', '.*').replaceAll('.', '\\.')}$`);
    return regex.test(filePath);
  }
  return filePath === pattern;
}

class LocalGrepEngine implements IGrepEngine {
  async search(params: GrepParams): Promise<GrepMatch[]> {
    const { query, cwd, glob, maxResults, abortSignal } = params;
    const caseSensitive = params.caseSensitive ?? false;
    const limit = maxResults ?? 100;
    const context: LocalGrepContext = {
      root: cwd,
      needle: caseSensitive ? query : query.toLowerCase(),
      caseSensitive,
      glob,
      limit,
      results: [],
      abortSignal,
    };
    await this.searchDir(cwd, context);
    return context.results;
  }

  private async searchDir(dir: string, context: LocalGrepContext): Promise<void> {
    if (context.abortSignal?.aborted || context.results.length >= context.limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (context.abortSignal?.aborted || context.results.length >= context.limit) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await this.searchDir(resolvePath(dir, entry.name), context);
      } else if (entry.isFile()) {
        await this.searchFile(resolvePath(dir, entry.name), context);
      }
    }
  }

  private async searchFile(fullPath: string, context: LocalGrepContext): Promise<void> {
    const filePath = relative(context.root, fullPath).replaceAll('\\', '/');
    if (!matchGlob(filePath, context.glob)) return;

    const lines = (await readFile(fullPath, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      const haystack = context.caseSensitive ? line : line.toLowerCase();
      const submatches: GrepMatch['submatches'] = [];
      let pos = haystack.indexOf(context.needle);
      while (pos !== -1) {
        submatches.push({
          start: pos,
          end: pos + context.needle.length,
          match: line.slice(pos, pos + context.needle.length),
        });
        pos = haystack.indexOf(context.needle, pos + context.needle.length);
      }
      if (submatches.length > 0) {
        context.results.push({ filePath, lineNumber: index + 1, lineText: line, submatches });
        if (context.results.length >= context.limit) return;
      }
    }
  }
}

function stub<T>(value: object = {}): T {
  return value as unknown as T;
}

function createStubMetadataStore(): IMetadataStore {
  return stub<IMetadataStore>({
    initialize: () => Promise.resolve(),
    getIndexStats: () => Promise.resolve(null),
    getDeadLetterEntries: () => Promise.resolve([]),
    getStructuredIndexState: undefined,
  });
}

function createStubVectorStore(): IVectorStore {
  return stub<IVectorStore>({
    initialize: () => Promise.resolve(),
    getStats: () => Promise.resolve({
      totalChunks: 0,
      totalFiles: 0,
      dimensions: 0,
      fragmentationRatio: 0,
    }),
  });
}

function createStubPipeline(): IIndexPipeline {
  return stub<IIndexPipeline>({
    getProgress: () => ({
      totalFiles: 0,
      processedFiles: 0,
      status: 'idle',
    }),
  });
}

function createStubPluginRegistry(): PluginRegistry {
  return stub<PluginRegistry>({
    registerLanguage: () => {},
    getLanguagePlugin: () => undefined,
    registerEmbeddingProvider: () => {},
    getEmbeddingProvider: () => undefined,
    setActiveEmbeddingProvider: () => {},
    getActiveEmbeddingProviderName: () => undefined,
    getRegisteredEmbeddingProviderNames: () => [],
    getEmbeddingProviderHealth: () => undefined,
    healthCheck: () => Promise.resolve({ status: 'ok' }),
  });
}

async function createNexusAdapterForRoot(root: string): Promise<QualityAdapter> {
  const sanitizer = await PathSanitizer.create(root);

  const loadFileContent = async (filePath: string): Promise<string> => {
    const resolved = await realpath(filePath);
    return readFile(resolved, 'utf8');
  };

  const options: NexusServerOptions = {
    projectRoot: root,
    sanitizer,
    semanticSearch: stub<ISemanticSearch>({ search: () => Promise.resolve([]) }),
    grepEngine: new LocalGrepEngine(),
    orchestrator: stub<SearchOrchestrator>(),
    vectorStore: createStubVectorStore(),
    metadataStore: createStubMetadataStore(),
    pipeline: createStubPipeline(),
    pluginRegistry: createStubPluginRegistry(),
    runReindex: (): Promise<IndexEvent[]> => Promise.resolve([]),
    loadFileContent,
    contentStore: new LocalContentStore({
      projectRoot: root,
      sanitize: (filePath) => sanitizer.sanitize(filePath),
    }),
    lspNavigationService: undefined,
  };

  const handlers = buildToolHandlers(options);
  return createNexusAdapter(handlers);
}
function buildProvenance(rootKey: QualityRootKey, canonicalRoot: string): SourceProvenance {
  return Object.freeze({
    observedSourceRootKey: rootKey,
    canonicalSourceRoot: canonicalRoot,
    sourceRootProofDigest: sha256(utf8Bytes(canonicalRoot)),
  });
}

async function runSingleArm(
  task: QualityCaseManifest,
  rootKey: QualityRootKey,
  root: string,
  adapter: QualityAdapter,
  signal: AbortSignal,
): Promise<{ policyResult: QualityPolicyResult; publications: QualityPublicationEvidence[]; finalSnapshot: SourceSnapshot }> {
  const publications: QualityPublicationEvidence[] = [];
  const canonicalRoot = await realpath(root);
  const provenance = buildProvenance(rootKey, canonicalRoot);

  const observer: QualityPolicyObserver = {
    onAdoptionPublished: async (event) => {
      const snapshot = await captureOracleSnapshot(
        { root: dirname(canonicalRoot), roots: { [rootKey]: canonicalRoot }, publicTasks: [], oracleCases: [task], dispose: async () => {} } as OwnedQualityFixture,
        rootKey,
        task.taskId,
      );
      publications.push(
        Object.freeze({
          adoptionSequence: event.sequence,
          snapshot,
          provenance,
          snapshotCapturedAtPublication: true as const,
        }),
      );
    },
  };

  const policyResult = await runQualityPolicy(
    publicTask(task),
    adapter,
    QUALITY_BUDGETS_V1,
    signal,
    observer,
  );

  const finalSnapshot = await captureOracleSnapshot(
    { root: dirname(canonicalRoot), roots: { [rootKey]: canonicalRoot }, publicTasks: [], oracleCases: [task], dispose: async () => {} } as OwnedQualityFixture,
    rootKey,
    task.taskId,
  );

  return { policyResult, publications, finalSnapshot };
}

function findRgExecutable(): string {
  const fromEnv = typeof process.env.NEXUS_RG_EXECUTABLE === 'string' ? process.env.NEXUS_RG_EXECUTABLE : '';
  return fromEnv.length > 0 ? fromEnv : 'rg';
}

export async function runQualityPair(
  task: QualityCaseManifest,
  fixture: OwnedQualityFixture,
  options: Readonly<{ signal: AbortSignal; rgExecutable?: string }>,
): Promise<PairedQualityResult> {
  const rootKey = task.worktreeIdentity.rootKey;
  const root = fixture.roots[rootKey];
  if (root === undefined) {
    throw new Error('quality_root_key_missing');
  }

  const rgExecutable = options.rgExecutable ?? findRgExecutable();
  const signal = options.signal;

  const rAdapter = createRipgrepAdapter(root, rgExecutable, { rootKey });
  const nAdapter = await createNexusAdapterForRoot(root);

  const rArm = await runSingleArm(task, rootKey, root, rAdapter, signal);
  const nArm = await runSingleArm(task, rootKey, root, nAdapter, signal);

  const rResult = gradeQualityArm(task, rArm.finalSnapshot, rArm.policyResult, rArm.publications);
  const nResult = gradeQualityArm(task, nArm.finalSnapshot, nArm.policyResult, nArm.publications);

  const baselineRgExecution = buildBaselineRgExecutionEvidence(
    rAdapter.snapshotRgExecution(),
    rArm.policyResult.trace,
  );

  const outcomes: Record<QualityArm, typeof rResult> = Object.freeze({
    R: rResult,
    N: nResult,
  });

  const discovery: Record<QualityArm, ReturnType<typeof gradeDiscovery>> = Object.freeze({
    R: gradeDiscovery(task, 'R', rArm.policyResult),
    N: gradeDiscovery(task, 'N', nArm.policyResult),
  });

  const fixtureDigest = rArm.finalSnapshot.snapshotDigest;
  const profile =
    task.evaluationEligibility === 'conditional_worktree'
      ? 'quality-worktree-v1'
      : task.evaluationEligibility === 'conditional_lsp'
        ? 'quality-lsp-v1'
        : 'quality-core-v1';

  return Object.freeze({
    taskId: task.taskId,
    profile,
    rootKey,
    fixtureDigest,
    policyVersion: 'quality-policy-v1' as const,
    baselineRgExecution,
    outcomes,
    discovery,
  });
}

function normalizeProbeArgs(tool: AdapterQualityTool, args: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case 'rg_search':
    case 'grep_search':
    case 'semantic_search':
    case 'hybrid_search':
      return {};
    case 'read_file':
      return { filePath: args.filePath };
    case 'get_context':
      return { filePath: args.filePath, startLine: args.startLine, endLine: args.endLine, mode: args.mode };
    case 'get_file_outline':
      return { filePath: args.filePath };
    case 'get_symbol_source':
    case 'get_symbol_context':
      return { symbolId: args.symbolId };
    case 'get_definition':
    case 'get_references':
    case 'get_implementations':
      return { filePath: args.filePath, line: args.line, character: args.character, symbolId: args.symbolId };
    case 'index_status':
      return {};
    default:
      return {};
  }
}

function locationSetDigest(observation: QualityObservation): string | null {
  if (observation.navigation === undefined) {
    return null;
  }
  const locations = [...observation.navigation.locations].sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath < right.filePath ? -1 : 1;
    }
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }
    return left.startCharacter - right.startCharacter;
  });
  return digest({ locations });
}

function requiredProbesForScenario(
  task: QualityCaseManifest,
): QualityRequiredProbe[] {
  const base: QualityRequiredProbe[] = [
    { probeId: `${task.taskId}-index_status`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'index_status', expectedAction: 'capability_status' },
  ];

  switch (task.scenarioId) {
    case 'Q01@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-grep`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'grep_search', expectedAction: 'discovery_current' },
      ];
    case 'Q03@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-old-identity-refusal`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'safe_refusal' },
        { probeId: `${task.taskId}-new-identity-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'grep_search', expectedAction: 'current_source' },
      ];
    case 'Q07@quality-v1':
    case 'Q08@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-hybrid`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'hybrid_search', expectedAction: 'discovery_current' },
      ];
    case 'Q10@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-outline`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_file_outline', expectedAction: 'discovery_current' },
        { probeId: `${task.taskId}-scoped-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_context', expectedAction: 'current_source' },
      ];
    case 'Q14@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-definition`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_definition', expectedAction: 'safe_refusal' },
        { probeId: `${task.taskId}-references`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_references', expectedAction: 'safe_refusal' },
        { probeId: `${task.taskId}-implementations`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_implementations', expectedAction: 'safe_refusal' },
      ];
    default:
      return [
        ...base,
        { probeId: `${task.taskId}-exact`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'grep_search', expectedAction: 'current_source' },
      ];
  }
}

function probeArgsForTool(
  tool: AdapterQualityTool,
  task: QualityCaseManifest,
): Record<string, unknown> {
  switch (tool) {
    case 'index_status':
      return {};
    case 'grep_search':
    case 'rg_search': {
      const symbol = task.expectedSymbols[0];
      const file = task.expectedFiles[0];
      const pattern = symbol?.name ?? file?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'answer';
      return { pattern, maxResults: 20 };
    }
    case 'hybrid_search':
    case 'semantic_search':
      return { query: task.taskDescription, topK: 20 };
    case 'get_context': {
      const file = task.expectedFiles[0];
      return file === undefined ? {} : { filePath: file, startLine: 1, endLine: 10, mode: 'bounded' };
    }
    case 'read_file': {
      const file = task.expectedFiles[0];
      return file === undefined ? {} : { filePath: file, startByte: 0, endByte: 4096 };
    }
    case 'get_file_outline': {
      const file = task.expectedFiles[0];
      return file === undefined ? {} : { filePath: file };
    }
    case 'get_symbol_source':
    case 'get_symbol_context': {
      const symbol = task.expectedSymbols[0];
      return symbol === undefined ? {} : { symbolId: symbol.name, tokenBudget: 1024 };
    }
    case 'get_definition':
    case 'get_references':
    case 'get_implementations': {
      const location = task.expectedLocations[0];
      const symbol = task.expectedSymbols[0];
      const file = task.expectedFiles[0];
      if (location !== undefined) {
        return { filePath: location.filePath, line: location.line, character: location.character, maxResults: 20 };
      }
      if (symbol !== undefined && file !== undefined) {
        return { filePath: file, line: 1, character: 0, maxResults: 20 };
      }
      return {};
    }
    default:
      return {};
  }
}

function isProbeCovered(probe: QualityRequiredProbe, observation: QualityObservation): boolean {
  if (observation.status === 'ok') {
    return true;
  }
  if (probe.expectedAction === 'safe_refusal' || probe.expectedAction === 'capability_status') {
    return observation.status === 'unavailable' || observation.status === 'not_found' || observation.status === 'unsupported';
  }
  return false;
}

export async function collectQualityRouteCoverage(
  task: QualityCaseManifest,
  fixture: OwnedQualityFixture,
  options: Readonly<{ signal: AbortSignal }>,
): Promise<readonly QualityRouteCoverage[]> {
  const rootKey = task.worktreeIdentity.rootKey;
  const root = fixture.roots[rootKey];
  if (root === undefined) {
    return Object.freeze([
      Object.freeze({
        taskId: task.taskId,
        scenarioId: task.scenarioId,
        rootKey,
        requiredProbeIds: [],
        probes: [],
        probeTrace: [],
        setupProofDigest: null,
        status: 'BLOCKED',
        reasonCode: 'quality_root_key_missing',
      }),
    ]);
  }

  const adapter = await createNexusAdapterForRoot(root);
  const requiredProbes = requiredProbesForScenario(task);
  const requiredProbeIds = Object.freeze(requiredProbes.map((p) => p.probeId));
  const probes: QualityProbeEvidence[] = [];
  const probeTrace: QualityTraceEvent[] = [];
  const canonicalRoot = await realpath(root);
  const setupProofDigest = sha256(utf8Bytes(`quality-route-coverage-v1\0${canonicalRoot}\0${task.scenarioId}`));

  let sequence = 0;
  for (const probe of requiredProbes) {
    if (options.signal.aborted) {
      probes.push(
        Object.freeze({
          ...probe,
          publicArgsDigest: null,
          traceSequence: null,
          observedStatus: 'cancelled',
          reasonCode: 'REQUEST_CANCELLED',
          oracleVerdict: null,
          resultDigest: null,
          locationSetDigest: null,
          status: 'BLOCKED',
        }),
      );
      continue;
    }

    sequence += 1;
    const args = probeArgsForTool(probe.tool, task);
    const context: QualityInvocationContext = { traceSequence: sequence };
    let observation: QualityObservation;
    try {
      // Probe order determines traceSequence and abort behavior; keep invocations sequential.
      observation = await adapter.invoke(probe.tool, args, options.signal, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observation = {
        status: 'error',
        results: Object.freeze([]),
        exposedBytes: 0,
        sourceAdoptions: Object.freeze([]),
        rawDigest: digest(message),
        normalizedPublicArgs: Object.freeze(normalizeProbeArgs(probe.tool, args)) as Readonly<Record<string, PublicJsonValue>>,
        reasonCode: message,
      };
    }

    const publicArgsDigest = digest(normalizeProbeArgs(probe.tool, args));
    const locationDigest = locationSetDigest(observation);

    probes.push(
      Object.freeze({
        ...probe,
        publicArgsDigest,
        traceSequence: sequence,
        observedStatus: observation.status,
        reasonCode: observation.reasonCode ?? null,
        oracleVerdict: null,
        resultDigest: observation.rawDigest,
        locationSetDigest: locationDigest,
        status: isProbeCovered(probe, observation) ? 'COVERED' : 'INCOMPLETE',
      }),
    );
  }

  const allCovered = probes.length > 0 && probes.every((p) => p.status === 'COVERED');

  return Object.freeze([
    Object.freeze({
      taskId: task.taskId,
      scenarioId: task.scenarioId,
      rootKey,
      requiredProbeIds,
      probes: Object.freeze(probes),
      probeTrace: Object.freeze(probeTrace),
      setupProofDigest,
      status: allCovered ? 'COVERED' : 'INCOMPLETE',
      reasonCode: allCovered ? undefined : 'MISSING_REQUIRED_PROBE',
    }),
  ]);
}
