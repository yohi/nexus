import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import ts from 'typescript';
import {
  queryDigest,
  type NormalizedPublicArgs,
  type PublicSourceLocation,
  type QualityAdapter,
  type QualityObservation,
  type QualityObservationStatus,
  type QualityTool,
} from './adapters.js';
import type { PublicQualityTask, QualityArm, QualityBudgets } from './contracts.js';
import type { SourceAdoption } from './oracle.js';
import { canonicalJson, compareCodeUnitStrings } from './canonical-json.js';

export { canonicalJson } from './canonical-json.js';

export interface QualityCumulativeCost {
  readonly logicalOperations: number;
  readonly invocations: number;
  readonly contextBytes: number;
  readonly contextTokens: number;
}

export interface QualityAdoptionEvent {
  readonly sequence: number;
  readonly source: SourceAdoption;
  readonly candidateRank?: number;
  readonly cumulativeCost: QualityCumulativeCost;
  readonly elapsedMs: number;
}

export interface QualityNavigationEvent {
  readonly sequence: number;
  readonly tool: 'get_definition' | 'get_references' | 'get_implementations';
  readonly status: QualityObservation['status'];
  readonly locations: readonly PublicSourceLocation[];
  readonly truncated: boolean;
  readonly sourceValidation: 'verified' | 'partial' | 'unknown';
  readonly capability: 'supported' | 'unsupported' | 'unavailable' | 'not_checked';
}

export interface QualityTraceEvent {
  readonly sequence: number;
  readonly state: string;
  readonly tool: QualityTool;
  readonly normalizedPublicArgs: NormalizedPublicArgs;
  readonly argsDigest: string;
  readonly queryDigest: string | null;
  readonly resultDigest: string;
  readonly resultStatus: QualityObservation['status'];
  readonly reasonCode: string | null;
  readonly resultCount: number;
  readonly exposedBytes: number;
  readonly requestSnapshotDigest?: string;
  readonly logicalOperations: number;
  readonly invocationCount: number;
  readonly retries: number;
  readonly fallback: boolean;
  readonly adoptionSequence?: number;
}

export interface QualityPolicyResult {
  readonly status: 'COMPLETE' | 'EXHAUSTED' | 'NOT_STARTED';
  readonly adoption?: SourceAdoption;
  readonly adoptionEvents: readonly QualityAdoptionEvent[];
  readonly navigationEvents: readonly QualityNavigationEvent[];
  readonly trace: readonly QualityTraceEvent[];
  readonly logicalOperations: number;
  readonly invocations: number;
  readonly contextBytes: number;
  readonly contextTokens: number;
}

export interface QualityPolicyObserver {
  onAdoptionPublished(event: QualityAdoptionEvent): Promise<void>;
}

const READ_MAX_BYTES = 4096;

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const tokenEncoder = (() => {
  try {
    return getEncoding('cl100k_base');
  } catch {
    return undefined;
  }
})();

const countTokens = (text: string): number => {
  try {
    if (tokenEncoder !== undefined) return tokenEncoder.encode(text).length;
  } catch {
    // Fall back to a byte estimate if tokenization fails for this text.
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
};

const argsDigest = (normalized: NormalizedPublicArgs): string =>
  sha256(utf8Bytes(canonicalJson(normalized)));

const emptyObject: NormalizedPublicArgs = Object.freeze({});

const isPublicJsonValue = (value: unknown): value is NormalizedPublicArgs[string] => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPublicJsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).every(([, entry]) => isPublicJsonValue(entry));
  }
  return false;
};

const asNormalizedArgs = (entries: Readonly<Record<string, unknown>>): NormalizedPublicArgs => {
  const result: Record<string, NormalizedPublicArgs[string]> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (isPublicJsonValue(value)) result[key] = value;
  }
  return Object.freeze(result);
};

