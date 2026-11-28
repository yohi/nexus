import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve as resolvePath, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Location } from 'vscode-languageserver-protocol';
import { LspNavigationService } from '../../../src/lsp/navigation-service.js';
import type { ILspProvider } from '../../../src/lsp/contracts.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type {
  IGrepEngine,
  GrepMatch,
  GrepParams,
} from '../../../src/types/index.js';
import { createBenchmarkRuntimeFactory } from '../performance/runtime.js';
import { QUALITY_BUDGETS_V1, type ObservationKind } from './contracts.js';
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
  type RipgrepQualityAdapter,
  type QualityObservation,
  type QualityInvocationContext,
  type QualityTool as AdapterQualityTool,
  type PublicJsonValue,
  type PublicSourceLocation,
} from './adapters.js';
import { publicTask, type QualityCaseManifest, type QualityArm, type QualityRootKey } from './contracts.js';
import {
  captureOracleSnapshot,
  gradeTaskSource,
  type SourceSnapshot,
  type SourceProvenance,
} from './oracle.js';
import {
  applyQualityMutation,
  createQualityFixture,
  qualityRuntimeIndexSeed,
  type QualityRuntimeIndexSeed,
  type OwnedQualityFixture,
} from './fixtures.js';
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
  let included = !glob.some((pattern) => !pattern.startsWith('!'));
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

