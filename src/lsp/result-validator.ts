import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Location, LocationLink } from 'vscode-languageserver-protocol';

import type { PathSanitizer } from '../server/path-sanitizer.js';
import { decodeUtf8 } from '../structured/hash.js';
import type { NavigationLocation, NavigationResponse } from './contracts.js';
import {
  checkLspPosition,
  createLspLineTable,
  readCanonicalSource,
  type LspLineTable,
} from './target-resolver.js';

export type ValidatedNavigationResults = Pick<
  NavigationResponse,
  'locations' | 'truncated' | 'sourceValidation' | 'excludedResultCount'
>;

export type NavigationResultsFailure = { status: 'error' | 'stale' | 'cancelled'; reasonCode: string };

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isPosition = (value: unknown): value is LspPosition =>
  isRecord(value) &&
  typeof value.line === 'number' &&
  Number.isSafeInteger(value.line) &&
  value.line >= 0 &&
  typeof value.character === 'number' &&
  Number.isSafeInteger(value.character) &&
  value.character >= 0;

const comparePositions = (a: LspPosition, b: LspPosition): number => a.line - b.line || a.character - b.character;

const asRange = (value: unknown): LspRange | null => {
  if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) return null;
  const range = { start: value.start, end: value.end };
  return comparePositions(range.start, range.end) <= 0 ? range : null;
};

const contains = (outer: LspRange, inner: LspRange): boolean =>
  comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;

const isLocationShaped = (value: unknown): boolean =>
  isRecord(value) && ('targetUri' in value || ('uri' in value && 'range' in value));

type Candidate = { uri: string; range: LspRange; enclosing?: LspRange };

/** Normalizes a raw LSP entry. LocationLink yields targetSelectionRange only if inside targetRange. */
const toCandidate = (entry: unknown): Candidate | null => {
  if (!isRecord(entry)) return null;
  if ('targetUri' in entry) {
    if (typeof entry.targetUri !== 'string') return null;
    const targetRange = asRange(entry.targetRange);
    const selection = asRange(entry.targetSelectionRange);
    if (targetRange === null || selection === null || !contains(targetRange, selection)) return null;
    return { uri: entry.targetUri, range: selection, enclosing: targetRange };
  }
  if (typeof entry.uri !== 'string') return null;
  const range = asRange(entry.range);
  return range === null ? null : { uri: entry.uri, range };
};

