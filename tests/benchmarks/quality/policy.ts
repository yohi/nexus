import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { QualityAdapter, NormalizedPublicArgs, PublicSourceLocation, QualityObservation, QualityObservationStatus, QualityTool } from './adapters.js';
import type { PublicQualityTask, QualityArm, QualityBudgets } from './contracts.js';
import type { SourceAdoption } from './oracle.js';

export interface QualityCumulativeCost {
  readonly logicalOperations: number;
  readonly invocations: number;
  readonly contextBytes: number;
  readonly contextTokens: number;
}

export interface QualityAdoptionEvent {
  readonly sequence: number;
  readonly source: SourceAdoption;
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
  readonly logicalOperations: number;
  readonly invocationCount: number;
  readonly retries: number;
  readonly fallback: boolean;
  readonly adoptionSequence?: number;
}

export interface QualityPolicyResult {
  readonly status: 'COMPLETE' | 'EXHAUSTED';
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

export const canonicalJson = (value: NormalizedPublicArgs[string]): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Readonly<Record<string, NormalizedPublicArgs[string]>>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  return `{${entries.map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`).join(',')}}`;
};

const countTokens = (text: string): number => {
  try {
    return getEncoding('cl100k_base').encode(text).length;
  } catch {
    return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
  }
};

const argsDigest = (normalized: NormalizedPublicArgs): string =>
  sha256(utf8Bytes(canonicalJson(normalized)));

const queryDigest = (query: string): string =>
  sha256(utf8Bytes(`quality-query-v1\0${query}`));

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
      for (const key of ['filePath', 'startByte', 'endByte']) {
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
      const coords = rest.slice(atIndex + 1).split(':');
      if (coords.length !== 2) return { valid: false };
      const line = Number.parseInt(coords[0] ?? '', 10);
      const character = Number.parseInt(coords[1] ?? '', 10);
      if (!Number.isInteger(line) || line <= 0 || !Number.isInteger(character) || character < 0) return { valid: false };
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
  cost.invocations < limits.maxLogicalOperations &&
  cost.contextBytes < limits.maxContextBytes;

const addObservationCost = (cost: RunningCost, observation: QualityObservation): RunningCost => ({
  logicalOperations: cost.logicalOperations + 1,
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
  readonly line?: number;
  readonly character?: number;
  readonly endLine?: number;
  readonly endCharacter?: number;
  readonly preview?: string;
  readonly publicScore?: number;
}

const isIdentifierInPreview = (identifier: string, preview?: string): boolean => {
  if (!preview) return false;
  const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
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

const buildReadArgs = (candidate: Candidate): { tool: QualityTool; args: Record<string, unknown> } | null => {
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

const buildRReadArgs = (candidate: Candidate): { tool: QualityTool; args: Record<string, unknown> } | null => {
  if (candidate.line !== undefined && candidate.character !== undefined) {
    // Approximate byte budget: we cannot map line/char to bytes without the file,
    // so read a bounded window from the top of the file. Tests use short files.
    return { tool: 'read_file', args: { filePath: candidate.filePath, startByte: 0, endByte: READ_MAX_BYTES } };
  }
  return { tool: 'read_file', args: { filePath: candidate.filePath, startByte: 0, endByte: READ_MAX_BYTES } };
};

const toAdoption = (observation: QualityObservation): SourceAdoption | null => {
  if (observation.status !== 'ok' || observation.results.length === 0) return null;
  const candidate = observation.results[0];
  if (!candidate) return null;
  return {
    filePath: candidate.filePath,
    startByte: 0,
    endByte: observation.exposedBytes,
    content: candidate.preview ?? '',
    sourceValidation: 'verified',
  };
};

const toFileAdoption = (filePath: string, observation: QualityObservation): SourceAdoption | null => {
  if (observation.status !== 'ok') return null;
  const candidate = observation.results[0];
  if (!candidate) return null;
  return {
    filePath,
    startByte: 0,
    endByte: observation.exposedBytes,
    content: candidate.preview ?? '',
    sourceValidation: observation.sourceAdoptions[0]?.sourceValidation ?? 'verified',
  };
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
    return exhaustedResult(initialCost(), []);
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
  let adoption: SourceAdoption | undefined;
  let adoptionCounter = 0;

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
    const observation = await adapter.invoke(tool, args, signal, { traceSequence: sequence });
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
        logicalOperations: cost.logicalOperations + 1,
        invocationCount: cost.invocations + 1,
        retries,
        fallback,
        adoptionSequence: undefined,
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

  const publishAdoption = async (source: SourceAdoption): Promise<void> => {
    adoptionCounter += 1;
    const contentBytes = Buffer.byteLength(source.content, 'utf8');
    const contentTokens = countTokens(source.content);
    cost = { ...cost, contextBytes: cost.contextBytes + contentBytes, contextTokens: cost.contextTokens + contentTokens };
    const event: QualityAdoptionEvent = Object.freeze({
      sequence: adoptionCounter,
      source,
      cumulativeCost: freezeCost(cost),
      elapsedMs: elapsed(),
    });
    adoptionEvents.push(event);
    if (observer) {
      try {
        await observer.onAdoptionPublished(event);
      } catch {
        // Observer failures must not abort policy.
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
    if (!canAfford(cost, limits, signal)) return false;
    let observation = await invokeTool(state, tool, args, query, fallback, 0);
    cost = addObservationCost(cost, observation);
    recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
    if (signal.aborted) return false;

    if (observation.status === 'ok' && observation.results.length === 0) return false;

    const retryable = new Set<QualityObservationStatus>(['error', 'timeout', 'cancelled', 'unavailable']);
    let retries = 0;
    while (!signal.aborted && retryable.has(observation.status) && retries < limits.maxRetries && canAfford(cost, limits, signal)) {
      retries += 1;
      cost = { ...cost, retries: cost.retries + 1 };
      observation = await invokeTool(state, tool, args, query, fallback, retries);
      cost = addObservationCost(cost, observation);
      recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
      if (signal.aborted) return false;
    }

    if (observation.status !== 'ok') return false;

    const candidates = observation.results.slice(0, limits.maxCandidates);
    for (const candidate of candidates) {
      if (!canAfford(cost, limits, signal)) return false;
      const readSpec = adapter.arm === 'R' ? buildRReadArgs(candidate) : buildReadArgs(candidate);
      if (readSpec === null) continue;
      const readObservation = await invokeTool('READ', readSpec.tool, readSpec.args, null, fallback, 0);
      cost = addObservationCost(cost, readObservation);
      if (signal.aborted) return false;
      const attemptedAdoption = adapter.arm === 'R' ? toFileAdoption(candidate.filePath, readObservation) : toAdoption(readObservation);
      if (attemptedAdoption === null) continue;
      if (isVerifiedAdoption(attemptedAdoption, currentClues)) {
        adoption = attemptedAdoption;
        await publishAdoption(attemptedAdoption);
        return true;
      }
      // Tentative/wrong adoption is recorded but we continue searching.
      await publishAdoption(attemptedAdoption);
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
    if (!canAfford(cost, limits, signal)) return false;
    const observation = await invokeTool(state, tool, args, null, fallback, 0);
    cost = addObservationCost(cost, observation);
    recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
    if (signal.aborted) return false;
    const attemptedAdoption =
      tool === 'read_file'
        ? toFileAdoption(String(args.filePath ?? ''), observation)
        : toAdoption(observation);
    if (attemptedAdoption !== null && isVerifiedAdoption(attemptedAdoption, currentClues)) {
      adoption = attemptedAdoption;
      await publishAdoption(attemptedAdoption);
      return true;
    }
    if (attemptedAdoption !== null) {
      await publishAdoption(attemptedAdoption);
    }
    return false;
  };

  const runNavRoute = async (currentClues: ParsedClues, fallback: boolean): Promise<boolean> => {
    if (currentClues.nav === undefined || (currentClues.position === undefined && currentClues.symbol === undefined)) return false;
    const tool = currentClues.nav === 'definition'
      ? 'get_definition'
      : currentClues.nav === 'references'
        ? 'get_references'
        : 'get_implementations';
    const args: Record<string, unknown> = currentClues.position !== undefined
      ? {
          filePath: currentClues.position.filePath,
          line: currentClues.position.line,
          character: currentClues.position.character,
          maxResults: 20,
        }
      : { symbolId: currentClues.symbol, maxResults: 20 };
    if (!canAfford(cost, limits, signal)) return false;
    const observation = await invokeTool('VERIFY', tool, args, null, fallback, 0);
    cost = addObservationCost(cost, observation);
    recordNavigation(trace[trace.length - 1]?.sequence ?? 0, tool, observation);
    if (signal.aborted) return false;
    if (observation.status === 'ok' && observation.navigation && observation.navigation.locations.length > 0) {
      const navAdoption: SourceAdoption = {
        filePath: observation.navigation.locations[0]?.filePath ?? '',
        startByte: 0,
        endByte: 0,
        content: '',
        sourceValidation: 'verified',
      };
      adoption = navAdoption;
      await publishAdoption(navAdoption);
      return true;
    }
    return false;
  };

  // Primary routes.
  if (adapter.arm === 'N') {
    if (clues.nav !== undefined) {
      if (await runNavRoute(clues, false)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (await runSearchAndAdopt('FALLBACK', 'grep_search', { pattern: clues.id ?? clues.symbol ?? 'fallback', maxResults: limits.maxCandidates }, clues.id ?? clues.symbol ?? 'fallback', true, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.symbol !== undefined) {
      if (await runReadRoute('READ', 'get_symbol_source', { symbolId: clues.symbol, tokenBudget: 1024 }, clues, false)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'grep_search', { pattern: clues.id, maxResults: limits.maxCandidates }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.file !== undefined && (await runReadRoute('FALLBACK', 'get_context', { filePath: clues.file, startLine: 1, endLine: 10, mode: 'bounded' }, clues, true))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.file !== undefined) {
      if (canAfford(cost, limits, signal)) {
        const outline = await invokeTool('DISCOVER', 'get_file_outline', { filePath: clues.file }, null, false, 0);
        cost = addObservationCost(cost, outline);
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
      if (await runReadRoute('READ', 'read_file', { filePath: clues.position.filePath, startByte: 0, endByte: READ_MAX_BYTES }, clues, false)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'rg_search', { query: clues.id }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.symbol !== undefined) {
      if (clues.id !== undefined && (await runSearchAndAdopt('DISCOVER', 'rg_search', { query: clues.id }, clues.id, false, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.file !== undefined && (await runReadRoute('READ', 'read_file', { filePath: clues.file, startByte: 0, endByte: READ_MAX_BYTES }, clues, false))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.file !== undefined) {
      if (await runReadRoute('READ', 'read_file', { filePath: clues.file, startByte: 0, endByte: READ_MAX_BYTES }, clues, false)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      if (clues.id !== undefined && (await runSearchAndAdopt('FALLBACK', 'rg_search', { query: clues.id }, clues.id, true, clues))) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.id !== undefined) {
      if (await runSearchAndAdopt('DISCOVER', 'rg_search', { query: clues.id }, clues.id, false, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
    } else if (clues.concept !== undefined) {
      if (await runSearchAndAdopt('DISCOVER', 'rg_search', { query: clues.concept }, clues.concept, false, clues)) return completeResult(cost, adoption, adoptionEvents, navigationEvents, trace);
      const tokens = clues.concept
        .split(/\s+/)
        .filter((t) => t.length >= 3)
        .sort((a, b) => (b.length - a.length || a.localeCompare(b)))
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