const normalizeSearchArgs = (
  args: Readonly<Record<string, unknown>>,
  queryKey: 'pattern' | 'query',
  allowedKeys: readonly string[],
): NormalizedPublicArgs => {
  const allowed = new Set<string>(allowedKeys);
  const result: Record<string, NormalizedPublicArgs[string]> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === queryKey || key === 'grepPattern') continue;
    if (!allowed.has(key)) continue;
    if (isPublicJsonValue(value)) result[key] = value;
  }
  return Object.freeze(result);
};

const normalizedArgsForTool = (tool: QualityTool, args: Readonly<Record<string, unknown>>): NormalizedPublicArgs => {
  switch (tool) {
    case 'rg_search':
      return emptyObject;
    case 'read_file': {
      const out: Record<string, NormalizedPublicArgs[string]> = {};
      for (const key of ['filePath', 'startByte', 'endByte', 'startLine', 'alignUtf8Boundaries']) {
        const value = args[key];
        if (isPublicJsonValue(value)) out[key] = value;
      }
      return Object.freeze(out);
    }
    case 'grep_search':
      return normalizeSearchArgs(args, 'pattern', ['filePattern', 'filePatterns', 'caseSensitive', 'maxResults']);
    case 'semantic_search':
      return normalizeSearchArgs(args, 'query', ['topK', 'filePatterns', 'language']);
    case 'hybrid_search':
      return normalizeSearchArgs(args, 'query', ['topK', 'filePatterns', 'language', 'includeSnippet', 'contextLines']);
    case 'get_context': {
      const out: Record<string, NormalizedPublicArgs[string]> = {};
      for (const key of ['filePath', 'startLine', 'endLine', 'mode', 'symbolName']) {
        const value = args[key];
        if (isPublicJsonValue(value)) out[key] = value;
      }
      return Object.freeze(out);
    }
    case 'get_file_outline':
      return asNormalizedArgs({ filePath: args.filePath });
    case 'get_symbol_source':
    case 'get_symbol_context': {
      const out: Record<string, NormalizedPublicArgs[string]> = {};
      for (const key of ['symbolId', 'tokenBudget']) {
        const value = args[key];
        if (isPublicJsonValue(value)) out[key] = value;
      }
      return Object.freeze(out);
    }
    case 'get_definition':
    case 'get_references':
    case 'get_implementations': {
      const out: Record<string, NormalizedPublicArgs[string]> = {};
      for (const key of ['filePath', 'line', 'character', 'symbolId', 'maxResults']) {
        const value = args[key];
        if (isPublicJsonValue(value)) out[key] = value;
      }
      return Object.freeze(out);
    }
    case 'index_status':
      return emptyObject;
    default:
      return emptyObject;
  }
};

interface ParsedClues {
  id?: string;
  file?: string;
  symbol?: string;
  concept?: string;
  position?: { filePath: string; line: number; character: number };
  nav?: 'definition' | 'references' | 'implementations';
}

const NAV_KINDS = new Set<string>(['definition', 'references', 'implementations']);
const NAV_TOOL_BY_KIND = {
  definition: 'get_definition',
  references: 'get_references',
  implementations: 'get_implementations',
} as const;

const parseClues = (clues: readonly string[]): { readonly valid: true; readonly value: ParsedClues } | { readonly valid: false } => {
  const parsed: ParsedClues = {};
  for (const clue of clues) {
    if (clue.startsWith('id:')) {
      if (parsed.id !== undefined) return { valid: false };
      parsed.id = clue.slice(3);
    } else if (clue.startsWith('file:')) {
      if (parsed.file !== undefined) return { valid: false };
      parsed.file = clue.slice(5);
    } else if (clue.startsWith('symbol:')) {
      if (parsed.symbol !== undefined) return { valid: false };
      parsed.symbol = clue.slice(7);
    } else if (clue.startsWith('concept:')) {
      if (parsed.concept !== undefined) return { valid: false };
      parsed.concept = clue.slice(8);
    } else if (clue.startsWith('position:')) {
      if (parsed.position !== undefined) return { valid: false };
      const rest = clue.slice(9);
      const atIndex = rest.lastIndexOf('@');
      if (atIndex < 0) return { valid: false };
      const filePath = rest.slice(0, atIndex);
      if (filePath.trim().length === 0) return { valid: false };
      const coords = rest.slice(atIndex + 1).split(':');
      if (coords.length !== 2 || coords.some((coordinate) => !/^\d+$/u.test(coordinate))) return { valid: false };
      const line = Number(coords[0]);
      const character = Number(coords[1]);
      if (!Number.isSafeInteger(line) || line <= 0 || !Number.isSafeInteger(character) || character < 0) return { valid: false };
      parsed.position = { filePath, line, character };
    } else if (clue.startsWith('nav:')) {
      if (parsed.nav !== undefined) return { valid: false };
      const kind = clue.slice(4);
      if (!NAV_KINDS.has(kind)) return { valid: false };
      parsed.nav = kind as 'definition' | 'references' | 'implementations';
    } else {
      return { valid: false };
    }
  }
  if (parsed.nav !== undefined && parsed.position === undefined && parsed.symbol === undefined) return { valid: false };
  if (parsed.symbol !== undefined && parsed.id === undefined && parsed.file === undefined) return { valid: false };
  return { valid: true, value: parsed };
};