/** Accepts only local `file:` URIs (empty/localhost host, no query/fragment) as absolute paths. */
const fileUriToAbsolutePath = (uri: string): string | null => {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:' || url.search !== '' || url.hash !== '') return null;
  if (url.host !== '' && url.host !== 'localhost') return null;
  try {
    const absolutePath = fileURLToPath(url);
    return path.isAbsolute(absolutePath) && !absolutePath.includes('\0') ? absolutePath : null;
  } catch {
    return null;
  }
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareLocations = (a: NavigationLocation, b: NavigationLocation): number =>
  compareStrings(a.filePath, b.filePath) ||
  a.startLine - b.startLine ||
  a.startCharacter - b.startCharacter ||
  a.endLine - b.endLine ||
  a.endCharacter - b.endCharacter;

const locationKey = (location: NavigationLocation): string =>
  JSON.stringify([
    location.filePath,
    location.startLine,
    location.startCharacter,
    location.endLine,
    location.endCharacter,
  ]);

type CurrentSource = { filePath: string; text: string; table: LspLineTable } | null;

/**
 * Validates raw LSP locations against current disk source in the canonical worktree:
 * file-URI parsing, lexical/realpath containment, exclusions, UTF-8 decoding and range bounds
 * (CRLF/CR line breaks, no split surrogate pairs). Unsafe entries are omitted and counted;
 * valid ones are deduplicated, deterministically sorted and capped. `verified` only means the
 * returned positions match current bytes; it never claims project-wide semantic freshness.
 */
export async function validateNavigationResults(input: {
  raw: null | readonly (Location | LocationLink)[];
  sanitizer: PathSanitizer;
  isExcluded: (path: string) => boolean | Promise<boolean>;
  maxResults: number;
  signal?: AbortSignal;
}): Promise<ValidatedNavigationResults | NavigationResultsFailure> {
  const { signal } = input;
  if (signal?.aborted) return { status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' };
  if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1) {
    return { status: 'error', reasonCode: 'INVARIANT_VIOLATION' };
  }

  const raw: unknown = input.raw;
  let entries: readonly unknown[];
  if (raw === null || raw === undefined) {
    entries = [];
  } else if (Array.isArray(raw)) {
    entries = raw;
  } else if (isLocationShaped(raw)) {
    entries = [raw];
  } else {
    return { status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' };
  }

  const sources = new Map<string, Promise<CurrentSource>>();
  const loadSource = (absolutePath: string): Promise<CurrentSource> => {
    let pending = sources.get(absolutePath);
    if (pending === undefined) {
      pending = readValidatedSource(absolutePath, input);
      sources.set(absolutePath, pending);
    }
    return pending;
  };

  const unique = new Map<string, NavigationLocation>();
  let excludedResultCount = 0;
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      const location = await validateEntry(entry, loadSource);
      signal?.throwIfAborted();
      if (location === null) {
        excludedResultCount += 1;
        continue;
      }
      unique.set(locationKey(location), location);
    }
  } catch (error) {
    if (signal?.aborted || (error as Error | undefined)?.name === 'AbortError') {
      return { status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' };
    }
    return { status: 'error', reasonCode: 'RESULT_VALIDATION_FAILED' };
  }

  const sorted = [...unique.values()].sort(compareLocations);
  const truncated = sorted.length > input.maxResults;
  return {
    locations: truncated ? sorted.slice(0, input.maxResults) : sorted,
    truncated,
    sourceValidation: excludedResultCount === 0 ? 'verified' : 'partial',
    excludedResultCount,
  };
}

async function validateEntry(
  entry: unknown,
  loadSource: (absolutePath: string) => Promise<CurrentSource>,
): Promise<NavigationLocation | null> {
  const candidate = toCandidate(entry);
  if (candidate === null) return null;
  const absolutePath = fileUriToAbsolutePath(candidate.uri);
  if (absolutePath === null) return null;
  const source = await loadSource(absolutePath);
  if (source === null) return null;

  const ranges = candidate.enclosing === undefined ? [candidate.range] : [candidate.enclosing, candidate.range];
  for (const range of ranges) {
    if (checkLspPosition(source.text, source.table, range.start) !== 'ok') return null;
    if (checkLspPosition(source.text, source.table, range.end) !== 'ok') return null;
  }
  return {
    filePath: source.filePath,
    startLine: candidate.range.start.line + 1,
    startCharacter: candidate.range.start.character,
    endLine: candidate.range.end.line + 1,
    endCharacter: candidate.range.end.character,
  };
}

/** Loads current canonical source for a result file; any refusal or read problem yields null. */
async function readValidatedSource(
  absolutePath: string,
  input: Parameters<typeof validateNavigationResults>[0],
): Promise<CurrentSource> {
  const { sanitizer, signal } = input;
  // Lexical containment of the URI path against the canonical root before touching disk.
  const relative = path.relative(sanitizer.getProjectRoot(), absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const snapshot = await readCanonicalSource({
      filePath: relative,
      sanitizer,
      isExcluded: input.isExcluded,
      signal,
    });
    const text = decodeUtf8(snapshot.bytes);
    return { filePath: snapshot.filePath, text, table: createLspLineTable(text) };
  } catch (error) {
    if (signal?.aborted || (error as Error | undefined)?.name === 'AbortError') throw error;
    // Refused (CanonicalSourceError), unreadable (EACCES etc.) or undecodable files cannot be
    // verified against current bytes: omit them fail-closed.
    return null;
  }
}
