import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Location, LocationLink } from 'vscode-languageserver-protocol';

import type { PathSanitizer } from '../server/path-sanitizer.js';
import { decodeUtf8 } from '../structured/hash.js';
import type { NavigationLocation, NavigationResponse } from './contracts.js';
import {
  checkLspPosition,
  createLspLineTable,
  containsUnsupportedLspLineSeparator,
  readCanonicalSource,
  type LspLineTable,
} from './target-resolver.js';

export type ValidatedNavigationResults = Pick<
  NavigationResponse,
  'locations' | 'truncated' | 'sourceValidation' | 'excludedResultCount'
>;

export type NavigationResultsFailure = { status: 'error' | 'stale' | 'cancelled'; reasonCode: string };

const PROTOCOL_ERROR: NavigationResultsFailure = { status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' };

const isAbortLike = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || (error as Error | undefined)?.name === 'AbortError';

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

const asRangeShape = (value: unknown): LspRange | null =>
  isRecord(value) && isPosition(value.start) && isPosition(value.end) ? { start: value.start, end: value.end } : null;

const isOrdered = (range: LspRange): boolean => comparePositions(range.start, range.end) <= 0;

const contains = (outer: LspRange, inner: LspRange): boolean =>
  comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0;

type Candidate = { uri: string; range: LspRange; enclosing?: LspRange };

/**
 * Shape-checks a raw LSP entry against `Location` / `LocationLink`. Returns null when the entry is
 * shape-invalid: not a record, a non-string `uri`/`targetUri`, or a missing/malformed `range`,
 * `targetRange` or `targetSelectionRange` (positions must be non-negative safe integers, per LSP
 * `uinteger`). Any shape-invalid entry makes the whole reply `error/LSP_PROTOCOL_ERROR`.
 *
 * Semantic problems with a well-shaped entry are NOT decided here; they are omitted and counted
 * (`partial`) by validateEntry(): unsafe/non-file URIs, out-of-root or excluded paths,
 * out-of-range positions, inverted ranges (start > end) and a `targetSelectionRange` outside
 * its `targetRange`.
 */
const toCandidate = (entry: unknown): Candidate | null => {
  if (!isRecord(entry)) return null;
  if ('targetUri' in entry) {
    if (typeof entry.targetUri !== 'string') return null;
    const targetRange = asRangeShape(entry.targetRange);
    const selection = asRangeShape(entry.targetSelectionRange);
    if (targetRange === null || selection === null) return null;
    return { uri: entry.targetUri, range: selection, enclosing: targetRange };
  }
  if (typeof entry.uri !== 'string') return null;
  const range = asRangeShape(entry.range);
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
 * (CRLF/CR line breaks, no split surrogate pairs). Shape-invalid entries reject the whole reply
 * as `error/LSP_PROTOCOL_ERROR`; well-shaped but unsafe entries are omitted and counted;
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
  } else if (isRecord(raw)) {
    entries = [raw]; // single Location (definition/implementation reply)
  } else {
    return PROTOCOL_ERROR;
  }

  // Shape-check every entry before any disk access; one malformed entry rejects the reply.
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    const candidate = toCandidate(entry);
    if (candidate === null) return PROTOCOL_ERROR;
    candidates.push(candidate);
  }

  // Source snapshots are cached by canonical project-relative path, so symlink aliases of one
  // file are validated against a single read.
  const sources = new Map<string, Promise<CurrentSource>>();
  const loadSource = (canonicalPath: string): Promise<CurrentSource> => {
    let pending = sources.get(canonicalPath);
    if (pending === undefined) {
      pending = readValidatedSource(canonicalPath, input);
      sources.set(canonicalPath, pending);
    }
    return pending;
  };

  const unique = new Map<string, NavigationLocation>();
  let excludedResultCount = 0;
  try {
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const location = await validateEntry(candidate, input, loadSource);
      signal?.throwIfAborted();
      if (location === null) {
        excludedResultCount += 1;
        continue;
      }
      unique.set(locationKey(location), location);
    }
  } catch (error) {
    if (isAbortLike(error, signal)) return { status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' };
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

type ValidateInput = Parameters<typeof validateNavigationResults>[0];

/** Returns a validated location, or null when a well-shaped entry cannot be returned safely. */
async function validateEntry(
  candidate: Candidate,
  input: ValidateInput,
  loadSource: (canonicalPath: string) => Promise<CurrentSource>,
): Promise<NavigationLocation | null> {
  // Inverted ranges and a selection outside targetRange are semantic (omitted -> partial),
  // not shape errors.
  if (!isOrdered(candidate.range)) return null;
  if (candidate.enclosing !== undefined) {
    if (!isOrdered(candidate.enclosing) || !contains(candidate.enclosing, candidate.range)) return null;
  }
  const absolutePath = fileUriToAbsolutePath(candidate.uri);
  if (absolutePath === null) return null;
  const canonicalPath = await resolveCanonicalResultPath(absolutePath, input);
  if (canonicalPath === null) return null;
  const source = await loadSource(canonicalPath);
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

/**
 * Lexical + realpath containment for a result URI path, plus the exclusion check on the
 * requested (possibly aliased) path. Returns the canonical project-relative path or null.
 */
async function resolveCanonicalResultPath(absolutePath: string, input: ValidateInput): Promise<string | null> {
  const { sanitizer, signal } = input;
  const relative = path.relative(sanitizer.getProjectRoot(), absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const requestedPath = sanitizer.validateProjectRelative(relative);
    const canonicalAbsolute = await sanitizer.resolveExisting(requestedPath);
    const canonicalPath = path.relative(sanitizer.getProjectRoot(), canonicalAbsolute).split(path.sep).join('/');
    if (canonicalPath === '') return null;
    signal?.throwIfAborted();
    if (canonicalPath !== requestedPath && (await input.isExcluded(requestedPath))) return null;
    signal?.throwIfAborted();
    return canonicalPath;
  } catch (error) {
    if (isAbortLike(error, signal)) throw error;
    // Escaping, missing or unresolvable paths cannot be verified: omit fail-closed.
    return null;
  }
}

/** Loads current canonical source for a result file; any refusal or read problem yields null. */
async function readValidatedSource(canonicalPath: string, input: ValidateInput): Promise<CurrentSource> {
  const { sanitizer, signal } = input;
  try {
    const snapshot = await readCanonicalSource({
      filePath: canonicalPath,
      sanitizer,
      isExcluded: input.isExcluded,
      signal,
    });
    const text = decodeUtf8(snapshot.bytes);
    if (containsUnsupportedLspLineSeparator(text)) return null;
    return { filePath: snapshot.filePath, text, table: createLspLineTable(text) };
  } catch (error) {
    if (isAbortLike(error, signal)) throw error;
    // Refused (CanonicalSourceError), unreadable (EACCES etc.) or undecodable files cannot be
    // verified against current bytes: omit them fail-closed.
    return null;
  }
}