interface RunningCost extends QualityCumulativeCost {
  retries: number;
}

const initialCost = (): RunningCost => ({
  logicalOperations: 0,
  invocations: 0,
  contextBytes: 0,
  contextTokens: 0,
  retries: 0,
});

const canAfford = (cost: RunningCost, limits: QualityBudgets, signal?: AbortSignal): boolean =>
  !signal?.aborted &&
  cost.logicalOperations < limits.maxLogicalOperations &&
  cost.contextBytes < limits.maxContextBytes;

const canAffordRetry = (cost: RunningCost, limits: QualityBudgets, signal?: AbortSignal): boolean =>
  !signal?.aborted && cost.contextBytes < limits.maxContextBytes;

const addObservationCost = (
  cost: RunningCost,
  observation: QualityObservation,
  newLogicalOperation = true,
): RunningCost => ({
  logicalOperations: cost.logicalOperations + (newLogicalOperation ? 1 : 0),
  invocations: cost.invocations + 1,
  contextBytes: cost.contextBytes + observation.exposedBytes,
  contextTokens: cost.contextTokens + countTokens(observation.results.map((r) => r.preview ?? '').join('\n')),
  retries: cost.retries,
});

const freezeCost = (cost: RunningCost): QualityCumulativeCost =>
  Object.freeze({
    logicalOperations: cost.logicalOperations,
    invocations: cost.invocations,
    contextBytes: cost.contextBytes,
    contextTokens: cost.contextTokens,
  });

interface Candidate {
  readonly filePath: string;
  readonly symbolId?: string;
  readonly matchStartByte?: number;
  readonly line?: number;
  readonly character?: number;
  readonly endLine?: number;
  readonly endCharacter?: number;
  readonly preview?: string;
  readonly publicScore?: number;
}

