import { constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PathTraversalError, type PathSanitizer } from '../server/path-sanitizer.js';
import type { SymbolRetrievalService } from '../structured/retrieval-service.js';
import { decodeUtf8, sha256Hex } from '../structured/hash.js';
import {
  LSP_REFERENCES_MAX_RESULTS,
  type LspDocumentLanguageId,
  type NavigationResponse,
  type NavigationToolArgs,
} from './contracts.js';

export interface ResolvedNavigationTarget {
  readonly uri: string;
  readonly filePath: string;
  readonly position: { line: number; character: number }; // LSP zero-based UTF-16
  readonly text: string;
  readonly fileSha256: string;
  readonly languageId: LspDocumentLanguageId; // derived from file extension, not Catalog languageId
}

export type ResolveNavigationTargetResult =
  | { status: 'ok'; target: ResolvedNavigationTarget }
  | NavigationResponse;

/**
 * Raised for malformed tool arguments (mixed/partial target shapes, bad positions, absolute paths).
 * Kept separate from expected NavigationResponse statuses so the tool layer reports it through
 * existing invalid-argument handling. The message never reflects untrusted input.
 */
export class InvalidNavigationArgumentsError extends Error {
  readonly reasonCode = 'INVALID_NAVIGATION_TARGET' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidNavigationArgumentsError';
  }
}

export type NavigationTargetArgs =
  | { readonly kind: 'symbol'; readonly symbolId: string }
  | { readonly kind: 'file'; readonly filePath: string; readonly line: number; readonly character: number };

const MAX_SYMBOL_ID_LENGTH = 4096;
const MAX_FILE_PATH_LENGTH = 4096;

// Exhaustive, case-sensitive extension table (Design §4, F-005).
const LSP_DOCUMENT_LANGUAGE_BY_EXTENSION: Readonly<Record<string, LspDocumentLanguageId>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
};

/**
 * Maps a normalized project-relative file path to its LSP text-document language ID using only
 * the file extension. Never infers the ID from the Structured Catalog's `languageId`.
 */
export const lspDocumentLanguageIdForPath = (filePath: string): LspDocumentLanguageId | null => {
  const extension = path.posix.extname(filePath.replace(/\\/g, '/'));
  if (extension === '') return null;
  return Object.hasOwn(LSP_DOCUMENT_LANGUAGE_BY_EXTENSION, extension)
    ? (LSP_DOCUMENT_LANGUAGE_BY_EXTENSION[extension] ?? null)
    : null;
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Enforces exactly one target shape: `symbolId` alone, or `filePath` + `line` + `character`.
 * Throws InvalidNavigationArgumentsError before any resolution or language-server launch.
 */
export const validateNavigationTargetArgs = (args: NavigationToolArgs): NavigationTargetArgs => {
  if (args === null || typeof args !== 'object') {
    throw new InvalidNavigationArgumentsError('Navigation arguments must be an object');
  }
  if (args.maxResults !== undefined) {
    if (!isNonNegativeInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > LSP_REFERENCES_MAX_RESULTS) {
      throw new InvalidNavigationArgumentsError(
        `maxResults must be an integer between 1 and ${LSP_REFERENCES_MAX_RESULTS}`,
      );
    }
  }

  const hasSymbol = args.symbolId !== undefined;
  const hasFile = args.filePath !== undefined;
  const hasLine = args.line !== undefined;
  const hasCharacter = args.character !== undefined;

  if (hasSymbol) {
    if (hasFile || hasLine || hasCharacter) {
      throw new InvalidNavigationArgumentsError('Provide either symbolId alone or filePath with line and character');
    }
    const symbolId = args.symbolId;
    if (typeof symbolId !== 'string' || symbolId.length === 0 || symbolId.length > MAX_SYMBOL_ID_LENGTH) {
      throw new InvalidNavigationArgumentsError('symbolId must be a non-empty string');
    }
    return { kind: 'symbol', symbolId };
  }

  if (!hasFile || !hasLine || !hasCharacter) {
    throw new InvalidNavigationArgumentsError('Provide either symbolId alone or filePath with line and character');
  }
  const { filePath, line, character } = args;
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.length > MAX_FILE_PATH_LENGTH ||
    filePath.includes('\0') ||
    path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    URI_SCHEME_PATTERN.test(filePath)
  ) {
    throw new InvalidNavigationArgumentsError('filePath must be a project-relative path');
  }
  if (!isNonNegativeInteger(line) || line < 1) {
    throw new InvalidNavigationArgumentsError('line must be a 1-based positive integer');
  }
  if (!isNonNegativeInteger(character)) {
    throw new InvalidNavigationArgumentsError('character must be a 0-based non-negative integer');
  }
  return { kind: 'file', filePath, line, character };
};

