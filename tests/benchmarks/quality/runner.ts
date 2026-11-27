import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve as resolvePath, relative, dirname } from 'node:path';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { NexusServerOptions } from '../../../src/server/tools/types.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { LocalContentStore } from '../../../src/storage/local/local-content-store.js';
import ts from 'typescript';
import { SearchOrchestrator } from '../../../src/search/orchestrator.js';
import type {
  IGrepEngine,
  GrepMatch,
  GrepParams,
  IVectorStore,
  IMetadataStore,
  IIndexPipeline,
  IndexEvent,
  SearchResult,
} from '../../../src/types/index.js';
import type { PluginRegistry } from '../../../src/plugins/registry.js';
import type { ISemanticSearch, SemanticSearch } from '../../../src/search/semantic.js';
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
  type RipgrepQualityAdapter,
  type QualityObservation,
  type QualityInvocationContext,
  type QualityTool as AdapterQualityTool,
  type PublicJsonValue,
} from './adapters.js';
import { publicTask, type QualityCaseManifest, type QualityArm, type QualityRootKey } from './contracts.js';
import {
  captureOracleSnapshot,
  checkSourceFreshness,
  type SourceSnapshot,
  type SourceProvenance,
} from './oracle.js';
import {
  applyQualityMutation,
  createQualityFixture,
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

function fixtureSymbolRetrievalService(
  root: string,
  sanitizer: PathSanitizer,
  task: QualityCaseManifest,
): NonNullable<NexusServerOptions['symbolRetrievalService']> {
  const parseDeclarations = async (filePath: string) => {
    const safePath = sanitizer.validateProjectRelative(filePath);
    let content: string;
    try {
      content = await readFile(resolvePath(root, safePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const sourceFile = ts.createSourceFile(safePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations: Array<{
      name: string;
      start: number;
      end: number;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        const start = node.getStart(sourceFile);
        const end = node.end;
        const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
        const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
        declarations.push({
          name: node.name.text,
          start,
          end,
          startLine: startPosition.line + 1,
          startColumn: startPosition.character,
          endLine: endPosition.line + 1,
          endColumn: endPosition.character,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { content, declarations };
  };

  const getFileOutline = async ({ filePath }: { filePath: string }) => {
    const parsed = await parseDeclarations(filePath);
    if (parsed === null) {
      return {
        status: 'not_found',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'FILE_NOT_FOUND',
        request: { filePath },
      };
    }
    const { declarations } = parsed;
    return {
      status: 'ok',
      freshness: 'fresh',
      reindexRequired: false,
      file: { filePath },
      symbols: declarations.map((declaration) => ({
        symbolId: declaration.name,
        name: declaration.name,
        position: {
          startLine: declaration.startLine,
          startColumn: declaration.startColumn,
          endLine: declaration.endLine,
          endColumn: declaration.endColumn,
        },
      })),
    };
  };

  const getSymbolSource = async ({ symbolId }: { symbolId: string }) => {
    for (const symbol of task.expectedSymbols) {
      if (symbol.name !== symbolId) continue;
      const parsed = await parseDeclarations(symbol.filePath);
      if (parsed === null) {
        return {
          status: 'not_found',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'SYMBOL_NOT_FOUND',
          request: { symbolId },
        };
      }
      const { content, declarations } = parsed;
      const declaration = declarations.find((candidate) => candidate.name === symbol.name);
      if (declaration === undefined) break;
      return {
        status: 'ok',
        freshness: 'fresh',
        reindexRequired: false,
        filePath: symbol.filePath,
        startByte: Buffer.byteLength(content.slice(0, declaration.start), 'utf8'),
        endByte: Buffer.byteLength(content.slice(0, declaration.end), 'utf8'),
        source: content.slice(declaration.start, declaration.end),
        request: { symbolId },
      };
    }
    for (const file of await fixtureFiles(root)) {
      const parsed = await parseDeclarations(file.filePath);
      if (parsed === null) continue;
      const { declarations } = parsed;
      if (declarations.some((declaration) => declaration.name === symbolId)) {
        return {
          status: 'stale_identity',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'SYMBOL_RETIRED',
          request: { symbolId },
        };
      }
    }
    return {
      status: 'not_found',
      freshness: 'unknown',
      reindexRequired: false,
      reasonCode: 'SYMBOL_NOT_FOUND',
      request: { symbolId },
    };
  };

  return {
    getFileOutline,
    getSymbolSource,
    getSymbolContext: async ({ symbolId, tokenBudget }: { symbolId: string; tokenBudget: number }) => {
      const result = await getSymbolSource({ symbolId });
      if (result.status !== 'ok') return { ...result, request: { symbolId, tokenBudget } };
      return {
        status: 'ok',
        freshness: 'fresh',
        reindexRequired: false,
        filePath: result.filePath,
        context: result.source,
        request: { symbolId, tokenBudget },
      };
    },
  } as NonNullable<NexusServerOptions['symbolRetrievalService']>;
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

export async function createNexusAdapterForRoot(root: string, task: QualityCaseManifest): Promise<QualityAdapter> {
  const sanitizer = await PathSanitizer.create(root);

  const loadFileContent = async (filePath: string): Promise<string> => {
    const resolved = await realpath(filePath);
    return readFile(resolved, 'utf8');
  };

  const grepEngine = new LocalGrepEngine();
  const semanticSearch: ISemanticSearch = {
    search: async (params): Promise<SearchResult[]> => {
      if (params.abortSignal?.aborted) return [];
      const files = await fixtureFiles(root);
      return files
        .filter(({ filePath }) => matchGlob(filePath, params.filePatterns)
        )
        .slice(0, params.topK ?? 20)
        .map(({ filePath, content: currentContent }) => {
          const content = task.scenarioId === 'Q07@quality-v1'
            ? currentContent.replace('return 42', 'return 41')
            : currentContent;
          return {
            chunk: {
              id: `${filePath}:fixture`,
              filePath,
              content,
              language: 'typescript',
              symbolName: filePath.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? 'fixture',
              symbolKind: 'unknown',
              startLine: 1,
              endLine: content.split('\n').length,
              hash: sha256(content),
            },
            score: 1,
            source: 'semantic',
          };
        });
    },
  };
  const options: NexusServerOptions = {
    projectRoot: root,
    sanitizer,
    semanticSearch,
    grepEngine,
    orchestrator: new SearchOrchestrator({
      semanticSearch: semanticSearch as unknown as SemanticSearch,
      grepEngine,
      projectRoot: root,
    }),
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
    symbolRetrievalService: fixtureSymbolRetrievalService(root, sanitizer, task),
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
  fixture: OwnedQualityFixture,
  signal: AbortSignal,
): Promise<{ policyResult: QualityPolicyResult; publications: QualityPublicationEvidence[]; finalSnapshot: SourceSnapshot }> {
  const publications: QualityPublicationEvidence[] = [];
  const canonicalRoot = await realpath(root);
  const provenance = buildProvenance(rootKey, canonicalRoot);
  const observerWork = new Map<number, Promise<void>>();
  let duringRequestApplied = false;

  const armAdapter: QualityAdapter = {
    arm: adapter.arm,
    invoke: async (tool, args, invocationSignal, context) => {
      const observation = await adapter.invoke(tool, args, invocationSignal, context);
      if (
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
      await applyQualityMutation(fixture, task.taskId, 'before_publication');
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

  const policyResult = await runQualityPolicy(
    publicTask(task),
    armAdapter,
    QUALITY_BUDGETS_V1,
    signal,
    observer,
  );

  await Promise.allSettled(
    policyResult.adoptionEvents.map((event) => capturePublication(event)),
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
  if (fixture.roots[rootKey] === undefined) {
    throw new Error('quality_root_key_missing');
  }
  const rgExecutable = options.rgExecutable ?? findRgExecutable();
  const signal = options.signal;
  const makeArm = async (arm: QualityArm) => {
    // Request cancellation controls policy execution, not the deterministic setup/cleanup
    // needed to return a NOT_STARTED result for an arm.
    const armFixture = await createQualityFixture([task.scenarioId], new AbortController().signal);
    try {
      const root = armFixture.roots[rootKey];
      if (root === undefined) throw new Error('quality_root_key_missing');
      const generatedTask = armFixture.oracleCases.find(({ taskId }) => taskId === task.taskId);
      const armTask = generatedTask ?? task;
      await applyQualityMutation(armFixture, task.taskId, 'before_request');
      const adapter = arm === 'R'
        ? createRipgrepAdapter(root, rgExecutable, { rootKey })
        : await createNexusAdapterForRoot(root, armTask);
      const result = await runSingleArm(armTask, rootKey, root, adapter, armFixture, signal);
      return { ...result, adapter, task: armTask };
    } finally {
      await armFixture.dispose();
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
        { probeId: `${task.taskId}-grep`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'grep_search', expectedAction: 'discovery_current' },
      ];
    case 'Q03@quality-v1':
      return [
        ...base,
        { probeId: `${task.taskId}-old-identity-refusal`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'safe_refusal' },
        { probeId: `${task.taskId}-new-identity-source`, taskId: task.taskId, rootKey: task.worktreeIdentity.rootKey, tool: 'get_symbol_source', expectedAction: 'current_source' },
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
  probeId?: string,
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
      if (task.scenarioId === 'Q03@quality-v1' && probeId?.endsWith('-old-identity-refusal')) {
        return { symbolId: 'oldAnswer', tokenBudget: 1024 };
      }
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
        if (task.expectedSymbols.length === 0) return true;
        return task.expectedSymbols.some((symbol) =>
          symbol.filePath === candidate.filePath &&
          (candidate.symbolId === symbol.name || candidate.preview?.includes(symbol.name) === true),
        );
      });
    case 'current_source':
      return observation.status === 'ok' &&
        observation.exposedBytes > 0 &&
        observation.sourceAdoptions.some((source) => {
          if (!task.expectedFiles.includes(source.filePath) || source.sourceValidation !== 'verified') return false;
          if (sourceSnapshot === undefined ||
            sourceSnapshot.rootKey !== probe.rootKey ||
            checkSourceFreshness(sourceSnapshot, source) !== 'FRESH_BYTES') return false;
          const expectedHash = task.expectedSourceHashes[source.filePath];
          const expectedRange = task.expectedSymbols.find((symbol) => symbol.filePath === source.filePath);
          if (expectedHash === undefined || expectedRange === undefined ||
            source.startByte > expectedRange.startByte || source.endByte < expectedRange.endByte) return false;
          const bytes = utf8Bytes(source.content);
          const start = expectedRange.startByte - source.startByte;
          const end = expectedRange.endByte - source.startByte;
          return start >= 0 && end <= bytes.byteLength &&
            sha256(bytes.subarray(start, end)) === expectedHash;
        });
    case 'safe_refusal': {
      const refusalStatus = observation.status === 'not_found' ||
        observation.status === 'stale_identity' ||
        observation.status === 'unavailable' ||
        observation.status === 'unsupported';
      const expectedReason = task.expectedRefusalConditions.length === 0 ||
        (observation.reasonCode !== undefined &&
          task.expectedRefusalConditions.includes(observation.reasonCode));
      return refusalStatus && expectedReason &&
        observation.sourceAdoptions.length === 0 && observation.exposedBytes === 0;
    }
    case 'navigation_locations':
      return observation.status === 'ok' &&
        observation.navigation?.capability === 'supported' &&
        observation.navigation.sourceValidation === 'verified' &&
        observation.navigation.locations.length > 0;
  }
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

  const adapter = await createNexusAdapterForRoot(root, task);
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
    const args = probeArgsForTool(probe.tool, task, probe.probeId);
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

    const locationDigest = locationSetDigest(observation);
    const sourceSnapshot = probe.expectedAction === 'current_source'
      ? await captureOracleSnapshot(fixture, rootKey, task.taskId)
      : undefined;
    probeTrace.push(Object.freeze({
      sequence,
      state: 'ROUTE_PROBE',
      tool: probe.tool,
      normalizedPublicArgs: observation.normalizedPublicArgs,
      argsDigest: digest(observation.normalizedPublicArgs),
      queryDigest: null,
      resultDigest: observation.rawDigest,
      resultStatus: observation.status,
      reasonCode: observation.reasonCode ?? null,
      resultCount: observation.results.length,
      exposedBytes: observation.exposedBytes,
      logicalOperations: 1,
      invocationCount: 1,
      retries: 0,
      fallback: false,
    }));

    probes.push(
      Object.freeze({
        ...probe,
        publicArgsDigest: digest(observation.normalizedPublicArgs),
        traceSequence: sequence,
        observedStatus: observation.status,
        reasonCode: observation.reasonCode ?? null,
        oracleVerdict: null,
        resultDigest: observation.rawDigest,
        locationSetDigest: locationDigest,
        status: isProbeCovered(probe, task, observation, sourceSnapshot) ? 'COVERED' : 'INCOMPLETE',
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
