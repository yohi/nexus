import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve as resolvePath, relative, dirname } from 'node:path';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { NexusServerOptions } from '../../../src/server/tools/types.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import type {
  IGrepEngine,
  GrepMatch,
  GrepParams,
  IVectorStore,
  IMetadataStore,
  IIndexPipeline,
  IndexEvent,
  ReindexOptions,
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
  type RipgrepQualityAdapter,
  type QualityTool as AdapterQualityTool,
  type PublicJsonValue,
  type PublicSourceLocation,
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
  type RequiredProbeAction,
} from './scoring.js';

import { SymbolRetrievalService } from '../../../src/structured/retrieval-service.js';
import type { IStructuredCatalog } from '../../../src/storage/interfaces/structured-catalog.js';
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

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, Object.keys(value as object).sort());

const digest = (value: unknown): string => sha256(utf8Bytes(canonicalJson(value)));

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.nexus']);

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
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*').replace(/\./g, '\\.')}$`);
    return regex.test(filePath);
  }
  return filePath === pattern;
}

class LocalGrepEngine implements IGrepEngine {
  async search(params: GrepParams): Promise<GrepMatch[]> {
    const { query, cwd, glob, maxResults, abortSignal } = params;
    const caseSensitive = params.caseSensitive ?? false;
    const limit = maxResults ?? 100;
    const needle = caseSensitive ? query : query.toLowerCase();
    const results: GrepMatch[] = [];
    await this.searchDir(cwd, cwd, needle, caseSensitive, glob, limit, results, abortSignal);
    return results;
  }

  private async searchDir(
    root: string,
    dir: string,
    needle: string,
    caseSensitive: boolean,
    glob: string[] | undefined,
    limit: number,
    results: GrepMatch[],
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (abortSignal?.aborted) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        await this.searchDir(
          root,
          resolvePath(dir, entry.name),
          needle,
          caseSensitive,
          glob,
          limit,
          results,
          abortSignal,
        );
      } else if (entry.isFile()) {
        const fullPath = resolvePath(dir, entry.name);
        const filePath = relative(root, fullPath).replace(/\\/g, '/');
        if (!matchGlob(filePath, glob)) {
          continue;
        }
        const content = await readFile(fullPath, 'utf8');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          const haystack = caseSensitive ? line : line.toLowerCase();
          const submatches: GrepMatch['submatches'] = [];
          let pos = haystack.indexOf(needle);
          while (pos !== -1) {
            submatches.push({
              start: pos,
              end: pos + needle.length,
              match: line.slice(pos, pos + needle.length),
            });
            pos = haystack.indexOf(needle, pos + needle.length);
          }
          if (submatches.length > 0) {
            results.push({ filePath, lineNumber: index + 1, lineText: line, submatches });
            if (results.length >= limit) {
              return;
            }
          }
        }
      }
    }
  }
}

function stub<T>(value: object = {}): T {
  return value as unknown as T;
}

function createStubMetadataStore(): IMetadataStore {
  return stub<IMetadataStore>({
    initialize: async () => {},
    getIndexStats: async () => null,
    getDeadLetterEntries: async () => [],
    getStructuredIndexState: undefined,
  });
}