// ---------------------------------------------------------------------------
// LSP text coordinates (shared with result validation)

export interface LspLineTable {
  /** UTF-16 index of each line's first code unit. */
  readonly starts: readonly number[];
  /** UTF-16 length of each line excluding its line terminator. */
  readonly lengths: readonly number[];
}

/** Splits text into LSP lines; only `\n`, `\r\n` and `\r` are line terminators. */
export const createLspLineTable = (text: string): LspLineTable => {
  const starts: number[] = [0];
  const lengths: number[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x0a || code === 0x0d) {
      lengths.push(index - (starts[starts.length - 1] ?? 0));
      index += code === 0x0d && text.charCodeAt(index + 1) === 0x0a ? 2 : 1;
      starts.push(index);
      continue;
    }
    index += 1;
  }
  lengths.push(text.length - (starts[starts.length - 1] ?? 0));
  return { starts, lengths };
};

export const containsUnsupportedLspLineSeparator = (text: string): boolean => /[\u2028\u2029]/u.test(text);

export type LspPositionCheck = 'ok' | 'out_of_range' | 'inside_surrogate_pair';

/** Checks a zero-based line / UTF-16 character position against current source text. */
export const checkLspPosition = (
  text: string,
  table: LspLineTable,
  position: { line: number; character: number },
): LspPositionCheck => {
  const { line, character } = position;
  if (!isNonNegativeInteger(line) || !isNonNegativeInteger(character)) return 'out_of_range';
  const start = table.starts[line];
  const length = table.lengths[line];
  if (start === undefined || length === undefined || character > length) return 'out_of_range';
  if (character > 0 && character < length) {
    const before = text.charCodeAt(start + character - 1);
    const after = text.charCodeAt(start + character);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      return 'inside_surrogate_pair';
    }
  }
  return 'ok';
};

// ---------------------------------------------------------------------------
// Canonical current-source snapshots (shared with result validation)

export interface CanonicalSourceSnapshot {
  /** Canonical project-relative path (POSIX separators). */
  readonly filePath: string;
  /** Lexically validated project-relative path as requested. */
  readonly requestedPath: string;
  readonly absolutePath: string;
  readonly uri: string;
  readonly bytes: Uint8Array;
}

export type CanonicalSourceFailure =
  | 'escaped' // lexical or realpath containment failure
  | 'excluded'
  | 'missing'
  | 'not_file'
  | 'changed'; // the canonical file was swapped/replaced while being read

export class CanonicalSourceError extends Error {
  constructor(readonly failure: CanonicalSourceFailure) {
    super(`Canonical source unavailable: ${failure}`);
    this.name = 'CanonicalSourceError';
  }
}

const errnoCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;