export function simpleGlobMatch(filePath: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**/*') {
    return true;
  }
  if (pattern.startsWith('*.') && filePath.endsWith(pattern.slice(1))) {
    return true;
  }
  if (pattern.includes('*')) {
    const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filePath);
  }
  return filePath === pattern;
}

export function getLineSubmatches(
  needle: string,
  haystack: string,
): GrepMatch['submatches'] {
  if (needle.length === 0) return [];
  const submatches: GrepMatch['submatches'] = [];
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    submatches.push({
      start: pos,
      end: pos + needle.length,
      match: haystack.slice(pos, pos + needle.length),
    });
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return submatches;
}

export class LocalGrepEngine implements IGrepEngine {
  async search(params: GrepParams): Promise<GrepMatch[]> {
    const { query, cwd, glob, maxResults, abortSignal } = params;
    if (query.length === 0) return [];
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
      const submatches = getLineSubmatches(context.needle, haystack).map((match) => ({
        ...match,
        match: line.slice(match.start, match.end),
      }));
      if (submatches.length > 0) {
        context.results.push({ filePath, lineNumber: index + 1, lineText: line, submatches });
        if (context.results.length >= context.limit) return;
      }
    }
  }
}

async function fixtureFiles(root: string, directory = root): Promise<Array<{ filePath: string; content: string }>> {
  const files: Array<{ filePath: string; content: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      files.push(...await fixtureFiles(root, resolvePath(directory, entry.name)));
    } else if (entry.isFile()) {
      const fullPath = resolvePath(directory, entry.name);
      files.push({
        filePath: relative(root, fullPath).replaceAll('\\', '/'),
        content: await readFile(fullPath, 'utf8'),
      });
    }
  }
  return files;
}

export type RuntimeQualityAdapter = QualityAdapter & Readonly<{ close: () => Promise<void> }>;

export async function createNexusAdapterForRoot(
  root: string,
  lspStubLocations?: Readonly<Record<'definition' | 'references' | 'implementations', readonly PublicSourceLocation[]>>,
  indexSeed: readonly QualityRuntimeIndexSeed[] = [],
  afterCanonicalSourceRead?: (filePath: string) => void | Promise<void>,
): Promise<RuntimeQualityAdapter> {
  const assembly = await createBenchmarkRuntimeFactory(
    root,
    undefined,
    undefined,
    afterCanonicalSourceRead,
  )(new AbortController().signal);
  let originals: Array<{ filePath: string; source: string }> = [];
  let seedWritesStarted = false;
  let originalsRestored = false;
  try {
    originals = indexSeed.length === 0
      ? []
      : await Promise.all(indexSeed.map(async ({ filePath }) => ({
          filePath,
          source: await readFile(resolvePath(root, filePath), 'utf8'),
        })));
    seedWritesStarted = indexSeed.length > 0;
    await Promise.all(indexSeed.map(({ filePath, source }) =>
      writeFile(resolvePath(root, filePath), source, 'utf8'),
    ));
    await assembly.runtime.initialize();
    await assembly.runtime.reindex();
    if (indexSeed.length > 0) {
      await assembly.options.watcher.stop();
      await Promise.all(originals.map(({ filePath, source }) =>
        writeFile(resolvePath(root, filePath), source, 'utf8'),
      ));
      originalsRestored = true;
    }
    if (lspStubLocations !== undefined) {
      const toLocations = (items: readonly PublicSourceLocation[]): readonly Location[] =>
        items.map((item) => ({
          uri: pathToFileURL(resolvePath(root, item.filePath)).href,
          range: {
            start: { line: item.startLine - 1, character: item.startCharacter },
            end: { line: item.endLine - 1, character: item.endCharacter },
          },
        }));
      const locations = {
        definition: toLocations(lspStubLocations.definition),
        references: toLocations(lspStubLocations.references),
        implementations: toLocations(lspStubLocations.implementations),
      };
      const symbols = assembly.options.symbolRetrievalService;
      if (symbols === undefined) throw new Error('quality_symbol_retrieval_unavailable');
      const provider: ILspProvider = {
        start() {
          return Promise.resolve({ definition: true, references: true, implementations: true, positionEncoding: 'utf-16' });
        },
        async syncDocument() {},
        async closeDocument() {},
        listOpenDocumentUris() {
          return [];
        },
        navigate({ kind, uri, position }) {
          const requested = lspStubLocations[kind];
          const matchesExpectedLocation = requested.some((item) =>
            uri === pathToFileURL(resolvePath(root, item.filePath)).href &&
            position.line === item.startLine - 1 &&
            position.character === item.startCharacter,
          );
          return Promise.resolve(matchesExpectedLocation ? locations[kind] : []);
        },
        async shutdown() {},
      };
      assembly.options.lspNavigationService = new LspNavigationService({
        projectRoot: root,
        sanitizer: assembly.options.sanitizer,
        symbols,
        isExcluded: () => false,
        acquireProvider() {
          return Promise.resolve({
            status: 'ok',
            provider,
            capabilities: {
              definition: true,
              references: true,
              implementations: true,
              positionEncoding: 'utf-16',
            },
          });
        },
      });
    }
    const adapter = createNexusAdapter(buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime)));
    const normalizePath = (filePath: string): string => {
      if (!isAbsolute(filePath)) return filePath;
      const pathFromRoot = relative(root, filePath).replaceAll('\\', '/');
      return pathFromRoot === '..' || pathFromRoot.startsWith('../') ? filePath : pathFromRoot;
    };
    return Object.freeze({
      arm: adapter.arm,
      invoke: async (...args: Parameters<QualityAdapter['invoke']>) => {
        const observation = await adapter.invoke(...args);
        return Object.freeze({
          ...observation,
          results: Object.freeze(observation.results.map((candidate) =>
            Object.freeze({ ...candidate, filePath: normalizePath(candidate.filePath) }),
          )),
          sourceAdoptions: Object.freeze(observation.sourceAdoptions.map((source) =>
            Object.freeze({ ...source, filePath: normalizePath(source.filePath) }),
          )),
        });
      },
      close: () => assembly.runtime.close(),
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (seedWritesStarted && !originalsRestored) {
      try {
        await Promise.all(originals.map(({ filePath, source }) =>
          writeFile(resolvePath(root, filePath), source, 'utf8'),
        ));
      } catch (restoreError) {
        cleanupErrors.push(restoreError);
      }
    }
    try {
      await assembly.runtime.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'quality_runtime_setup_and_cleanup_failed', { cause: error });
    }
    throw error;
  }
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
  fixture: OwnedQualityFixture,
  signal: AbortSignal,
): Promise<{ policyResult: QualityPolicyResult; publications: QualityPublicationEvidence[]; finalSnapshot: SourceSnapshot }> {
  const publications: QualityPublicationEvidence[] = [];
  const canonicalRoot = await realpath(root);
  const provenance = buildProvenance(rootKey, canonicalRoot);
  const observerWork = new Map<number, Promise<void>>();
  const requestSnapshots = new Map<number, string>();
  let duringRequestApplied = false;
  let beforePublicationWork: Promise<void> | undefined;
  const applyBeforePublication = (): Promise<void> => beforePublicationWork ??= (async () => {
    if (task.scenarioId === 'Q08@quality-v1') {
      const deletion = task.mutationSchedule.find(({ phase, operation }) =>
        phase === 'during_request' && operation === 'delete',
      );
      if (deletion === undefined) return;
      try {
        await lstat(resolvePath(root, deletion.target));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await applyQualityMutation(fixture, task.taskId, 'before_publication');
  })();

  const armAdapter: QualityAdapter = {
    arm: adapter.arm,
    invoke: async (tool, args, invocationSignal, context) => {
      const requestSnapshot = await captureOracleSnapshot(fixture, rootKey, task.taskId);
      requestSnapshots.set(context.traceSequence, requestSnapshot.snapshotDigest);
      const observation = await adapter.invoke(tool, args, invocationSignal, context);
      if (
        task.scenarioId !== 'Q08@quality-v1' &&
        !duringRequestApplied &&
        ['hybrid_search', 'read_file', 'get_context', 'get_symbol_source', 'get_symbol_context'].includes(tool)
      ) {
        duringRequestApplied = true;
        await applyQualityMutation(fixture, task.taskId, 'during_request');
      }
      return observation;
    },
  };

  const capturePublication = (event: Parameters<QualityPolicyObserver['onAdoptionPublished']>[0]): Promise<void> => {
    const existing = observerWork.get(event.sequence);
    if (existing !== undefined) return existing;
    if (signal.aborted) return Promise.resolve();
    const work = (async () => {
      if (signal.aborted) return;
       await applyBeforePublication();
      if (signal.aborted) return;
      const snapshot = await captureOracleSnapshot(
        { root: dirname(canonicalRoot), roots: { [rootKey]: canonicalRoot }, publicTasks: [], oracleCases: [task], dispose: async () => {} } as OwnedQualityFixture,
        rootKey,
        task.taskId,
      );
      if (signal.aborted) return;
      publications.push(
        Object.freeze({
          adoptionSequence: event.sequence,
          snapshot,
          provenance,
          snapshotCapturedAtPublication: true as const,
        }),
      );
    })();
    observerWork.set(event.sequence, work);
    return work;
  };

  const observer: QualityPolicyObserver = {
    onAdoptionPublished: capturePublication,
  };

  const observedPolicyResult = await runQualityPolicy(
    publicTask(task),
    armAdapter,
    QUALITY_BUDGETS_V1,
    signal,
    observer,
  );
  const policyResult: QualityPolicyResult = Object.freeze({
    ...observedPolicyResult,
    trace: Object.freeze(observedPolicyResult.trace.map((event) => {
      const requestSnapshotDigest = requestSnapshots.get(event.sequence);
      return requestSnapshotDigest === undefined
        ? event
        : Object.freeze({ ...event, requestSnapshotDigest });
    })),
  });

  await Promise.allSettled(
    policyResult.adoptionEvents.map((event) => capturePublication(event)),
  );
  if (!signal.aborted && task.scenarioId !== 'Q08@quality-v1') await applyBeforePublication();

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
  options: Readonly<{
    signal: AbortSignal;
    rgExecutable?: string;
    armFixtures?: Readonly<Record<QualityArm, OwnedQualityFixture>>;
  }>,
): Promise<PairedQualityResult> {
  const rootKey = task.worktreeIdentity.rootKey;
  if (fixture.roots[rootKey] === undefined) {
    throw new Error('quality_root_key_missing');
  }
  const rgExecutable = options.rgExecutable ?? findRgExecutable();
  const signal = options.signal;
  const makeArm = async (arm: QualityArm) => {
    // Request cancellation controls policy execution, not the deterministic setup/cleanup
    // needed to return a NOT_STARTED result for an arm.
    const providedFixture = options.armFixtures?.[arm];
    const armFixture = providedFixture ?? await createQualityFixture([task.scenarioId], new AbortController().signal);
    try {
      const root = armFixture.roots[rootKey];
      if (root === undefined) throw new Error('quality_root_key_missing');
      const generatedTask = armFixture.oracleCases.find(({ taskId }) => taskId === task.taskId);
      if (providedFixture !== undefined && generatedTask === undefined) {
        throw new Error('quality_task_not_found');
      }
      const armTask = generatedTask ?? task;
      const adapter = arm === 'R'
        ? createRipgrepAdapter(root, rgExecutable, { rootKey })
        : await createNexusAdapterForRoot(
            root,
            undefined,
            qualityRuntimeIndexSeed(armFixture, task.taskId),
          );
      try {
        await applyQualityMutation(armFixture, task.taskId, 'before_request');
        const result = await runSingleArm(armTask, rootKey, root, adapter, armFixture, signal);
        return { ...result, adapter, task: armTask };
      } finally {
        if ('close' in adapter && typeof adapter.close === 'function') await adapter.close();
      }
    } finally {
      if (providedFixture === undefined) await armFixture.dispose();
    }
  };

  const rArm = await makeArm('R');
  const nArm = await makeArm('N');

  const rResult = gradeQualityArm(rArm.task, rArm.finalSnapshot, rArm.policyResult, rArm.publications);
  const nResult = gradeQualityArm(nArm.task, nArm.finalSnapshot, nArm.policyResult, nArm.publications);

  const baselineRgExecution = buildBaselineRgExecutionEvidence(
    (rArm.adapter as RipgrepQualityAdapter).snapshotRgExecution(),
    rArm.policyResult.trace,
  );

  const outcomes: Record<QualityArm, typeof rResult> = Object.freeze({
    R: rResult,
    N: nResult,
  });

  const discovery: Record<QualityArm, ReturnType<typeof gradeDiscovery>> = Object.freeze({
    R: gradeDiscovery(rArm.task, 'R', rArm.policyResult),
    N: gradeDiscovery(nArm.task, 'N', nArm.policyResult),
  });

  const armFixtureDigests: Record<QualityArm, string> = Object.freeze({
    R: rArm.finalSnapshot.snapshotDigest,
    N: nArm.finalSnapshot.snapshotDigest,
  });
  const fixtureDigest = armFixtureDigests.R;
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
    armFixtureDigests,
    policyVersion: 'quality-policy-v1' as const,
    baselineRgExecution,
    outcomes,
    discovery,
  });
}

export function normalizeProbeArgs(tool: AdapterQualityTool, args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = (() => {
    switch (tool) {
      case 'rg_search':
        return {};
      case 'grep_search':
        return {
          filePattern: args.filePattern,
          filePatterns: args.filePatterns,
          caseSensitive: args.caseSensitive,
          maxResults: args.maxResults,
        };
      case 'semantic_search':
        return { topK: args.topK, filePatterns: args.filePatterns, language: args.language };
      case 'hybrid_search':
        return {
          topK: args.topK,
          filePatterns: args.filePatterns,
          language: args.language,
          includeSnippet: args.includeSnippet,
          contextLines: args.contextLines,
        };
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
  })();
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
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
        { probeId: `${task.taskId}-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q03@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-old-identity-refusal`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'safe_refusal' },
        { probeId: `${task.taskId}-new-identity-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q07@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-hybrid`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'hybrid_search', expectedAction: 'discovery_current' },
      ];
    case 'Q05@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-retired-refusal`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'safe_refusal' },
      ];
    case 'Q06@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-recreated-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q08@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-generation-race`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'stale_during_request' },
      ];
    case 'Q10@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-outline`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_file_outline', expectedAction: 'discovery_current' },
        { probeId: `${task.taskId}-scoped-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q13@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-definition`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_definition', expectedAction: 'navigation_locations' },
        { probeId: `${task.taskId}-references`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_references', expectedAction: 'navigation_locations' },
        { probeId: `${task.taskId}-implementations`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_implementations', expectedAction: 'navigation_locations' },
      ];
    case 'Q02@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-dirty-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q04@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-moved-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q09@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-parser-capability`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_file_outline', expectedAction: 'capability_status' },
      ];
    case 'Q11@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-declaration-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
    case 'Q12@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
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
        { probeId: `${task.taskId}-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
      ];
  }
}

function probeArgsForTool(
  tool: AdapterQualityTool,
  task: QualityCaseManifest,
  probeId?: string,
  resolvedSymbolId?: string,
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
      return resolvedSymbolId === undefined ? {} : { symbolId: resolvedSymbolId, tokenBudget: 1024 };
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

export function isProbeCovered(
  probe: QualityRequiredProbe,
  task: QualityCaseManifest,
  observation: QualityObservation,
  sourceSnapshot?: SourceSnapshot,
): boolean {
  switch (probe.expectedAction) {
    case 'capability_status':
      return observation.status === 'ok';
    case 'discovery_current':
      return observation.status === 'ok' && observation.results.some((candidate) => {
        const expectedFile = task.expectedFiles.includes(candidate.filePath);
        if (!expectedFile) return false;
        if (task.scenarioId === 'Q07@quality-v1' && !candidate.preview?.includes('return 42')) return false;
        if (task.expectedSymbols.length === 0) return true;
        return task.expectedSymbols.some((symbol) =>
          symbol.filePath === candidate.filePath &&
          (candidate.symbolId === symbol.name || candidate.preview?.includes(symbol.name) === true),
        );
      });
    case 'current_source':
      return currentSourceVerdictForProbe(probe, task, observation, sourceSnapshot) === 'CORRECT_CURRENT';
    case 'stale_during_request':
      return observation.status === 'stale' &&
        observation.reasonCode === 'INDEX_FILE_MISSING' &&
        observation.sourceAdoptions.length === 0 &&
        observation.exposedBytes === 0;
    case 'safe_refusal': {
      const refusalStatus = observation.status === 'not_found' ||
        observation.status === 'stale_identity' ||
        observation.status === 'stale' ||
        observation.status === 'unavailable' ||
        observation.status === 'unsupported';
      const expectedReason = task.expectedRefusalConditions.length > 0 &&
        (observation.reasonCode !== undefined &&
          task.expectedRefusalConditions.includes(observation.reasonCode));
      return refusalStatus && expectedReason &&
        observation.sourceAdoptions.length === 0 && observation.exposedBytes === 0;
    }
    case 'navigation_locations':
      return observation.status === 'ok' &&
        observation.navigation?.capability === 'supported' &&
        !observation.navigation.truncated &&
        observation.navigation.sourceValidation === 'verified' &&
        observation.navigation.locations.length === task.expectedLocations.length &&
        task.expectedLocations.every((expected) =>
          observation.navigation?.locations.some((actual) =>
            actual.filePath === expected.filePath &&
            actual.startLine === expected.line &&
            actual.startCharacter === expected.character,
          ) === true,
        );
  }
}

function currentSourceVerdictForProbe(
  probe: QualityRequiredProbe,
  task: QualityCaseManifest,
  observation: QualityObservation,
  sourceSnapshot?: SourceSnapshot,
): ObservationKind {
  if (sourceSnapshot === undefined || sourceSnapshot.rootKey !== probe.rootKey) return 'INCONCLUSIVE';
  const adoptions = observation.sourceAdoptions.filter((source) => source.sourceValidation === 'verified');
  if (adoptions.length === 0) return observation.status === 'not_found' ? 'MISSING' : 'INCONCLUSIVE';

  const provenance = buildProvenance(probe.rootKey, sourceSnapshot.canonicalProjectRoot);
  const verdicts = adoptions.map((adoption) => gradeTaskSource(task, sourceSnapshot, adoption, provenance));
  if (verdicts.includes('WRONG_SOURCE')) return 'WRONG_SOURCE';
  if (verdicts.includes('FALSE_FRESH')) return 'FALSE_FRESH';
  if (observation.status !== 'ok' || observation.exposedBytes <= 0) return 'INCONCLUSIVE';
  if (verdicts.includes('CORRECT_CURRENT')) return 'CORRECT_CURRENT';
  return verdicts[0] ?? 'INCONCLUSIVE';
}

function oracleVerdictForProbe(
  probe: QualityRequiredProbe,
  task: QualityCaseManifest,
  observation: QualityObservation,
  sourceSnapshot?: SourceSnapshot,
  requestMutationApplied = false,
): ObservationKind {
  if (probe.expectedAction === 'current_source') {
    return currentSourceVerdictForProbe(probe, task, observation, sourceSnapshot);
  }
  if (probe.expectedAction === 'stale_during_request') {
    if (!requestMutationApplied) return 'INCONCLUSIVE';
    if (isProbeCovered(probe, task, observation, sourceSnapshot)) return 'CORRECT_REFUSAL';
    if (observation.exposedBytes > 0 || observation.sourceAdoptions.length > 0) return 'FALSE_FRESH';
    return observation.status === 'error' || observation.status === 'timeout'
      ? 'UNAVAILABLE'
      : 'INCONCLUSIVE';
  }
  if (isProbeCovered(probe, task, observation, sourceSnapshot)) {
    return probe.expectedAction === 'safe_refusal' ? 'CORRECT_REFUSAL' : 'CORRECT_CURRENT';
  }
  if (probe.expectedAction === 'navigation_locations' && observation.status === 'ok') {
    if (observation.navigation?.truncated ||
      observation.navigation?.capability !== 'supported' ||
      observation.navigation.sourceValidation !== 'verified') return 'INCONCLUSIVE';
    return 'WRONG_SOURCE';
  }
  if (probe.expectedAction === 'safe_refusal' &&
    (observation.exposedBytes > 0 || observation.sourceAdoptions.length > 0)) return 'WRONG_SOURCE';
  if (probe.expectedAction === 'safe_refusal' &&
    (observation.status === 'not_found' || observation.status === 'stale' ||
      observation.status === 'stale_identity' || observation.status === 'unavailable' ||
      observation.status === 'unsupported')) return 'INCONCLUSIVE';
  if (observation.status === 'not_found' || observation.status === 'stale' ||
    observation.status === 'stale_identity' || observation.status === 'unavailable' ||
    observation.status === 'unsupported') return 'FALSE_REFUSAL';
  return observation.status === 'error' || observation.status === 'timeout'
    ? 'UNAVAILABLE'
    : 'MISSING';
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

  const lspStubLocations = task.evaluationEligibility === 'conditional_lsp' && task.expectedLocations.length > 0
    ? {
        definition: task.expectedLocations.map((location) => ({
          filePath: location.filePath,
          startLine: location.line,
          startCharacter: location.character,
          endLine: location.line,
          endCharacter: location.character + 6,
        })),
        references: task.expectedLocations.map((location) => ({
          filePath: location.filePath,
          startLine: location.line,
          startCharacter: location.character,
          endLine: location.line,
          endCharacter: location.character + 6,
        })),
        implementations: task.expectedLocations.map((location) => ({
          filePath: location.filePath,
          startLine: location.line,
          startCharacter: location.character,
          endLine: location.line,
          endCharacter: location.character + 6,
        })),
      }
    : undefined;
  const sourceMutations = task.mutationSchedule.some(({ phase }) =>
    phase === 'before_request' || phase === 'during_request' || phase === 'before_publication',
  );
  const ownedProbeFixture = options.adapter === undefined && sourceMutations
    ? await createQualityFixture([task.scenarioId], new AbortController().signal)
    : undefined;
  let adapter: QualityAdapter | undefined = options.adapter;
  const ownsAdapter = options.adapter === undefined;

  try {
    const probeTask = ownedProbeFixture?.oracleCases.find(({ taskId }) => taskId === task.taskId) ?? task;
    const probeRoot = ownedProbeFixture?.roots[rootKey] ?? root;
    const probeFixture = ownedProbeFixture ?? fixture;
    let requestMutationArmed = false;
    let requestMutationApplied = false;
    const raceTarget = probeTask.expectedFiles[0];
    const afterCanonicalSourceRead = async (filePath: string): Promise<void> => {
      if (
        !requestMutationArmed ||
        requestMutationApplied ||
        raceTarget === undefined ||
        filePath !== raceTarget ||
        ownedProbeFixture === undefined
      ) return;
      await applyQualityMutation(ownedProbeFixture, probeTask.taskId, 'during_request');
      requestMutationApplied = true;
    };
    if (
      probeTask.scenarioId === 'Q06@quality-v1' &&
      ownedProbeFixture !== undefined
    ) {
      await applyQualityMutation(ownedProbeFixture, probeTask.taskId, 'during_request');
      await applyQualityMutation(ownedProbeFixture, probeTask.taskId, 'before_publication');
    }
    if (adapter === undefined) {
      adapter = await createNexusAdapterForRoot(
        probeRoot,
        lspStubLocations,
        qualityRuntimeIndexSeed(probeFixture, task.taskId),
        probeTask.scenarioId === 'Q08@quality-v1' ? afterCanonicalSourceRead : undefined,
      );
    }
    const requiredProbes = requiredProbesForScenario(probeTask);
    const requiredProbeIds = Object.freeze(requiredProbes.map((p) => p.probeId));
    const probes: QualityProbeEvidence[] = [];
    const probeTrace: QualityTraceEvent[] = [];
    const canonicalRoot = await realpath(probeRoot);
    let sequence = 0;
    const indexedSymbols: Array<Readonly<{ filePath: string; symbolId: string; name: string }>> = [];
    for (const { filePath } of (options.signal.aborted ? [] : await fixtureFiles(probeRoot))) {
      sequence += 1;
      const requestSnapshot = await captureOracleSnapshot(probeFixture, rootKey, probeTask.taskId);
      const args = { filePath };
      let observation: QualityObservation;
      try {
        observation = await adapter.invoke('get_file_outline', args, options.signal, { traceSequence: sequence });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observation = {
          status: 'error',
          results: Object.freeze([]),
          exposedBytes: 0,
          sourceAdoptions: Object.freeze([]),
          rawDigest: digest(message),
          normalizedPublicArgs: Object.freeze(normalizeProbeArgs('get_file_outline', args)) as Readonly<Record<string, PublicJsonValue>>,
          reasonCode: 'ADAPTER_INVOKE_FAILED',
        };
      }
      probeTrace.push(Object.freeze({
        sequence,
        state: 'SETUP',
        tool: 'get_file_outline',
        normalizedPublicArgs: observation.normalizedPublicArgs,
        argsDigest: digest(observation.normalizedPublicArgs),
        queryDigest: null,
        resultDigest: observation.rawDigest,
        resultStatus: observation.status,
        reasonCode: observation.reasonCode ?? null,
        resultCount: observation.results.length,
        exposedBytes: observation.exposedBytes,
        requestSnapshotDigest: requestSnapshot.snapshotDigest,
        logicalOperations: 1,
        invocationCount: 1,
        retries: 0,
        fallback: false,
      }));
      for (const candidate of observation.results) {
        if (candidate.symbolId === undefined || candidate.preview === undefined) continue;
        indexedSymbols.push({ filePath: candidate.filePath, symbolId: candidate.symbolId, name: candidate.preview });
      }
    }
    if (ownedProbeFixture !== undefined) {
      await applyQualityMutation(ownedProbeFixture, probeTask.taskId, 'before_request');
    }
    const setupProofDigest = digest({
      version: 'quality-route-coverage-v3',
      canonicalRoot,
      scenarioId: probeTask.scenarioId,
      setupTrace: probeTrace.map(({ argsDigest, resultDigest, resultStatus, requestSnapshotDigest }) =>
        ({ argsDigest, resultDigest, resultStatus, requestSnapshotDigest })),
    });
    const clueFile = probeTask.initialClues
      .map((clue) => /^file:(.+)$/.exec(clue)?.[1])
      .find((filePath): filePath is string => filePath !== undefined);
    const clueIdentity = probeTask.initialClues
      .map((clue) => /^(?:id|symbol):(.+)$/.exec(clue)?.[1])
      .find((identity): identity is string => identity !== undefined);
    const resolveSymbolId = (probe: QualityRequiredProbe): string | undefined => {
      const candidates = indexedSymbols.filter((candidate) =>
        clueFile === undefined || candidate.filePath === clueFile,
      );
      if (probe.expectedAction === 'safe_refusal' && clueIdentity !== undefined) {
        return indexedSymbols.find(({ name }) => name === clueIdentity)?.symbolId;
      }
      if (probe.expectedAction === 'current_source' && probeTask.scenarioId === 'Q03@quality-v1' && clueIdentity !== undefined) {
        return indexedSymbols.find(({ name }) => name !== clueIdentity)?.symbolId;
      }
      if (clueIdentity !== undefined) {
        return candidates.find(({ name }) => name === clueIdentity)?.symbolId;
      }
      return candidates[0]?.symbolId;
    };
    for (const probe of requiredProbes) {
    if (options.signal.aborted) {
      probes.push(
        Object.freeze({
        ...probe,
        setupProofDigest,
        publicArgsDigest: null,
          traceSequence: null,
          observedStatus: 'cancelled',
          reasonCode: 'REQUEST_CANCELLED',
          oracleVerdict: null,
          publicationSnapshotDigest: null,
          resultDigest: null,
          locationSetDigest: null,
          ...(probe.expectedAction === 'stale_during_request' ? { requestMutationApplied: false } : {}),
          status: 'BLOCKED',
        }),
      );
      continue;
    }

    sequence += 1;
    const args = probeArgsForTool(probe.tool, probeTask, probe.probeId, resolveSymbolId(probe));
    const context: QualityInvocationContext = { traceSequence: sequence };
    const requestSnapshot = await captureOracleSnapshot(probeFixture, rootKey, probeTask.taskId);
    if (probe.expectedAction === 'safe_refusal' && ownedProbeFixture !== undefined) {
      // Resolve the pre-deletion identity first, then test it after the file is gone.
      await applyQualityMutation(ownedProbeFixture, probeTask.taskId, 'before_publication');
    }
    let observation: QualityObservation;
    try {
      if (probe.expectedAction === 'stale_during_request') requestMutationArmed = true;
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
        reasonCode: 'ADAPTER_INVOKE_FAILED',
      };
    } finally {
      requestMutationArmed = false;
    }

    if (
      probe.expectedAction === 'stale_during_request' &&
      ownedProbeFixture !== undefined &&
      requestMutationApplied
    ) {
      await applyQualityMutation(ownedProbeFixture, probeTask.taskId, 'before_publication');
    }
    const locationDigest = locationSetDigest(observation);
    const sourceSnapshot = probe.expectedAction === 'current_source' ||
      probe.expectedAction === 'stale_during_request'
      ? await captureOracleSnapshot(probeFixture, rootKey, probeTask.taskId)
      : undefined;
    probeTrace.push(Object.freeze({
      sequence,
      state: 'CONTRACT_PROBE',
      tool: probe.tool,
      normalizedPublicArgs: observation.normalizedPublicArgs,
      argsDigest: digest(observation.normalizedPublicArgs),
      queryDigest: null,
      resultDigest: observation.rawDigest,
      resultStatus: observation.status,
      reasonCode: observation.reasonCode ?? null,
      resultCount: observation.results.length,
      exposedBytes: observation.exposedBytes,
      requestSnapshotDigest: requestSnapshot.snapshotDigest,
      logicalOperations: 1,
      invocationCount: 1,
      retries: 0,
      fallback: false,
    }));

    const oracleVerdict = oracleVerdictForProbe(
      probe,
      probeTask,
      observation,
      sourceSnapshot,
      requestMutationApplied,
    );
    probes.push(
      Object.freeze({
        ...probe,
        setupProofDigest,
        publicArgsDigest: digest(observation.normalizedPublicArgs),
        traceSequence: sequence,
        observedStatus: observation.status,
        reasonCode: observation.reasonCode ?? null,
        oracleVerdict,
        publicationSnapshotDigest: sourceSnapshot?.snapshotDigest ?? null,
        resultDigest: observation.rawDigest,
        locationSetDigest: locationDigest,
        ...(probe.expectedAction === 'stale_during_request' ? { requestMutationApplied } : {}),
        status: oracleVerdict === 'CORRECT_CURRENT' || oracleVerdict === 'CORRECT_REFUSAL'
          ? 'COVERED'
          : 'INCOMPLETE',
      }),
    );
    }

    const allCovered = probes.length > 0 && probes.every((p) => p.status === 'COVERED');

    return Object.freeze([
      Object.freeze({
        taskId: task.taskId,
        scenarioId: probeTask.scenarioId,
        rootKey,
        requiredProbeIds,
        probes: Object.freeze(probes),
        probeTrace: Object.freeze(probeTrace),
        setupProofDigest,
        status: allCovered ? 'COVERED' : 'INCOMPLETE',
        reasonCode: allCovered ? undefined : 'MISSING_REQUIRED_PROBE',
      }),
    ]);
  } finally {
    try {
      if (ownsAdapter && adapter !== undefined) {
        await (adapter as RuntimeQualityAdapter).close();
      }
    } finally {
      if (ownedProbeFixture !== undefined) await ownedProbeFixture.dispose();
    }
  }
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
    invoke(tool): Promise<QualityObservation> {
      const kind: 'definition' | 'references' | 'implementations' | null = (tool === 'get_definition' || tool === 'get_references' || tool === 'get_implementations')
        ? tool.slice(4) as 'definition' | 'references' | 'implementations'
        : null;
      if (kind === null) {
        return Promise.resolve({
          status: 'unavailable',
          results: Object.freeze([]),
          exposedBytes: 0,
          sourceAdoptions: Object.freeze([]),
          rawDigest: digest({ reason: 'lsp_stub_tool_unavailable', tool }),
          normalizedPublicArgs: Object.freeze({}),
          reasonCode: 'lsp_stub_tool_unavailable',
        });
      }
      const selected = locations[kind];
      return Promise.resolve({
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
      });
    },
  };
}
export { findRgExecutable };