function createStubVectorStore(): IVectorStore {
  return stub<IVectorStore>({
    initialize: async () => {},
    getStats: async () => ({
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
    healthCheck: async () => ({ status: 'ok' }),
  });
}

async function createNexusAdapterForRoot(root: string): Promise<QualityAdapter> {
  const sanitizer = await PathSanitizer.create(root);

  const loadFileContent = async (filePath: string, _signal?: AbortSignal): Promise<string> => {
    const resolved = await realpath(filePath);
    return readFile(resolved, 'utf8');
  };

  const structuredCatalog: IStructuredCatalog = {
    bootstrapStructuredSchema: async () => {},
    getStructuredIndexState: async () => ({
      schemaVersion: 1,
      rebuildState: 'idle',
      rebuildEpoch: 1,
      lastErrorCode: null,
      counts: { totalFiles: 0, totalSymbols: 0, exactFiles: 0, degradedFiles: 0, pendingFiles: 0 },
      activeGenerations: new Map(),
      reindexRequired: true,
    }),
    setStructuredRebuildState: async () => {},
    incrementRebuildEpoch: async () => 1,
    stageGeneration: async () => ({ activated: false }),
    activateGeneration: async () => ({ activated: false }),
    clearPendingGeneration: async () => ({ cleared: false }),
    retireFile: async () => {},
    resolveFile: async (filePath: string) => ({ kind: 'missing', filePath }),
    getActiveGenerationMap: async () => new Map(),
    resolveSymbol: async () => ({ kind: 'missing', symbolId: '' }),
    getPendingSymbol: async () => ({ kind: 'missing', symbolId: '' }),
    getTombstone: async () => null,
    getStructuredCounts: async () => ({ totalFiles: 0, totalSymbols: 0, exactFiles: 0, degradedFiles: 0, pendingFiles: 0 }),
    getImportsForSymbol: async () => [],
    getFileImports: async () => [],
    getFileDeclarations: async () => [],
    getGeneration: async () => null,
    prepareFullRebuild: async () => {},
    recordFullRebuildVectorArtifact: async () => {},
    markFullRebuildVectorBackupComplete: async () => {},
    activateFullRebuild: async () => {},
    rollbackFullRebuild: async () => {},
    finalizeFullRebuild: async () => {},
    getFullRebuildRecovery: async () => null,
    recoverInterruptedFullRebuild: async () => {},
    finalizeInterruptedFullRebuild: async () => {},
    reconcileStructuredState: async () => ({ status: 'ok', filesRetired: 0, filesActivated: 0, filesStaged: 0 }),
    initialize: async () => {},
    bulkUpsertMerkleNodes: async () => {},
    bulkDeleteMerkleNodes: async () => {},
    bulkDeleteSubtrees: async () => 0,
    replaceAllMerkleNodes: async () => {},
    deleteSubtree: async () => 0,
    getSubtreePaths: async () => [],
    pruneEmptyParents: async () => {},
    renamePath: async () => {},
    getMerkleNode: async () => null,
    getChildren: async () => [],
    hasChildren: async () => false,
    getAllNodes: async () => [],
    getAllFileNodes: async () => [],
    getAllPaths: async () => [],
    getIndexStats: async () => null,
    setIndexStats: async () => {},
    atomicCompletionCheck: async () => ({ dlqEmpty: true, dlqEntries: [] }),
    upsertDeadLetterEntries: async () => {},
    removeDeadLetterEntries: async () => {},
    getDeadLetterEntries: async () => [],
    getEmbeddings: async () => new Map(),
    setEmbeddings: async () => {},
    deleteEmbeddings: async () => {},
    clearEmbeddings: async () => {},
    pruneEmbeddings: async () => 0,
  } as unknown as IStructuredCatalog;
  const symbolRetrievalService = new SymbolRetrievalService({ catalog: structuredCatalog, sanitizer });

  const options: NexusServerOptions = {
    projectRoot: root,
    sanitizer,
    semanticSearch: stub<ISemanticSearch>(),
    grepEngine: new LocalGrepEngine(),
    orchestrator: stub<SearchOrchestrator>({
      search: async () => ({ results: [], grepResults: [], fusionScoreByPath: {} }),
    }),
    vectorStore: createStubVectorStore(),
    metadataStore: structuredCatalog as unknown as IMetadataStore,
    pipeline: createStubPipeline(),
    pluginRegistry: createStubPluginRegistry(),
    runReindex: async (_options?: ReindexOptions): Promise<IndexEvent[]> => [],
    loadFileContent,
    lspNavigationService: undefined,
    symbolRetrievalService,
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

  return Object.freeze({
    taskId: task.taskId,
    profile: task.evaluationEligibility === 'conditional_worktree' ? 'quality-worktree-v1' : task.evaluationEligibility === 'conditional_lsp' ? 'quality-lsp-v1' : 'quality-core-v1',
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
    case 'Q13@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-definition`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_definition', expectedAction: 'navigation_locations' },
        { probeId: `${task.taskId}-references`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_references', expectedAction: 'navigation_locations' },
        { probeId: `${task.taskId}-implementations`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_implementations', expectedAction: 'navigation_locations' },
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
  options: Readonly<{ signal: AbortSignal; adapter?: QualityAdapter }>,
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

  const adapter = options.adapter ?? (await createNexusAdapterForRoot(root));
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

export type CapabilityEvidenceClass =
  | 'FUNCTIONAL_ONLY'
  | 'RELEVANCE_ELIGIBLE'
  | 'CONTRACT_ONLY'
  | 'REAL_LSP_ELIGIBLE'
  | 'NOT_RUN';

export function classifyCapabilityEvidence(value: Readonly<{
  route: 'synthetic' | 'pinned_embedding' | 'lsp_stub' | 'lsp_real';
  executed: boolean;
  ownerApproved: boolean;
}>): CapabilityEvidenceClass {
  if (!value.executed) return 'NOT_RUN';
  switch (value.route) {
    case 'synthetic':
      return 'FUNCTIONAL_ONLY';
    case 'pinned_embedding':
      return value.ownerApproved ? 'RELEVANCE_ELIGIBLE' : 'FUNCTIONAL_ONLY';
    case 'lsp_stub':
      return 'CONTRACT_ONLY';
    case 'lsp_real':
      return value.ownerApproved ? 'REAL_LSP_ELIGIBLE' : 'NOT_RUN';
    default:
      return 'NOT_RUN';
  }
}

export interface LspStubLocations {
  readonly definition: readonly PublicSourceLocation[];
  readonly references: readonly PublicSourceLocation[];
  readonly implementations: readonly PublicSourceLocation[];
}

export function createLspStubAdapter(
  locations: LspStubLocations,
  options: Readonly<{ truncated?: boolean }> = {},
): QualityAdapter {
  return {
    arm: 'N',
    async invoke(tool): Promise<QualityObservation> {
      const kind: 'definition' | 'references' | 'implementations' | null = (tool === 'get_definition' || tool === 'get_references' || tool === 'get_implementations')
        ? tool.slice(4) as 'definition' | 'references' | 'implementations'
        : null;
      if (kind === null) {
        return {
          status: 'unavailable',
          results: Object.freeze([]),
          exposedBytes: 0,
          sourceAdoptions: Object.freeze([]),
          rawDigest: digest({ reason: 'lsp_stub_tool_unavailable', tool }),
          normalizedPublicArgs: Object.freeze({}),
          reasonCode: 'lsp_stub_tool_unavailable',
        };
      }
      const selected = locations[kind];
      return {
        status: 'ok',
        results: Object.freeze([]),
        exposedBytes: 0,
        sourceAdoptions: Object.freeze([]),
        rawDigest: digest({ kind, locations: selected, truncated: options.truncated ?? false }),
        normalizedPublicArgs: Object.freeze({}),
        navigation: Object.freeze({
          locations: Object.freeze([...selected]),
          truncated: options.truncated ?? false,
          sourceValidation: 'verified',
          capability: 'supported',
        }),
      };
    },
  };
}
export { findRgExecutable };