const isMissingError = (error: unknown): boolean => {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const OPEN_NO_FOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

const toCanonicalRelative = (sanitizer: PathSanitizer, absolutePath: string): string =>
  path.relative(sanitizer.getProjectRoot(), absolutePath).split(path.sep).join('/');

/**
 * Reads a file's current bytes, constrained to the canonical project root: lexical validation,
 * realpath containment, configured exclusions on both requested and canonical paths, a
 * no-follow open of the canonical path, regular-file check and a post-read containment recheck.
 * Throws CanonicalSourceError for expected refusals; other I/O errors propagate.
 */
export const readCanonicalSource = async (input: {
  filePath: string;
  sanitizer: PathSanitizer;
  isExcluded: (filePath: string) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}): Promise<CanonicalSourceSnapshot> => {
  const { sanitizer, signal } = input;
  let requestedPath: string;
  try {
    requestedPath = sanitizer.validateProjectRelative(input.filePath);
  } catch (error) {
    if (error instanceof PathTraversalError) throw new CanonicalSourceError('escaped');
    throw error;
  }
  if (requestedPath === '') throw new CanonicalSourceError('not_file');

  const resolveCanonical = async (): Promise<string> => {
    try {
      return await sanitizer.resolveExisting(requestedPath);
    } catch (error) {
      if (error instanceof PathTraversalError) throw new CanonicalSourceError('escaped');
      if (isMissingError(error)) throw new CanonicalSourceError('missing');
      throw error;
    }
  };

  signal?.throwIfAborted();
  const absolutePath = await resolveCanonical();
  const filePath = toCanonicalRelative(sanitizer, absolutePath);
  if (filePath === '') throw new CanonicalSourceError('not_file');

  signal?.throwIfAborted();
  if ((await input.isExcluded(requestedPath)) || (filePath !== requestedPath && (await input.isExcluded(filePath)))) {
    throw new CanonicalSourceError('excluded');
  }

  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await fs.open(absolutePath, OPEN_NO_FOLLOW);
  } catch (error) {
    if (isMissingError(error)) throw new CanonicalSourceError('missing');
    // The canonical path had no symlinks at realpath time; ELOOP means it was swapped.
    if (errnoCode(error) === 'ELOOP') throw new CanonicalSourceError('changed');
    throw error;
  }
  let bytes: Uint8Array;
  let openedStat: Awaited<ReturnType<FileHandle['stat']>>;
  try {
    openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new CanonicalSourceError('not_file');
    bytes = new Uint8Array(await handle.readFile({ signal }));
  } catch (error) {
    if (errnoCode(error) === 'EISDIR') throw new CanonicalSourceError('not_file');
    throw error;
  } finally {
    await handle.close();
  }

  // Post-read recheck: the canonical path must still resolve to the same in-root file.
  signal?.throwIfAborted();
  const recheckPath = await resolveCanonical();
  if (recheckPath !== absolutePath) throw new CanonicalSourceError('changed');
  let currentStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    currentStat = await fs.stat(absolutePath);
  } catch (error) {
    if (isMissingError(error)) throw new CanonicalSourceError('missing');
    throw error;
  }
  if (currentStat.ino !== openedStat.ino || currentStat.dev !== openedStat.dev) {
    throw new CanonicalSourceError('changed');
  }

  return { filePath, requestedPath, absolutePath, uri: pathToFileURL(absolutePath).href, bytes };
};

// ---------------------------------------------------------------------------
// Target resolution

const failure = (
  status: NavigationResponse['status'],
  reasonCode: string,
  reindexRequired?: boolean,
): NavigationResponse => ({
  status,
  capability: 'not_checked',
  locations: [],
  truncated: false,
  sourceValidation: 'unknown',
  reasonCode,
  ...(reindexRequired === undefined ? {} : { reindexRequired }),
});

const isAbortLike = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true || (error as Error | undefined)?.name === 'AbortError';

const unexpectedFailure = (error: unknown, signal?: AbortSignal): NavigationResponse => {
  if (isAbortLike(error, signal)) return failure('cancelled', 'REQUEST_CANCELLED');
  return failure('error', errnoCode(error) !== undefined ? 'FILE_READ_ERROR' : 'TARGET_RESOLUTION_FAILED');
};

/**
 * Resolves a navigation target against current disk source inside the canonical worktree.
 * `symbolId` delegates identity verification to SymbolRetrievalService and then rechecks the
 * current bytes against the verified SHA-256; explicit file/position accepts saved dirty or
 * unindexed files. Both derive the LSP document language from the validated file extension.
 * Malformed argument shapes throw InvalidNavigationArgumentsError; all runtime outcomes
 * (including unexpected I/O errors) fail closed as a NavigationResponse.
 */