const isIdentifierInPreview = (identifier: string, preview?: string): boolean => {
  if (!identifier || !preview) return false;
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|[^\\p{ID_Continue}$\\u200c\\u200d])${escapedIdentifier}(?![\\p{ID_Continue}$\\u200c\\u200d])`,
    'u',
  );
  return pattern.test(preview);
};

const isVerifiedAdoption = (adoption: SourceAdoption, clues: ParsedClues): boolean => {
  if (adoption.sourceValidation !== 'verified') return false;
  if (adoption.content.length === 0) return false;
  if (clues.file !== undefined && adoption.filePath !== clues.file) return false;
  if (clues.position !== undefined && adoption.filePath !== clues.position.filePath) return false;
  if (clues.id !== undefined && !isIdentifierInPreview(clues.id, adoption.content)) return false;
  if (clues.symbol !== undefined && !adoption.content.includes(clues.symbol)) return false;
  return clues.file !== undefined ||
    clues.position !== undefined ||
    clues.id !== undefined ||
    clues.symbol !== undefined ||
    clues.concept !== undefined;
};

const buildReadArgs = (candidate: Candidate): { tool: QualityTool; args: Record<string, unknown> } => {
  if (candidate.symbolId !== undefined) {
    return { tool: 'get_symbol_source', args: { symbolId: candidate.symbolId, tokenBudget: 1024 } };
  }
  if (candidate.line !== undefined) {
    const startLine = Math.max(1, candidate.line - 2);
    const endLine = candidate.endLine ?? candidate.line;
    return { tool: 'get_context', args: { filePath: candidate.filePath, startLine, endLine: Math.max(endLine, startLine + 4), mode: 'bounded' } };
  }
  return { tool: 'read_file', args: { filePath: candidate.filePath, startByte: 0, endByte: READ_MAX_BYTES } };
};

const buildRReadArgs = (candidate: Candidate): { tool: QualityTool; args: Record<string, unknown> } => {
  if (candidate.matchStartByte !== undefined) {
    const startByte = Math.max(0, candidate.matchStartByte - Math.floor(READ_MAX_BYTES / 2));
    return {
      tool: 'read_file',
      args: {
        filePath: candidate.filePath,
        startByte,
        endByte: startByte + READ_MAX_BYTES,
        alignUtf8Boundaries: true,
      },
    };
  }
  if (candidate.line !== undefined) {
    return {
      tool: 'read_file',
      args: { filePath: candidate.filePath, startLine: candidate.line, alignUtf8Boundaries: true },
    };
  }
  return {
    tool: 'read_file',
    args: { filePath: candidate.filePath, startByte: 0, endByte: READ_MAX_BYTES, alignUtf8Boundaries: true },
  };
};

const selectTargetDeclaration = (
  adoption: SourceAdoption,
  clues: ParsedClues,
): SourceAdoption => {
  const expectedName = clues.symbol ?? clues.id;
  if (
    adoption.sourceValidation !== 'verified' ||
    expectedName === undefined ||
    !/\.(?:[cm]?tsx?|[cm]?jsx?)$/iu.test(adoption.filePath)
  ) {
    return adoption;
  }

  const sourceFile = ts.createSourceFile(
    adoption.filePath,
    adoption.content,
    ts.ScriptTarget.Latest,
    true,
  );
  let match: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === expectedName &&
      match === undefined
    ) {
      match = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (match === undefined) return adoption;

  const start = match.getStart(sourceFile);
  const end = match.end;
  return Object.freeze({
    ...adoption,
    startByte: adoption.startByte + Buffer.byteLength(adoption.content.slice(0, start), 'utf8'),
    endByte: adoption.startByte + Buffer.byteLength(adoption.content.slice(0, end), 'utf8'),
    content: adoption.content.slice(start, end),
  });
};

const toAdoption = (
  observation: QualityObservation,
  clues: ParsedClues,
): SourceAdoption | null => {
  if (observation.status !== 'ok' || observation.results.length === 0) return null;
  const candidate = observation.results[0];
  if (!candidate) return null;
  const sourceAdoption = observation.sourceAdoptions[0];
  if (sourceAdoption !== undefined) return selectTargetDeclaration(sourceAdoption, clues);
  return selectTargetDeclaration({
      filePath: candidate.filePath,
      startByte: 0,
      endByte: observation.exposedBytes,
      content: candidate.preview ?? '',
      sourceValidation: 'unknown',
    }, clues);
};

const toFileAdoption = (
  filePath: string,
  observation: QualityObservation,
  clues: ParsedClues,
): SourceAdoption | null => {
  if (observation.status !== 'ok') return null;
  const candidate = observation.results[0];
  if (!candidate) return null;
  const sourceAdoption = observation.sourceAdoptions[0];
  if (sourceAdoption !== undefined) return selectTargetDeclaration(sourceAdoption, clues);
  return selectTargetDeclaration({
      filePath,
      startByte: 0,
      endByte: observation.exposedBytes,
      content: candidate.preview ?? '',
      sourceValidation: 'unknown',
    }, clues);
};

export const qualityArmOrder = (sortedTaskIndex: number): readonly [QualityArm, QualityArm] =>
  sortedTaskIndex % 2 === 0 ? Object.freeze(['R', 'N']) : Object.freeze(['N', 'R']);

export async function runQualityPolicy(
  task: PublicQualityTask,
  adapter: QualityAdapter,
  limits: QualityBudgets,
  signal: AbortSignal,
  observer?: QualityPolicyObserver,
): Promise<QualityPolicyResult> {
  if (signal.aborted) {
    return notStartedResult(initialCost());
  }

  const parsed = parseClues(task.initialClues);
  if (!parsed.valid) {
    return exhaustedResult(initialCost(), []);
  }
  const clues = parsed.value;

  const timer = { start: performance.now(), lastElapsed: 0 };
  const elapsed = (): number => {
    const now = performance.now() - timer.start;
    timer.lastElapsed = Math.max(timer.lastElapsed, now);
    return timer.lastElapsed;
  };

  let sequenceCounter = 0;
  const nextTraceSequence = (): number => {
    sequenceCounter += 1;
    return sequenceCounter;
  };

  const trace: QualityTraceEvent[] = [];
  const adoptionEvents: QualityAdoptionEvent[] = [];
  const navigationEvents: QualityNavigationEvent[] = [];
  let cost = initialCost();
  let contextBudgetExceeded = false;
  let adoption: SourceAdoption | undefined;
  let adoptionCounter = 0;

  const canContinue = (): boolean =>
    !contextBudgetExceeded && canAfford(cost, limits, signal);

  const canContinueRetry = (): boolean =>
    !contextBudgetExceeded && canAffordRetry(cost, limits, signal);

  const accountObservation = (
    observation: QualityObservation,
    newLogicalOperation = true,
  ): void => {
    if (observation.exposedBytes > limits.maxContextBytes - cost.contextBytes) {
      contextBudgetExceeded = true;
      cost = {
        ...cost,
        logicalOperations: cost.logicalOperations + (newLogicalOperation ? 1 : 0),
        invocations: cost.invocations + 1,
      };
      return;
    }
    cost = addObservationCost(cost, observation, newLogicalOperation);
  };

  const invokeTool = async (
    state: string,
    tool: QualityTool,
    args: Record<string, unknown>,
    query: string | null,
    fallback: boolean,
    retriesSoFar: number,
  ): Promise<QualityObservation> => {
    const sequence = nextTraceSequence();
    const normalizedPublicArgs = normalizedArgsForTool(tool, args);
    if (signal.aborted) {
      const cancelled: QualityObservation = {
        status: 'cancelled',
        results: Object.freeze([]),
        exposedBytes: 0,
        sourceAdoptions: Object.freeze([]),
        rawDigest: sha256(''),
        normalizedPublicArgs,
        reasonCode: 'REQUEST_CANCELLED',
      };
      recordTrace(state, tool, args, query, fallback, retriesSoFar, sequence, cancelled);
      return cancelled;
    }
    let observation: QualityObservation;
    try {
      observation = await adapter.invoke(tool, args, signal, { traceSequence: sequence });
    } catch {
      observation = {
        status: 'error',
        results: Object.freeze([]),
        exposedBytes: 0,
        sourceAdoptions: Object.freeze([]),
        rawDigest: sha256('quality-adapter-invoke-failed-v1'),
        normalizedPublicArgs,
        reasonCode: 'ADAPTER_INVOKE_FAILED',
      };
    }
    recordTrace(state, tool, args, query, fallback, retriesSoFar, sequence, observation);
    return observation;
  };

  const recordTrace = (
    state: string,
    tool: QualityTool,
    args: Record<string, unknown>,
    query: string | null,
    fallback: boolean,
    retries: number,
    sequence: number,
    observation: QualityObservation,
  ): void => {
    const normalizedPublicArgs = normalizedArgsForTool(tool, args);
    trace.push(
      Object.freeze({
        sequence,
        state,
        tool,
        normalizedPublicArgs,
        argsDigest: argsDigest(normalizedPublicArgs),
        queryDigest: query ? queryDigest(query) : null,
        resultDigest: observation.rawDigest,
        resultStatus: observation.status,
        reasonCode: observation.reasonCode ?? null,
        resultCount: observation.results.length,
        exposedBytes: observation.exposedBytes,
        logicalOperations: cost.logicalOperations + (retries === 0 ? 1 : 0),
        invocationCount: cost.invocations + 1,
        retries,
        fallback,
      }),
    );
  };

  const recordNavigation = (sequence: number, tool: QualityTool, observation: QualityObservation): void => {
    if (tool !== 'get_definition' && tool !== 'get_references' && tool !== 'get_implementations') return;
    if (!observation.navigation) return;
    navigationEvents.push(
      Object.freeze({
        sequence,
        tool,
        status: observation.status,
        locations: observation.navigation.locations,
        truncated: observation.navigation.truncated,
        sourceValidation: observation.navigation.sourceValidation,
        capability: observation.navigation.capability,
      }),
    );
  };

  const publishAdoption = async (
    source: SourceAdoption,
    traceSequence?: number,
    candidateRank?: number,
  ): Promise<void> => {
    adoptionCounter += 1;
    const event: QualityAdoptionEvent = Object.freeze({
      sequence: adoptionCounter,
      source,
      ...(candidateRank !== undefined && Number.isSafeInteger(candidateRank) && candidateRank > 0
        ? { candidateRank }
        : {}),
      cumulativeCost: freezeCost(cost),
      elapsedMs: elapsed(),
    });
    adoptionEvents.push(event);
    if (traceSequence !== undefined) {
      const traceIndex = trace.findIndex((traceEvent) => traceEvent.sequence === traceSequence);
      const traceEvent = trace[traceIndex];
      if (traceEvent !== undefined) {
        trace[traceIndex] = Object.freeze({ ...traceEvent, adoptionSequence: event.sequence });
      }
    }
    if (observer) {
      let cleanupAbortListener = (): void => {};
      const aborted = new Promise<void>((resolve) => {
        const onAbort = (): void => {
          cleanupAbortListener();
          resolve();
        };
        cleanupAbortListener = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => observer.onAdoptionPublished(event))
            .catch(() => undefined),
          aborted,
        ]);
      } catch {
        // Observer failures must not abort policy.
      } finally {
        cleanupAbortListener();
      }
    }
  };

  const runSearchAndAdopt = async (
    state: string,
    tool: QualityTool,
    args: Record<string, unknown>,
    query: string | null,
    fallback: boolean,
    currentClues: ParsedClues,
  ): Promise<boolean> => {
    if (!canContinue()) return false;
    let observation = await invokeTool(state, tool, args, query, fallback, 0);
    accountObservation(observation);
    recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
    if (signal.aborted || contextBudgetExceeded) return false;

    if (observation.status === 'ok' && observation.results.length === 0) return false;

    const retryable = new Set<QualityObservationStatus>(['error', 'timeout', 'cancelled', 'unavailable']);
    let retries = 0;
    while (retryable.has(observation.status) && retries < limits.maxRetries && canContinueRetry()) {
      retries += 1;
      cost = { ...cost, retries: cost.retries + 1 };
      observation = await invokeTool(state, tool, args, query, fallback, retries);
      accountObservation(observation, false);
      recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
      if (signal.aborted || contextBudgetExceeded) return false;
    }

    if (observation.status !== 'ok') return false;

    const candidates = observation.results.slice(0, limits.maxCandidates);
    for (const candidate of candidates) {
      if (!canContinue()) return false;
      const readSpec = adapter.arm === 'R' ? buildRReadArgs(candidate) : buildReadArgs(candidate);
      const readObservation = await invokeTool('READ', readSpec.tool, readSpec.args, null, fallback, 0);
      accountObservation(readObservation);
      if (signal.aborted || contextBudgetExceeded) return false;
      const attemptedAdoption = adapter.arm === 'R'
        ? toFileAdoption(candidate.filePath, readObservation, currentClues)
        : toAdoption(readObservation, currentClues);
      if (attemptedAdoption === null) continue;
      const readTraceSequence = trace[trace.length - 1]?.sequence;
      if (isVerifiedAdoption(attemptedAdoption, currentClues)) {
        adoption = attemptedAdoption;
        await publishAdoption(attemptedAdoption, readTraceSequence, candidate.rank);
        return true;
      }
      // Tentative/wrong adoption is recorded but we continue searching.
      await publishAdoption(attemptedAdoption, readTraceSequence, candidate.rank);
    }
    return false;
  };

  const runReadRoute = async (
    state: string,
    tool: QualityTool,
    args: Record<string, unknown>,
    currentClues: ParsedClues,
    fallback: boolean,
  ): Promise<boolean> => {
    if (!canContinue()) return false;
    const observation = await invokeTool(state, tool, args, null, fallback, 0);
    accountObservation(observation);
    recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
    if (signal.aborted || contextBudgetExceeded) return false;
    const attemptedAdoption =
      tool === 'read_file'
        ? toFileAdoption(String(args.filePath ?? ''), observation, currentClues)
        : toAdoption(observation, currentClues);
    const readTraceSequence = trace[trace.length - 1]?.sequence;
    if (attemptedAdoption !== null && isVerifiedAdoption(attemptedAdoption, currentClues)) {
      adoption = attemptedAdoption;
      await publishAdoption(attemptedAdoption, readTraceSequence);
      return true;
    }
    if (attemptedAdoption !== null) {
      await publishAdoption(attemptedAdoption, readTraceSequence);
    }
    return false;
  };

  const runNavRoute = async (currentClues: ParsedClues, fallback: boolean): Promise<void> => {
    if (currentClues.nav === undefined || (currentClues.position === undefined && currentClues.symbol === undefined)) return;
    const tool = NAV_TOOL_BY_KIND[currentClues.nav];
    const args: Record<string, unknown> = currentClues.position !== undefined
      ? {
          filePath: currentClues.position.filePath,
          line: currentClues.position.line,
          character: currentClues.position.character,
          maxResults: 20,
        }
      : { symbolId: currentClues.symbol, maxResults: 20 };
    if (!canContinue()) return;
    const observation = await invokeTool('VERIFY', tool, args, null, fallback, 0);
    accountObservation(observation);
    recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
  };

  // Primary routes.
  if (adapter.arm === 'N') {
    if (clues.nav !== undefined) {
      await runNavRoute(clues, false);
      const searchPattern = clues.id ?? clues.symbol;
      if (searchPattern !== undefined) {
        if (await runSearchAndAdopt(
          'FALLBACK',
          'grep_search',
          { pattern: searchPattern, maxResults: limits.maxCandidates },
          searchPattern,
          true,
          clues,
        )) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      }
      if (clues.position !== undefined) {
        const startLine = Math.max(1, clues.position.line - 2);
        if (await runReadRoute(
          'FALLBACK',
          'get_context',
          {
            filePath: clues.position.filePath,
            startLine,
            endLine: clues.position.line + 2,
            mode: 'bounded',
          },
          clues,
          true,
        )) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      }
    } else if (clues.symbol !== undefined) {
      if (await runReadRoute('READ', 'get_symbol_source', { symbolId: clues.symbol, tokenBudget: 1024 }, clues, false)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'grep_search', { pattern: clues.id, maxResults: limits.maxCandidates }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.file !== undefined && (await runReadRoute('FALLBACK', 'get_context', { filePath: clues.file, startLine: 1, endLine: 10, mode: 'bounded' }, clues, true))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.file !== undefined) {
      if (canContinue()) {
        const outline = await invokeTool('DISCOVER', 'get_file_outline', { filePath: clues.file }, null, false, 0);
        accountObservation(outline);
      }
      if (await runReadRoute('READ', 'get_context', { filePath: clues.file, startLine: 1, endLine: 10, mode: 'bounded' }, clues, false)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'grep_search', { pattern: clues.id, maxResults: limits.maxCandidates }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.id !== undefined) {
      if (await runSearchAndAdopt('DISCOVER', 'grep_search', { pattern: clues.id, maxResults: limits.maxCandidates }, clues.id, false, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (await runSearchAndAdopt('FALLBACK', 'semantic_search', { query: clues.id, topK: limits.maxCandidates }, clues.id, true, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.concept !== undefined) {
      if (await runSearchAndAdopt('DISCOVER', 'hybrid_search', { query: clues.concept, topK: limits.maxCandidates }, clues.concept, false, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (await runSearchAndAdopt('FALLBACK', 'semantic_search', { query: clues.concept, topK: limits.maxCandidates }, clues.concept, true, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (await runSearchAndAdopt('FALLBACK', 'grep_search', { pattern: clues.concept, maxResults: limits.maxCandidates }, clues.concept, true, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    }
  } else {
    // R arm
    if (clues.nav !== undefined && clues.position !== undefined) {
      if (await runReadRoute(
        'READ',
        'read_file',
        { filePath: clues.position.filePath, startLine: clues.position.line, alignUtf8Boundaries: true },
        clues,
        false,
      )) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'rg_search', { query: clues.id }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.symbol !== undefined) {
      if (clues.id !== undefined && (await runSearchAndAdopt('DISCOVER', 'rg_search', { query: clues.id }, clues.id, false, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.file !== undefined && (await runReadRoute(
        'READ',
        'read_file',
        { filePath: clues.file, startByte: 0, endByte: READ_MAX_BYTES, alignUtf8Boundaries: true },
        clues,
        false,
      ))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.file !== undefined) {
      if (await runReadRoute(
        'READ',
        'read_file',
        { filePath: clues.file, startByte: 0, endByte: READ_MAX_BYTES, alignUtf8Boundaries: true },
        clues,
        false,
      )) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'rg_search', { query: clues.id }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.id !== undefined) {
      if (await runSearchAndAdopt('DISCOVER', 'rg_search', { query: clues.id }, clues.id, false, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.concept !== undefined) {
      if (await runSearchAndAdopt('DISCOVER', 'rg_search', { query: clues.concept }, clues.concept, false, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      const tokens = clues.concept
        .split(/\s+/)
        .filter((t) => t.length >= 3 && t !== clues.concept)
        .sort((a, b) => (b.length - a.length || compareCodeUnitStrings(a, b)))
        .slice(0, 3);
      for (const token of tokens) {
        if (await runSearchAndAdopt('FALLBACK', 'rg_search', { query: token }, token, true, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      }
    }
  }

  return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
}

const completeResult = (
  cost: RunningCost,
  adoption: SourceAdoption | undefined,
  adoptionEvents: QualityAdoptionEvent[],
  navigationEvents: QualityNavigationEvent[],
  trace: QualityTraceEvent[],
): QualityPolicyResult =>
  Object.freeze({
    status: adoption !== undefined ? 'COMPLETE' : 'EXHAUSTED',
    adoption,
    adoptionEvents: Object.freeze([...adoptionEvents]),
    navigationEvents: Object.freeze([...navigationEvents]),
    trace: Object.freeze([...trace]),
    logicalOperations: cost.logicalOperations,
    invocations: cost.invocations,
    contextBytes: cost.contextBytes,
    contextTokens: cost.contextTokens,
  });

const exhaustedResult = (cost: RunningCost, trace: QualityTraceEvent[]): QualityPolicyResult =>
  Object.freeze({
    status: 'EXHAUSTED',
    adoption: undefined,
    adoptionEvents: Object.freeze([]),
    navigationEvents: Object.freeze([]),
    trace: Object.freeze([...trace]),
    logicalOperations: cost.logicalOperations,
    invocations: cost.invocations,
    contextBytes: cost.contextBytes,
    contextTokens: cost.contextTokens,
  });

const notStartedResult = (cost: RunningCost): QualityPolicyResult =>
  Object.freeze({
    status: 'NOT_STARTED',
    adoption: undefined,
    adoptionEvents: Object.freeze([]),
    navigationEvents: Object.freeze([]),
    trace: Object.freeze([]),
    logicalOperations: cost.logicalOperations,
    invocations: cost.invocations,
    contextBytes: cost.contextBytes,
    contextTokens: cost.contextTokens,
  });