export async function resolveNavigationTarget(input: {
  args: NavigationToolArgs;
  symbols: SymbolRetrievalService;
  sanitizer: PathSanitizer;
  isExcluded: (filePath: string) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}): Promise<ResolveNavigationTargetResult> {
  const target = validateNavigationTargetArgs(input.args);
  try {
    input.signal?.throwIfAborted();
    return target.kind === 'symbol'
      ? await resolveSymbolTarget(target.symbolId, input)
      : await resolveFileTarget(target, input);
  } catch (error) {
    return unexpectedFailure(error, input.signal);
  }
}

type ResolveContext = Parameters<typeof resolveNavigationTarget>[0];

async function resolveFileTarget(
  target: Extract<NavigationTargetArgs, { kind: 'file' }>,
  input: ResolveContext,
): Promise<ResolveNavigationTargetResult> {
  const read = await readTargetSource(target.filePath, input, {
    missing: () => failure('not_found', 'FILE_NOT_FOUND'),
    changed: () => failure('stale', 'INDEX_FILE_HASH_MISMATCH'),
  });
  if ('status' in read) return read;

  const position = { line: target.line - 1, character: target.character };
  const check = checkLspPosition(read.text, createLspLineTable(read.text), position);
  if (check === 'out_of_range') return failure('not_found', 'POSITION_OUT_OF_RANGE');
  if (check === 'inside_surrogate_pair') return failure('not_found', 'POSITION_INSIDE_SURROGATE_PAIR');

  return { status: 'ok', target: { ...read.target, position } };
}

async function resolveSymbolTarget(symbolId: string, input: ResolveContext): Promise<ResolveNavigationTargetResult> {
  const verified = await input.symbols.resolveVerifiedNavigationTarget({ symbolId, signal: input.signal });
  if (verified.status !== 'ok') {
    return failure(verified.status, verified.reasonCode, verified.reindexRequired);
  }

  const read = await readTargetSource(verified.target.filePath, input, {
    missing: () => failure('stale', 'INDEX_FILE_MISSING', true),
    changed: () => failure('stale', 'INDEX_FILE_HASH_MISMATCH', true),
  });
  if ('status' in read) return read;
  if (read.target.fileSha256 !== verified.target.fileSha256) {
    return failure('stale', 'INDEX_FILE_HASH_MISMATCH', true);
  }

  const position = { line: verified.target.position.line - 1, character: verified.target.position.character };
  if (checkLspPosition(read.text, createLspLineTable(read.text), position) !== 'ok') {
    // Bytes match the verified hash, so an unusable verified position is an internal fault.
    return failure('error', 'INVARIANT_VIOLATION');
  }

  return { status: 'ok', target: { ...read.target, position } };
}

async function readTargetSource(
  filePath: string,
  input: ResolveContext,
  mapping: { missing: () => NavigationResponse; changed: () => NavigationResponse },
): Promise<{ text: string; target: Omit<ResolvedNavigationTarget, 'position'> } | NavigationResponse> {
  let snapshot: CanonicalSourceSnapshot;
  try {
    snapshot = await readCanonicalSource({
      filePath,
      sanitizer: input.sanitizer,
      isExcluded: input.isExcluded,
      signal: input.signal,
    });
  } catch (error) {
    if (!(error instanceof CanonicalSourceError)) throw error;
    switch (error.failure) {
      case 'escaped':
      case 'excluded':
        return failure('excluded', 'PATH_EXCLUDED');
      case 'missing':
        return mapping.missing();
      case 'not_file':
        return failure('not_found', 'FILE_NOT_FOUND');
      case 'changed':
        return mapping.changed();
    }
  }

  // Language is derived only from the validated canonical file extension (F-005).
  const languageId = lspDocumentLanguageIdForPath(snapshot.filePath);
  if (languageId === null) return failure('unsupported', 'unsupported_language');

  let text: string;
  try {
    text = decodeUtf8(snapshot.bytes);
  } catch {
    return failure('error', 'invalid_utf8');
  }
  if (containsUnsupportedLspLineSeparator(text)) return failure('unsupported', 'unsupported_line_separator');
  input.signal?.throwIfAborted();

  return {
    text,
    target: {
      uri: snapshot.uri,
      filePath: snapshot.filePath,
      text,
      fileSha256: sha256Hex(snapshot.bytes),
      languageId,
    },
  };
}
