import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { QualityArm, QualityRootKey } from './contracts.js';
import type { SourceAdoption } from './oracle.js';
import type { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { ToolHandler } from '../../../src/server/tools/types.js';

export interface PublicSourceLocation {
  readonly filePath: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface PublicCandidate {
  readonly filePath: string;
  readonly symbolId?: string;
  readonly publicScore?: number;
  readonly rank: number;
  readonly matchStartByte?: number;
  readonly line?: number;
  readonly character?: number;
  readonly endLine?: number;
  readonly endCharacter?: number;
  readonly preview?: string;
}

type CandidateSeed = Omit<PublicCandidate, 'rank'>;

export type QualityTool =
  | 'rg_search'
  | 'read_file'
  | 'grep_search'
  | 'semantic_search'
  | 'hybrid_search'
  | 'get_context'
  | 'get_file_outline'
  | 'get_symbol_source'
  | 'get_symbol_context'
  | 'get_definition'
  | 'get_references'
  | 'get_implementations'
  | 'index_status';

export type PublicJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly PublicJsonValue[]
  | Readonly<{ [key: string]: PublicJsonValue }>;

export type NormalizedPublicArgs = Readonly<Record<string, PublicJsonValue>>;

export type QualityObservationStatus =
  | 'ok'
  | 'not_found'
  | 'stale'
  | 'stale_identity'
  | 'index_incomplete'
  | 'not_indexed'
  | 'degraded'
  | 'excluded'
  | 'unsupported'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'error';

export interface QualityObservation {
  readonly status: QualityObservationStatus;
  readonly results: readonly PublicCandidate[];
  readonly exposedBytes: number;
  readonly sourceAdoptions: readonly SourceAdoption[];
  readonly rawDigest: string;
  readonly normalizedPublicArgs: NormalizedPublicArgs;
  readonly navigation?: Readonly<{
    locations: readonly PublicSourceLocation[];
    truncated: boolean;
    sourceValidation: 'verified' | 'partial' | 'unknown';
    capability: 'supported' | 'unsupported' | 'unavailable' | 'not_checked';
  }>;
  readonly reasonCode?: string;
}

export interface QualityInvocationContext {
  readonly traceSequence: number;
}

export interface QualityAdapter {
  readonly arm: QualityArm;
  invoke(
    tool: QualityTool,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    context: QualityInvocationContext,
  ): Promise<QualityObservation>;
}

export interface RgSpawnObservation {
  readonly spawnOrdinal: number;
  readonly policyTraceSequence: number;
  readonly rootKey: QualityRootKey;
  readonly searchScope: '.';
  readonly normalizedObservedArgv: readonly string[];
  readonly queryDigest: string;
  readonly observedExclusions: readonly string[];
  readonly readMaxBytesPerCall: 4096;
  readonly observedContractDigest: string;
}

export interface RgExecutionSnapshot {
  readonly initializedContractDigest: string;
  readonly rgSearchInvocationCount: number;
  readonly spawnAttemptCount: number;
  readonly spawns: readonly RgSpawnObservation[];
  readonly evidenceComplete: boolean;
}

export interface RipgrepQualityAdapter extends QualityAdapter {
  readonly rgExecutionContractDigest: string;
  snapshotRgExecution(): RgExecutionSnapshot;
}

type ToolHandlers = ReturnType<typeof buildToolHandlers>;

const READ_MAX_BYTES = 4096 satisfies number;
const READ_SCAN_CHUNK_BYTES = 256;

interface ReadByteBudget {
  bytesRead: number;
}

const readWithinBudget = async (
  fileHandle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  length: number,
  position: number,
  budget: ReadByteBudget,
): Promise<number> => {
  const remaining = READ_MAX_BYTES - budget.bytesRead;
  if (length <= 0 || remaining <= 0) return 0;
  const { bytesRead } = await fileHandle.read(buffer, 0, Math.min(length, remaining), position);
  budget.bytesRead += bytesRead;
  return bytesRead;
};
const SEARCH_SCOPE = '.' as const satisfies '.';
const DEFAULT_ROOT_KEY: QualityRootKey = 'single';
const RG_ARG_QUERY_PLACEHOLDER = '<public-query>';

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  const qualityStatuses = new Set<string>([
  'ok',
  'not_found',
  'stale',
  'stale_identity',
  'index_incomplete',
  'not_indexed',
  'degraded',
  'excluded',
  'unsupported',
  'unavailable',
  'timeout',
  'cancelled',
  'error',
  'failed',
]);

const isQualityStatus = (value: unknown): value is QualityObservationStatus =>
  typeof value === 'string' && qualityStatuses.has(value);

const insideRoot = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

const toForwardSlashes = (path: string): string => path.split(sep).join('/');

const isPublicJsonValue = (value: unknown): value is PublicJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPublicJsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).every(([, entry]) => isPublicJsonValue(entry));
  }
  return false;
};

const asNormalizedArgs = (
  entries: Readonly<Record<string, unknown>>,
): NormalizedPublicArgs => {
  const result: Record<string, PublicJsonValue> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (isPublicJsonValue(value)) {
      result[key] = value;
    }
  }
  return Object.freeze(result);
};

const clampInt = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
};

const findLineStartByte = async (
  fileHandle: Awaited<ReturnType<typeof open>>,
  lineNumber: number,
  fileLength: number,
  signal: AbortSignal,
  budget: ReadByteBudget,
): Promise<number | undefined> => {
  if (lineNumber <= 1) return 0;

  const buffer = Buffer.alloc(READ_SCAN_CHUNK_BYTES);
  let scannedBytes = 0;
  let currentLine = 1;
  while (scannedBytes < fileLength && !signal.aborted) {
    const remaining = READ_MAX_BYTES - budget.bytesRead;
    if (remaining <= 0) return undefined;
    const requestedBytes = Math.min(buffer.length, fileLength - scannedBytes, remaining);
    const bytesRead = await readWithinBudget(fileHandle, buffer, requestedBytes, scannedBytes, budget);
    if (bytesRead === 0) return fileLength;

    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      currentLine += 1;
      if (currentLine === lineNumber) return scannedBytes + index + 1;
    }
    scannedBytes += bytesRead;
  }
  return fileLength;
};

const utf8SequenceLength = (leadingByte: number | undefined): number => {
  if (leadingByte === undefined) return 0;
  if (leadingByte <= 0x7f) return 1;
  if (leadingByte >= 0xc2 && leadingByte <= 0xdf) return 2;
  if (leadingByte >= 0xe0 && leadingByte <= 0xef) return 3;
  if (leadingByte >= 0xf0 && leadingByte <= 0xf4) return 4;
  return 0;
};

const isUtf8SequenceAt = (bytes: Buffer, start: number, length: number): boolean => {
  if (length < 2 || start + length > bytes.length) return false;
  const first = bytes[start];
  const second = bytes[start + 1];
  if (first === undefined || second === undefined) return false;
  if ((second & 0xc0) !== 0x80) return false;
  if (first === 0xe0 && second < 0xa0) return false;
  if (first === 0xed && second > 0x9f) return false;
  if (first === 0xf0 && second < 0x90) return false;
  if (first === 0xf4 && second > 0x8f) return false;
  for (let index = 2; index < length; index += 1) {
    const continuation = bytes[start + index];
    if (continuation === undefined || (continuation & 0xc0) !== 0x80) return false;
  }
  return true;
};

const readBoundaryProbe = async (
  fileHandle: Awaited<ReturnType<typeof open>>,
  boundary: number,
  fileLength: number,
  budget: ReadByteBudget,
): Promise<{ readonly bytes: Buffer; readonly offset: number }> => {
  const offset = Math.max(0, boundary - 3);
  const probeLength = Math.min(7, fileLength - offset);
  if (probeLength > READ_MAX_BYTES - budget.bytesRead) {
    throw new Error('READ_BYTE_BUDGET_EXCEEDED');
  }
  const buffer = Buffer.alloc(probeLength);
  const bytesRead = await readWithinBudget(fileHandle, buffer, buffer.length, offset, budget);
  if (bytesRead !== probeLength) {
    throw new Error('READ_BYTE_BUDGET_EXCEEDED');
  }
  return { bytes: buffer.subarray(0, bytesRead), offset };
};

const findUtf8CodePointCrossingBoundary = (
  probe: { readonly bytes: Buffer; readonly offset: number },
  boundary: number,
): { readonly startByte: number; readonly endByte: number } | undefined => {
  const boundaryIndex = boundary - probe.offset;
  const firstCandidate = Math.max(0, boundaryIndex - 3);
  for (let index = firstCandidate; index < boundaryIndex; index += 1) {
    const length = utf8SequenceLength(probe.bytes[index]);
    if (
      length > 1 &&
      index + length > boundaryIndex &&
      isUtf8SequenceAt(probe.bytes, index, length)
    ) {
      return {
        startByte: probe.offset + index,
        endByte: probe.offset + index + length,
      };
    }
  }
  return undefined;
};

const alignUtf8Window = async (
  fileHandle: Awaited<ReturnType<typeof open>>,
  startByte: number,
  endByte: number,
  fileLength: number,
  budget: ReadByteBudget,
): Promise<{ readonly startByte: number; readonly endByte: number }> => {
  const startProbe = await readBoundaryProbe(fileHandle, startByte, fileLength, budget);
  const startCodePoint = findUtf8CodePointCrossingBoundary(startProbe, startByte);
  const alignedStartByte = startCodePoint?.endByte ?? startByte;

  const endProbe = await readBoundaryProbe(fileHandle, endByte, fileLength, budget);
  const endCodePoint = findUtf8CodePointCrossingBoundary(endProbe, endByte);
  const alignedEndByte = endCodePoint?.startByte ?? endByte;

  if (alignedStartByte > alignedEndByte) {
    const emptyRangeByte = Math.min(endByte, Math.max(startByte, alignedStartByte));
    return { startByte: emptyRangeByte, endByte: emptyRangeByte };
  }

  return {
    startByte: alignedStartByte,
    endByte: alignedEndByte,
  };
};

const RG_ARGV_POLICY = Object.freeze({
  fixedArguments: Object.freeze([
    '--no-config',
    '--no-ignore',
    '--hidden',
    '--json',
    '--sort',
    'path',
    '--fixed-strings',
  ]),
  exclusions: Object.freeze([
    '!.git/**',
    '!**/.git/**',
    '!node_modules/**',
    '!**/node_modules/**',
    '!.nexus/**',
    '!**/.nexus/**',
  ]),
});

const FIXED_ARGV_PREFIX = Object.freeze([
  ...RG_ARGV_POLICY.fixedArguments,
  ...RG_ARGV_POLICY.exclusions.flatMap((exclusion) => ['--glob', exclusion]),
]);

const rgExclusions = RG_ARGV_POLICY.exclusions;

const buildFixedRgArgv = (publicQuery: string): readonly string[] =>
  Object.freeze([...FIXED_ARGV_PREFIX, '--', publicQuery, SEARCH_SCOPE]);

const sanitizedRgArgv = (): readonly string[] =>
  Object.freeze([
    ...FIXED_ARGV_PREFIX,
    '--',
    RG_ARG_QUERY_PLACEHOLDER,
    SEARCH_SCOPE,
  ]);

const contractDigest = (
  argv: readonly string[],
  rootKey: QualityRootKey,
): string => {
  const payload = JSON.stringify({
    argv: [...argv],
    rootKey,
    searchScope: SEARCH_SCOPE,
    readMaxBytesPerCall: READ_MAX_BYTES,
    policyVersion: 'quality-policy-v1',
  });
  return sha256(utf8Bytes(payload));
};

export const queryDigest = (publicQuery: string): string =>
  sha256(utf8Bytes(`quality-query-v1\0${publicQuery}`));

const redactArgvQuery = (argv: readonly string[], publicQuery: string): readonly string[] => {
  if (argv.length < 3) return Object.freeze([...argv]);
  const operandIndex = argv.length - 2;
  const scopeIndex = argv.length - 1;
  const separatorIndex = argv.length - 3;
  const prefix = argv.slice(0, separatorIndex);
  if (
    argv[separatorIndex] !== '--' ||
    argv[operandIndex] !== publicQuery ||
    argv[scopeIndex] !== SEARCH_SCOPE ||
    prefix.length !== FIXED_ARGV_PREFIX.length ||
    !prefix.every((value, index) => value === FIXED_ARGV_PREFIX[index])
  ) {
    throw new Error('quality_rg_argv_structure_invalid');
  }
  return Object.freeze([
    ...prefix,
    '--',
    RG_ARG_QUERY_PLACEHOLDER,
    SEARCH_SCOPE,
  ]);
};

const validatePublicQuery = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/[\r\n\0]/.test(value)) return null;
  if (value.startsWith('-')) return null;
  if (value === SEARCH_SCOPE) return null;
  return value;
};

const isTimeoutSignal = (signal: AbortSignal): boolean => {
  const reason: unknown = signal.reason;
  return (
    reason instanceof DOMException &&
    (reason.name === 'TimeoutError' || reason.code === 23)
  );
};

const spawnRg = async (
  rgExecutable: string,
  argv: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<
  | {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      signalName: string | null;
      launched: true;
      error?: string;
    }
  | { stdout: string; stderr: string; exitCode: null; signalName: null; launched: false }
> => {
  if (signal.aborted) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      signalName: null,
      launched: false,
    };
  }

  const child = spawn(rgExecutable, [...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const onStdoutData = (chunk: string): void => {
    stdoutChunks.push(chunk);
  };
  const onStderrData = (chunk: string): void => {
    stderrChunks.push(chunk);
  };
  child.stdout.on('data', onStdoutData);
  child.stderr.on('data', onStderrData);

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result: {
      readonly exitCode: number | null;
      readonly signalName: string | null;
      readonly error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      signal.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      resolve({ stdout, stderr, launched: true, ...result });
    };

    const onError = (error: Error): void => {
      settle({ exitCode: null, signalName: null, error: error.message });
    };
    const onClose = (code: number | null, signalName: string | null): void => {
      settle({ exitCode: code, signalName });
    };
    const onAbort = (): void => {
      settle({ exitCode: null, signalName: null });
    };

    child.on('error', onError);
    child.on('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

type RgParseResult =
  | { readonly kind: 'ok'; readonly candidates: CandidateSeed[] }
  | { readonly kind: 'error'; readonly reason: string };

const byteOffsetToUtf16 = (text: string, byteOffset: number): number | undefined => {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) return undefined;
  let utf16Index = 0;
  let byteIndex = 0;
  for (const codePoint of text) {
    if (byteIndex === byteOffset) return utf16Index;
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (byteIndex + codePointBytes > byteOffset) return undefined;
    byteIndex += codePointBytes;
    utf16Index += codePoint.length;
  }
  return byteIndex === byteOffset ? utf16Index : undefined;
};

const decodeRgBytes = (encoded: string): string | null => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
};

const parseRgMatches = (stdout: string): RgParseResult => {
  const candidates: CandidateSeed[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { kind: 'error', reason: 'RG_INVALID_JSON' };
    }
    if (!event || typeof event !== 'object') {
      return { kind: 'error', reason: 'RG_INVALID_JSON' };
    }
    const typedEvent = event as { type?: string; data?: unknown };
    if (typedEvent.type !== 'match') continue;
    const data = typedEvent.data;
    if (!data || typeof data !== 'object') {
      return { kind: 'error', reason: 'RG_INVALID_JSON' };
    }
    const typedData = data as {
      path?: { text?: string } | string;
      lines?: { text?: string; bytes?: string } | string;
      line_number?: number;
      absolute_offset?: number;
      submatches?: Array<{ match?: { text?: string } | string; start?: number; end?: number }>;
    };

    const filePath =
      typeof typedData.path === 'string'
        ? typedData.path
        : typeof typedData.path === 'object' && typedData.path !== null
          ? typedData.path.text
          : undefined;
    let lineText: string;
    if (typeof typedData.lines === 'string') {
      lineText = typedData.lines;
    } else if (typeof typedData.lines === 'object' && typedData.lines !== null) {
      if (typeof typedData.lines.text === 'string') {
        lineText = typedData.lines.text;
      } else if (typeof typedData.lines.bytes === 'string') {
        const decoded = decodeRgBytes(typedData.lines.bytes);
        if (decoded === null) return { kind: 'error', reason: 'RG_INVALID_UTF8' };
        lineText = decoded;
      } else {
        lineText = '';
      }
    } else {
      lineText = '';
    }
    const lineNumber =
      typeof typedData.line_number === 'number' && Number.isFinite(typedData.line_number)
        ? Math.trunc(typedData.line_number)
        : undefined;
    const absoluteOffset =
      typeof typedData.absolute_offset === 'number' &&
      Number.isSafeInteger(typedData.absolute_offset) &&
      typedData.absolute_offset >= 0
        ? typedData.absolute_offset
        : undefined;
    if (typedData.absolute_offset !== undefined && absoluteOffset === undefined) {
      return { kind: 'error', reason: 'RG_INVALID_BYTE_OFFSET' };
    }
    if (!filePath || lineNumber === undefined) {
      return { kind: 'error', reason: 'RG_INVALID_JSON' };
    }

    const submatches = Array.isArray(typedData.submatches) ? typedData.submatches : [];
    if (submatches.length === 0) {
      candidates.push({
        filePath,
        line: lineNumber,
        character: 0,
        endLine: lineNumber,
        endCharacter: lineText.length,
        preview: lineText,
        ...(absoluteOffset === undefined ? {} : { matchStartByte: absoluteOffset }),
      });
      continue;
    }

    for (const submatch of submatches) {
      if (!submatch || typeof submatch !== 'object') {
        return { kind: 'error', reason: 'RG_INVALID_JSON' };
      }
      const matchText =
        typeof submatch.match === 'string'
          ? submatch.match
          : typeof submatch.match === 'object' && submatch.match !== null
            ? submatch.match.text
            : '';
      const startByte =
        typeof submatch.start === 'number' && Number.isFinite(submatch.start)
          ? Math.trunc(submatch.start)
          : 0;
      const endByte =
        typeof submatch.end === 'number' && Number.isFinite(submatch.end)
          ? Math.trunc(submatch.end)
          : startByte;
      const startChar = byteOffsetToUtf16(lineText, startByte);
      const endChar = byteOffsetToUtf16(lineText, endByte);
      if (startChar === undefined || endChar === undefined || endChar < startChar) {
        return { kind: 'error', reason: 'RG_INVALID_BYTE_OFFSET' };
      }
      const matchStartByte = absoluteOffset === undefined ? undefined : absoluteOffset + startByte;
      if (matchStartByte !== undefined && !Number.isSafeInteger(matchStartByte)) {
        return { kind: 'error', reason: 'RG_INVALID_BYTE_OFFSET' };
      }
      candidates.push({
        filePath,
        line: lineNumber,
        character: startChar,
        endLine: lineNumber,
        endCharacter: endChar,
        preview: matchText || lineText,
        ...(matchStartByte === undefined ? {} : { matchStartByte }),
      });
    }
  }
  return { kind: 'ok', candidates };
};

const sortCandidateSeeds = (
  left: { candidate: CandidateSeed; originalRank: number },
  right: { candidate: CandidateSeed; originalRank: number },
): number => {
  const leftScore = left.candidate.publicScore;
  const rightScore = right.candidate.publicScore;
  const leftHasScore = leftScore !== undefined;
  const rightHasScore = rightScore !== undefined;

  if (leftHasScore && !rightHasScore) return -1;
  if (!leftHasScore && rightHasScore) return 1;
  if (leftHasScore && rightHasScore && leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  if (left.candidate.filePath !== right.candidate.filePath) {
    return left.candidate.filePath < right.candidate.filePath ? -1 : 1;
  }
  const lineDiff = (left.candidate.line ?? 0) - (right.candidate.line ?? 0);
  if (lineDiff !== 0) return lineDiff;
  const charDiff = (left.candidate.character ?? 0) - (right.candidate.character ?? 0);
  if (charDiff !== 0) return charDiff;
  return left.originalRank - right.originalRank;
};

const rankCandidates = (candidates: CandidateSeed[]): readonly PublicCandidate[] => {
  const withOriginal = candidates.map((candidate, originalRank) => ({ candidate, originalRank }));
  withOriginal.sort(sortCandidateSeeds);
  return Object.freeze(
    withOriginal.slice(0, 20).map((entry, index) => ({
      ...entry.candidate,
      rank: index + 1,
    })),
  );
};

const exposedBytes = (candidates: readonly PublicCandidate[]): number =>
  candidates.reduce((total, candidate) => total + Buffer.byteLength(candidate.preview ?? '', 'utf8'), 0);

const sourceLikeText = (text: string): boolean =>
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\b|\b(?:async\s+)?function\s+[\w$]+\s*\(|\b(?:const|let|var)\s+[\w$]+\s*=|\b(?:class|interface|struct|enum|type)\s+[\w$]+\s*(?:\{|=|extends|implements)|\bdef\s+\w+\s*\(|\bfn\s+\w+\s*\(|#include\s+[<"]|=>\s*(?:\{|[^\s,;]+)|^\s*\{\s*"[^"]+"\s*:/m.test(text);

const sourceExposureTexts = (value: unknown, carriesSource = false): string[] => {
  if (typeof value === 'string') {
    return carriesSource || sourceLikeText(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => sourceExposureTexts(item, carriesSource));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const keyCarriesSource = ['source', 'context', 'preview', 'snippet', 'content'].includes(key.toLowerCase());
    return sourceExposureTexts(item, carriesSource || keyCarriesSource);
  });
};

const sourceExposureBytes = (value: unknown): number =>
  sourceExposureTexts(value).reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);

const sourceExposureBytesFromText = (text: string, duplicateOf: unknown): number => {
  if (text.length === 0) return 0;
  const duplicateTexts = sourceExposureTexts(duplicateOf);
  const countUnmatchedTexts = (texts: string[]): number =>
    texts.reduce((total, exposure) => {
      const duplicateIndex = duplicateTexts.indexOf(exposure);
      if (duplicateIndex === -1) return total + Buffer.byteLength(exposure, 'utf8');
      duplicateTexts.splice(duplicateIndex, 1);
      return total;
    }, 0);

  try {
    const parsed: unknown = JSON.parse(text);
    if (isDeepStrictEqual(parsed, duplicateOf)) return 0;
    if (typeof parsed === 'string') return countUnmatchedTexts([parsed]);
    const parsedExposureTexts = sourceExposureTexts(parsed);
    return parsedExposureTexts.length === 0
      ? Buffer.byteLength(text, 'utf8')
      : countUnmatchedTexts(parsedExposureTexts);
  } catch {
    // Unstructured refusal text cannot be proven source-free.
    return countUnmatchedTexts([text]);
  }
};

const makeObservation = (
  status: QualityObservationStatus,
  results: readonly PublicCandidate[],
  rawDigest: string,
  normalizedPublicArgs: NormalizedPublicArgs,
  sourceAdoptions: readonly SourceAdoption[] = [],
  reasonCode?: string,
  navigation?: QualityObservation['navigation'],
  exposureOverride?: number,
): QualityObservation =>
  Object.freeze({
    status,
    results,
    exposedBytes: exposureOverride ?? exposedBytes(results),
    sourceAdoptions,
    rawDigest,
    normalizedPublicArgs,
    ...(navigation ? { navigation } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  });

const isValidRootKey = (value: unknown): value is QualityRootKey =>
  value === 'single' || value === 'primary' || value === 'linked';

export const createRipgrepAdapter = (
  root: string,
  rgExecutable: string,
  options?: Readonly<{ rootKey?: QualityRootKey }>,
): RipgrepQualityAdapter => {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('quality_rg_root_missing');
  }
  if (typeof rgExecutable !== 'string' || rgExecutable.length === 0) {
    throw new Error('quality_rg_executable_missing');
  }

  const rootKey: QualityRootKey = isValidRootKey(options?.rootKey) ? options.rootKey : DEFAULT_ROOT_KEY;

  let canonicalRoot: string | undefined;
  let rgExecutableIdentity: string | undefined;
  let initializedContractDigest: string | undefined;

  const init = async (): Promise<void> => {
    if (canonicalRoot !== undefined && rgExecutableIdentity !== undefined) return;

    const info = await lstat(root).catch(() => undefined);
    if (info?.isDirectory() !== true) {
      throw new Error('quality_rg_root_not_directory');
    }
    const resolved = await realpath(root);
    canonicalRoot = resolved;

    const versionResult = await spawnRg(
      rgExecutable,
      ['--version'],
      resolved,
      new AbortController().signal,
    );
    if (!versionResult.launched || versionResult.exitCode !== 0 || !versionResult.stdout.includes('ripgrep')) {
      throw new Error('quality_rg_executable_not_ripgrep');
    }
    rgExecutableIdentity = sha256(utf8Bytes(`${rgExecutable}\0${versionResult.stdout.trim()}`));

    initializedContractDigest = contractDigest(
      sanitizedRgArgv(),
      rootKey,
    );
  };

  let rgSearchInvocationCount = 0;
  let spawnAttemptCount = 0;
  let nextSpawnOrdinal = 1;
  const spawns: RgSpawnObservation[] = [];
  let evidenceComplete = true;
  const seenSequences = new Set<number>();

  const validateTraceSequence = (context: QualityInvocationContext): number => {
    const sequence = context.traceSequence;
    if (
      typeof sequence !== 'number' ||
      !Number.isInteger(sequence) ||
      sequence <= 0 ||
      seenSequences.has(sequence)
    ) {
      evidenceComplete = false;
      throw new Error('quality_trace_sequence_invalid_or_duplicate');
    }
    seenSequences.add(sequence);
    return sequence;
  };

  const recordSpawn = (
    policyTraceSequence: number,
    observedArgv: readonly string[],
    publicQuery: string,
  ): void => {
    if (initializedContractDigest === undefined) {
      evidenceComplete = false;
      return;
    }
    const normalizedObservedArgv = redactArgvQuery(observedArgv, publicQuery);
    const observedContractDigest = contractDigest(normalizedObservedArgv, rootKey);
    if (observedContractDigest !== initializedContractDigest) {
      evidenceComplete = false;
    }
    spawns.push(
      Object.freeze({
        spawnOrdinal: nextSpawnOrdinal++,
        policyTraceSequence,
        rootKey,
        searchScope: SEARCH_SCOPE,
        normalizedObservedArgv,
        queryDigest: queryDigest(publicQuery),
        observedExclusions: Object.freeze([...rgExclusions]),
        readMaxBytesPerCall: READ_MAX_BYTES,
        observedContractDigest,
      }),
    );
  };

  const invokeRgSearch = async (
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    policyTraceSequence: number,
  ): Promise<QualityObservation> => {
    const publicQuery = validatePublicQuery(args.query);
    if (publicQuery === null) {
      return makeObservation(
        'error',
        [],
        sha256(''),
        Object.freeze({}),
        [],
        'RG_QUERY_INVALID',
      );
    }

    const argv = buildFixedRgArgv(publicQuery);
    const rawDigestInput: string[] = [];

    spawnAttemptCount += 1;
    let result;
    try {
      result = await spawnRg(rgExecutable, argv, canonicalRoot ?? root, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'RG_TIMEOUT') {
        return makeObservation('timeout', [], sha256(''), Object.freeze({}), [], 'RG_TIMEOUT');
      }
      if (message === 'RG_CANCELLED' || (error instanceof Error && error.name === 'AbortError')) {
        return makeObservation('cancelled', [], sha256(''), Object.freeze({}), [], 'REQUEST_CANCELLED');
      }
      return makeObservation('error', [], sha256(''), Object.freeze({}), [], 'SPAWN_FAILED');
    }

    if (!result.launched) {
      spawnAttemptCount -= 1;
      return makeObservation(
        isTimeoutSignal(signal) ? 'timeout' : 'cancelled',
        [],
        sha256(''),
        Object.freeze({}),
        [],
        isTimeoutSignal(signal) ? 'RG_TIMEOUT' : 'REQUEST_CANCELLED',
      );
    }

    recordSpawn(policyTraceSequence, [...argv], publicQuery);
    rawDigestInput.push(result.stdout);

    if (signal.aborted) {
      const timedOut = isTimeoutSignal(signal);
      return makeObservation(
        timedOut ? 'timeout' : 'cancelled',
        [],
        sha256(rawDigestInput.join('\n')),
        Object.freeze({}),
        [],
        timedOut ? 'RG_TIMEOUT' : 'REQUEST_CANCELLED',
      );
    }

    if ('error' in result && result.error !== undefined) {
      return makeObservation(
        'error',
        [],
        sha256(rawDigestInput.join('\n')),
        Object.freeze({}),
        [],
        'SPAWN_FAILED',
      );
    }

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return makeObservation(
        'error',
        [],
        sha256(rawDigestInput.join('\n')),
        Object.freeze({}),
        [],
        'RG_EXIT_2',
      );
    }

    if (result.exitCode === 1 && result.stderr.trim().length > 0) {
      return makeObservation(
        'error',
        [],
        sha256(rawDigestInput.join('\n')),
        Object.freeze({}),
        [],
        'RG_EXIT_1_DIAGNOSTIC',
      );
    }

    const parsed = parseRgMatches(result.stdout);
    if (parsed.kind === 'error') {
      return makeObservation(
        'error',
        [],
        sha256(rawDigestInput.join('\n')),
        Object.freeze({}),
        [],
        parsed.reason,
      );
    }

    return makeObservation(
      'ok',
      rankCandidates(parsed.candidates),
      sha256(rawDigestInput.join('\n')),
      Object.freeze({}),
      [],
    );
  };

  const invokeReadFile = async (
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<QualityObservation> => {
    if (signal.aborted) {
      return makeObservation(
        isTimeoutSignal(signal) ? 'timeout' : 'cancelled',
        [],
        sha256(''),
        Object.freeze({}),
        [],
        isTimeoutSignal(signal) ? 'TIMEOUT' : 'REQUEST_CANCELLED',
      );
    }

    const rawFilePath = typeof args.filePath === 'string' ? args.filePath : null;
    if (rawFilePath === null || rawFilePath.length === 0) {
      return makeObservation('error', [], sha256(''), Object.freeze({}), [], 'READ_FILE_PATH_MISSING');
    }

    const resolved = resolve(canonicalRoot ?? root, rawFilePath);
    const relativePath = relative(canonicalRoot ?? root, resolved);
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return makeObservation(
        'error',
        [],
        sha256(''),
        Object.freeze({ filePath: rawFilePath }),
        [],
        'PATH_TRAVERSAL',
      );
    }

    let realResolved: string;
    try {
      realResolved = await realpath(resolved);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return makeObservation(
          'not_found',
          [],
          sha256(''),
          Object.freeze({ filePath: toForwardSlashes(relativePath) }),
          [],
          'FILE_NOT_FOUND',
        );
      }
      return makeObservation(
        'error',
        [],
        sha256(''),
        Object.freeze({ filePath: toForwardSlashes(relativePath) }),
        [],
        'READ_FAILED',
      );
    }

    if (!insideRoot(canonicalRoot ?? root, realResolved)) {
      return makeObservation(
        'error',
        [],
        sha256(''),
        Object.freeze({ filePath: toForwardSlashes(relativePath) }),
        [],
        'SYMLINK_ESCAPE',
      );
    }

    let startByte = Math.max(0, clampInt(args.startByte, 0));
    const alignUtf8Boundaries = args.alignUtf8Boundaries === true;
    const requestedStartLine =
      typeof args.startLine === 'number' && Number.isSafeInteger(args.startLine) && args.startLine >= 1
        ? args.startLine
        : undefined;
    const rawEndByte = typeof args.endByte === 'number' && Number.isFinite(args.endByte) ? Math.trunc(args.endByte) : null;

    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(realResolved, 'r');
      const fileLength = (await fileHandle.stat()).size;
      const readBudget: ReadByteBudget = { bytesRead: 0 };
      if (requestedStartLine !== undefined) {
        const lineStart = await findLineStartByte(fileHandle, requestedStartLine, fileLength, signal, readBudget);
        if (lineStart === undefined) {
          return makeObservation(
            'error',
            [],
            sha256(''),
            Object.freeze({ filePath: toForwardSlashes(relativePath), startLine: requestedStartLine }),
            [],
            'READ_BYTE_BUDGET_EXCEEDED',
          );
        }
        startByte = lineStart;
      }
      startByte = Math.min(startByte, fileLength);
      const requestedEndByte =
        rawEndByte === null ? Math.min(startByte + READ_MAX_BYTES, fileLength) : rawEndByte;
      const endByte = Math.max(startByte, Math.min(requestedEndByte, fileLength));

      if (endByte - startByte > READ_MAX_BYTES) {
        return makeObservation(
          'error',
          [],
          sha256(''),
          Object.freeze({ filePath: toForwardSlashes(relativePath), startByte, endByte: requestedEndByte }),
          [],
          'READ_WINDOW_EXCEEDS_LIMIT',
        );
      }

      if (signal.aborted) {
        return makeObservation(
          isTimeoutSignal(signal) ? 'timeout' : 'cancelled',
          [],
          sha256(''),
          Object.freeze({ filePath: toForwardSlashes(relativePath), startByte, endByte }),
          [],
          isTimeoutSignal(signal) ? 'TIMEOUT' : 'REQUEST_CANCELLED',
        );
      }

      const reservedProbeBytes = alignUtf8Boundaries ? 14 : 0;
      const remainingPayloadBytes = Math.max(0, READ_MAX_BYTES - readBudget.bytesRead - reservedProbeBytes);
      const payloadBytes = Math.min(endByte - startByte, remainingPayloadBytes);
      const buffer = Buffer.alloc(payloadBytes);
      const bytesRead = await readWithinBudget(fileHandle, buffer, buffer.length, startByte, readBudget);
      if (signal.aborted) {
        const timedOut = isTimeoutSignal(signal);
        return makeObservation(
          timedOut ? 'timeout' : 'cancelled',
          [],
          sha256(''),
          Object.freeze({ filePath: toForwardSlashes(relativePath), startByte, endByte }),
          [],
          timedOut ? 'TIMEOUT' : 'REQUEST_CANCELLED',
        );
      }

      let actualStartByte = startByte;
      let actualEndByte = startByte + bytesRead;
      let slice = buffer.subarray(0, bytesRead);
      if (alignUtf8Boundaries) {
        const aligned = await alignUtf8Window(fileHandle, actualStartByte, actualEndByte, fileLength, readBudget);
        actualStartByte = aligned.startByte;
        actualEndByte = aligned.endByte;
        slice = slice.subarray(actualStartByte - startByte, actualEndByte - startByte);
        if (signal.aborted) {
          const timedOut = isTimeoutSignal(signal);
          return makeObservation(
            timedOut ? 'timeout' : 'cancelled',
            [],
            sha256(''),
            Object.freeze({ filePath: toForwardSlashes(relativePath), startByte: actualStartByte, endByte: actualEndByte }),
            [],
            timedOut ? 'TIMEOUT' : 'REQUEST_CANCELLED',
          );
        }
      }
      const content = slice.toString('utf8');
      const sourceValidation = Buffer.from(content, 'utf8').equals(slice) ? 'verified' : 'partial';
      const normalizedArgs = Object.freeze({
        filePath: toForwardSlashes(relativePath),
        ...(requestedStartLine === undefined ? {} : { startLine: requestedStartLine }),
        ...(alignUtf8Boundaries ? { alignUtf8Boundaries: true } : {}),
        startByte: actualStartByte,
        endByte: actualEndByte,
      });

      const candidates: CandidateSeed[] = [
        {
          filePath: toForwardSlashes(relativePath),
          preview: content,
        },
      ];

      const adoption: SourceAdoption = {
        filePath: toForwardSlashes(relativePath),
        startByte: actualStartByte,
        endByte: actualEndByte,
        content,
        sourceValidation,
      };

      return makeObservation(
        'ok',
        rankCandidates(candidates),
        sha256(slice),
        normalizedArgs,
        [Object.freeze(adoption)],
      );
    } catch (error) {
      const reasonCode =
        error instanceof Error && error.message === 'READ_BYTE_BUDGET_EXCEEDED'
          ? 'READ_BYTE_BUDGET_EXCEEDED'
          : 'READ_FAILED';
      return makeObservation(
        'error',
        [],
        sha256(''),
        Object.freeze({ filePath: toForwardSlashes(relativePath), startByte }),
        [],
        reasonCode,
      );
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  const invoke = async (
    tool: QualityTool,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    context: QualityInvocationContext,
  ): Promise<QualityObservation> => {
    if (tool === 'rg_search') {
      rgSearchInvocationCount += 1;
    }

    const policyTraceSequence = validateTraceSequence(context);

    if (signal.aborted) {
      const timedOut = isTimeoutSignal(signal);
      return makeObservation(
        timedOut ? 'timeout' : 'cancelled',
        [],
        sha256(''),
        Object.freeze({}),
        [],
        timedOut ? (tool === 'rg_search' ? 'RG_TIMEOUT' : 'TIMEOUT') : 'REQUEST_CANCELLED',
      );
    }

    await init();

    if (tool === 'rg_search') {
      return invokeRgSearch(args, signal, policyTraceSequence);
    }

    if (tool === 'read_file') {
      return invokeReadFile(args, signal);
    }

    return makeObservation(
      'unsupported',
      [],
      sha256(''),
      Object.freeze({}),
      [],
      'TOOL_UNSUPPORTED_BY_R',
    );
  };

  const snapshotRgExecution = (): RgExecutionSnapshot => {
    const snapshotEvidenceComplete =
      evidenceComplete &&
      spawnAttemptCount === spawns.length &&
      initializedContractDigest !== undefined;
    return Object.freeze({
      initializedContractDigest: initializedContractDigest ?? sha256('uninitialized'),
      rgSearchInvocationCount,
      spawnAttemptCount,
      spawns: Object.freeze([...spawns]),
      evidenceComplete: snapshotEvidenceComplete,
    });
  };

  return Object.freeze({
    arm: 'R' as QualityArm,
    invoke,
    snapshotRgExecution,
    get rgExecutionContractDigest() {
      return initializedContractDigest ?? sha256('uninitialized');
    },
  });
};

const normalizeSearchArgs = (
  args: Readonly<Record<string, unknown>>,
  queryKey: 'pattern' | 'query',
  allowedKeys: readonly string[],
): NormalizedPublicArgs => {
  const allowed = new Set<string>(allowedKeys);
  const result: Record<string, PublicJsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === queryKey || key === 'grepPattern') continue;
    if (!allowed.has(key)) continue;
    if (isPublicJsonValue(value)) result[key] = value;
  }
  return Object.freeze(result);
};

const normalizeGetContextArgs = (args: Readonly<Record<string, unknown>>): NormalizedPublicArgs => {
  const allowed = new Set<string>(['filePath', 'startLine', 'endLine', 'mode', 'symbolName']);
  const result: Record<string, PublicJsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.has(key)) continue;
    if (isPublicJsonValue(value)) result[key] = value;
  }
  return Object.freeze(result);
};

const normalizeSymbolArgs = (args: Readonly<Record<string, unknown>>): NormalizedPublicArgs => {
  const result: Record<string, PublicJsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'symbolId' || key === 'tokenBudget') {
      if (isPublicJsonValue(value)) result[key] = value;
    }
  }
  return Object.freeze(result);
};

const normalizeNavigationArgs = (args: Readonly<Record<string, unknown>>): NormalizedPublicArgs => {
  const allowed = new Set<string>(['filePath', 'line', 'character', 'symbolId', 'maxResults']);
  const result: Record<string, PublicJsonValue> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.has(key)) continue;
    if (isPublicJsonValue(value)) result[key] = value;
  }
  return Object.freeze(result);
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  return undefined;
};

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  return undefined;
};

const optionalString = (value: string | undefined): { symbolId?: string } =>
  value === undefined ? {} : { symbolId: value };

const optionalScore = (value: number | undefined): { publicScore?: number } =>
  value === undefined ? {} : { publicScore: value };

const normalizeCandidates = (
  tool: QualityTool,
  envelope: Record<string, unknown>,
): CandidateSeed[] => {
  switch (tool) {
    case 'grep_search': {
      const matches = Array.isArray(envelope.matches) ? envelope.matches : [];
      const candidates: CandidateSeed[] = [];
      for (const match of matches) {
        if (!match || typeof match !== 'object') continue;
        const typed = match as {
          filePath?: string;
          lineNumber?: number;
          lineText?: string;
          submatches?: Array<{ start?: number; end?: number; match?: string }>;
        };
        const filePath = asString(typed.filePath);
        const line = asNumber(typed.lineNumber);
        const preview = asString(typed.lineText) ?? '';
        if (!filePath || line === undefined) continue;
        const subs =
          Array.isArray(typed.submatches) && typed.submatches.length > 0
            ? typed.submatches
            : [{ start: 0, end: preview.length }];
        for (const sub of subs) {
          const start = asNumber(sub?.start) ?? 0;
          const end = asNumber(sub?.end) ?? start;
          candidates.push({ filePath, line, character: start, endLine: line, endCharacter: end, preview });
        }
      }
      return candidates;
    }
    case 'semantic_search': {
      const results = Array.isArray(envelope.results) ? envelope.results : [];
      const candidates: CandidateSeed[] = [];
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const typed = result as {
          chunk?: { filePath?: string; startLine?: number; endLine?: number; content?: string; symbolId?: string };
          score?: number;
        };
        const score = asNumber(typed.score);
        const chunk = typed.chunk;
        if (!chunk || typeof chunk !== 'object') continue;
        const filePath = asString(chunk.filePath);
        if (!filePath) continue;
        candidates.push({
          filePath,
          ...optionalString(asString(chunk.symbolId)),
          ...optionalScore(score),
          line: asNumber(chunk.startLine),
          endLine: asNumber(chunk.endLine),
          preview: asString(chunk.content),
        });
      }
      return candidates;
    }
    case 'hybrid_search': {
      const results = Array.isArray(envelope.results) ? envelope.results : [];
      const candidates: CandidateSeed[] = [];
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const typed = result as {
          chunk?: { filePath?: string; startLine?: number; endLine?: number; content?: string; symbolId?: string };
          score?: number;
          snippet?: string;
          snippetStartLine?: number;
          snippetEndLine?: number;
        };
        const score = asNumber(typed.score);
        const chunk = typed.chunk;
        if (!chunk || typeof chunk !== 'object') continue;
        const filePath = asString(chunk.filePath);
        if (!filePath) continue;
        const line = asNumber(typed.snippetStartLine) ?? asNumber(chunk.startLine);
        const endLine = asNumber(typed.snippetEndLine) ?? asNumber(chunk.endLine);
        candidates.push({
          filePath,
          ...optionalString(asString(chunk.symbolId)),
          ...optionalScore(score),
          line,
          endLine,
          preview: asString(typed.snippet) ?? asString(chunk.content),
        });
      }
      return candidates;
    }
    case 'get_context': {
      const typed = envelope as {
        filePath?: string;
        content?: string;
        summary?: string;
        startLine?: number;
        endLine?: number;
        previewStartLine?: number;
        previewEndLine?: number;
        mode?: string;
      };
      const filePath = asString(typed.filePath);
      const isDeferred = typed.mode === 'deferred';
      const line = isDeferred ? asNumber(typed.previewStartLine) : asNumber(typed.startLine);
      const endLine = isDeferred ? asNumber(typed.previewEndLine) : asNumber(typed.endLine);
      const preview = isDeferred ? asString(typed.summary) : asString(typed.content);
      if (!filePath) return [];
      return [{ filePath, line, endLine, preview }];
    }
    case 'get_file_outline': {
      const typed = envelope as {
        file?: { filePath?: string };
        symbols?: Array<{
          symbolId?: string;
          position?: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
          name?: string;
        }>;
      };
      const filePath = asString(typed.file?.filePath);
      if (!filePath) return [];
      const symbols = Array.isArray(typed.symbols) ? typed.symbols : [];
      const candidates: CandidateSeed[] = [];
      for (const symbol of symbols) {
        if (!symbol || typeof symbol !== 'object') continue;
        const position = symbol.position as
          | { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }
          | undefined;
        candidates.push({
          filePath,
          ...optionalString(asString(symbol.symbolId)),
          line: asNumber(position?.startLine),
          character: asNumber(position?.startColumn),
          endLine: asNumber(position?.endLine),
          endCharacter: asNumber(position?.endColumn),
          preview: asString(symbol.name),
        });
      }
      return candidates;
    }
    case 'get_symbol_source': {
      const typed = envelope as { source?: string; request?: { symbolId?: string } };
      const source = asString(typed.source);
      const symbolId = asString(typed.request?.symbolId);
      if (!symbolId) return [];
      return [{ filePath: '', ...optionalString(symbolId), preview: source }];
    }
    case 'get_symbol_context': {
      const typed = envelope as { filePath?: string; context?: string; request?: { symbolId?: string } };
      const filePath = asString(typed.filePath);
      const context = asString(typed.context);
      const symbolId = asString(typed.request?.symbolId);
      if (!symbolId) return [];
      return [{ filePath: filePath ?? '', ...optionalString(symbolId), preview: context }];
    }
    case 'get_definition':
    case 'get_references':
    case 'get_implementations': {
      const typed = envelope as {
        locations?: Array<{ filePath?: string; startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number }>;
      };
      const locations = Array.isArray(typed.locations) ? typed.locations : [];
      const candidates: CandidateSeed[] = [];
      for (const location of locations) {
        if (!location || typeof location !== 'object') continue;
        const filePath = asString(location.filePath);
        if (!filePath) continue;
        candidates.push({
          filePath,
          line: asNumber(location.startLine),
          character: asNumber(location.startCharacter),
          endLine: asNumber(location.endLine),
          endCharacter: asNumber(location.endCharacter),
        });
      }
      return candidates;
    }
    case 'index_status':
    case 'rg_search':
    case 'read_file':
    default:
      return [];
  }
};

const verifiedSourceAdoptionsForTool = (
  tool: QualityTool,
  args: Readonly<Record<string, unknown>>,
  envelope: Record<string, unknown>,
  status: QualityObservationStatus,
): readonly SourceAdoption[] => {
  if (status !== 'ok') return [];

  if (tool === 'get_context') {
    const filePath = asString(envelope.filePath);
    const content = asString(envelope.content);
    const startByte = asNumber(envelope.startByte);
    const endByte = asNumber(envelope.endByte);
    const requestedStartLine = asNumber(args.startLine);
    const requestedEndLine = asNumber(args.endLine);
    const actualStartLine = asNumber(envelope.startLine);
    const actualEndLine = asNumber(envelope.endLine);
    if (
      args.mode === 'deferred' ||
      envelope.mode === 'deferred' ||
      filePath === undefined ||
      filePath.length === 0 ||
      filePath !== asString(args.filePath) ||
      content === undefined ||
      content.length === 0 ||
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByte) ||
      startByte === undefined ||
      endByte === undefined ||
      startByte < 0 ||
      endByte < startByte ||
      Buffer.byteLength(content, 'utf8') !== endByte - startByte ||
      requestedStartLine === undefined ||
      requestedEndLine === undefined ||
      actualStartLine === undefined ||
      actualEndLine === undefined ||
      !Number.isSafeInteger(requestedStartLine) ||
      !Number.isSafeInteger(requestedEndLine) ||
      requestedStartLine > requestedEndLine ||
      !Number.isSafeInteger(actualStartLine) ||
      !Number.isSafeInteger(actualEndLine) ||
      actualStartLine < 1 ||
      actualStartLine !== requestedStartLine ||
      actualEndLine < actualStartLine ||
      actualEndLine > requestedEndLine
    ) {
      return [];
    }
    return [Object.freeze({ filePath, startByte, endByte, content, sourceValidation: 'verified' })];
  }

  if (tool === 'get_symbol_source') {
    const filePath = asString(envelope.filePath);
    const source = asString(envelope.source);
    const startByte = asNumber(envelope.startByte);
    const endByte = asNumber(envelope.endByte);
    const request = envelope.request as { symbolId?: unknown } | undefined;
    if (
      envelope.freshness !== 'fresh' ||
      envelope.reindexRequired !== false ||
      filePath === undefined ||
      filePath.length === 0 ||
      source === undefined ||
      source.length === 0 ||
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByte) ||
      startByte === undefined ||
      endByte === undefined ||
      startByte < 0 ||
      endByte < startByte ||
      Buffer.byteLength(source, 'utf8') !== endByte - startByte ||
      request?.symbolId !== args.symbolId
    ) {
      return [];
    }
    return [Object.freeze({ filePath, startByte, endByte, content: source, sourceValidation: 'verified' })];
  }

  return [];
};

const toNavigation = (
  envelope: Record<string, unknown>,
): QualityObservation['navigation'] => {
  const locations = Array.isArray(envelope.locations)
    ? (envelope.locations as Array<{
          filePath?: string;
          startLine?: number;
          startCharacter?: number;
          endLine?: number;
          endCharacter?: number;
        }>)
        .map((location) => {
          if (!location || typeof location !== 'object') return undefined;
          const filePath = asString(location.filePath);
          if (!filePath) return undefined;
          return {
            filePath,
            startLine: asNumber(location.startLine) ?? 0,
            startCharacter: asNumber(location.startCharacter) ?? 0,
            endLine: asNumber(location.endLine) ?? 0,
            endCharacter: asNumber(location.endCharacter) ?? 0,
          };
        })
        .filter((location): location is PublicSourceLocation => location !== undefined)
    : [];

  const truncated = asBoolean(envelope.truncated) ?? false;
  const sourceValidationRaw = asString(envelope.sourceValidation);
  const sourceValidation: 'verified' | 'partial' | 'unknown' =
    sourceValidationRaw === 'verified' || sourceValidationRaw === 'partial' || sourceValidationRaw === 'unknown'
      ? sourceValidationRaw
      : 'unknown';
  const capabilityRaw = asString(envelope.capability);
  const capability: 'supported' | 'unsupported' | 'unavailable' | 'not_checked' =
    capabilityRaw === 'supported' ||
    capabilityRaw === 'unsupported' ||
    capabilityRaw === 'unavailable' ||
    capabilityRaw === 'not_checked'
      ? capabilityRaw
      : 'not_checked';

  return Object.freeze({
    locations: Object.freeze(locations),
    truncated,
    sourceValidation,
    capability,
  });
};
const validateSearchEnvelope = (
  tool: QualityTool,
  envelope: Record<string, unknown>,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } => {
  switch (tool) {
    case 'grep_search': {
      if (!Array.isArray(envelope.matches)) return { valid: false, reason: 'MALFORMED_ENVELOPE' };
      return { valid: true };
    }
    case 'semantic_search':
    case 'hybrid_search': {
      if (!Array.isArray(envelope.results)) return { valid: false, reason: 'MALFORMED_ENVELOPE' };
      return { valid: true };
    }
    case 'get_context': {
      if (typeof envelope.filePath !== 'string') return { valid: false, reason: 'MALFORMED_ENVELOPE' };
      return { valid: true };
    }
    default:
      return { valid: true };
  }
};


const statusFromEnvelope = (
  tool: QualityTool,
  envelope: Record<string, unknown>,
  isError: boolean,
): { status: QualityObservationStatus; reasonCode?: string } => {
  if (isError) {
    const message =
      asString(envelope.message) ??
      asString((envelope.structuredContent as { message?: string } | undefined)?.message);
    return { status: 'error', reasonCode: message ?? 'TOOL_ERROR' };
  }

  const statusValue = asString(envelope.status);
  if (statusValue === 'failed') {
    return { status: 'error', reasonCode: asString(envelope.reasonCode) ?? 'FAILED' };
  }
  if (isQualityStatus(statusValue)) {
    return { status: statusValue, reasonCode: asString(envelope.reasonCode) };
  }

  const statusTools = new Set<QualityTool>([
    'get_file_outline',
    'get_symbol_source',
    'get_symbol_context',
    'get_definition',
    'get_references',
    'get_implementations',
  ]);
  if (statusTools.has(tool)) {
    return { status: 'error', reasonCode: 'MALFORMED_ENVELOPE' };
  }

  return { status: 'ok' };
};

const normalizedArgsForTool = (
  tool: QualityTool,
  args: Readonly<Record<string, unknown>>,
): NormalizedPublicArgs => {
  switch (tool) {
    case 'grep_search':
      return normalizeSearchArgs(args, 'pattern', [
        'filePattern',
        'filePatterns',
        'caseSensitive',
        'maxResults',
      ]);
    case 'semantic_search':
      return normalizeSearchArgs(args, 'query', [
        'topK',
        'filePatterns',
        'language',
      ]);
    case 'hybrid_search':
      return normalizeSearchArgs(args, 'query', [
        'topK',
        'filePatterns',
        'language',
        'includeSnippet',
        'contextLines',
      ]);
    case 'get_context':
      return normalizeGetContextArgs(args);
    case 'get_file_outline':
      return asNormalizedArgs({ filePath: args.filePath });
    case 'get_symbol_source':
    case 'get_symbol_context':
      return normalizeSymbolArgs(args);
    case 'get_definition':
    case 'get_references':
    case 'get_implementations':
      return normalizeNavigationArgs(args);
    case 'index_status':
      return Object.freeze({});
    default:
      return Object.freeze({});
  }
};

export const createNexusAdapter = (handlers: ToolHandlers): QualityAdapter => {
  const seenSequences = new Set<number>();

  const validateTraceSequence = (context: QualityInvocationContext): void => {
    const sequence = context.traceSequence;
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence <= 0 || seenSequences.has(sequence)) {
      throw new Error('quality_trace_sequence_invalid_or_duplicate');
    }
    seenSequences.add(sequence);
  };

  const invoke = async (
    tool: QualityTool,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    context: QualityInvocationContext,
  ): Promise<QualityObservation> => {
    validateTraceSequence(context);

    if (signal.aborted) {
      return makeObservation(
        isTimeoutSignal(signal) ? 'timeout' : 'cancelled',
        [],
        sha256(''),
        normalizedArgsForTool(tool, args),
        [],
        isTimeoutSignal(signal) ? 'TIMEOUT' : 'REQUEST_CANCELLED',
      );
    }

    const handler = (handlers as Record<string, ToolHandler | undefined>)[tool];
    if (handler === undefined) {
      return makeObservation(
        'unsupported',
        [],
        sha256(''),
        normalizedArgsForTool(tool, args),
        [],
        'TOOL_NOT_IN_HANDLERS',
      );
    }

    let rawResult: Awaited<ReturnType<ToolHandler>>;
    try {
      rawResult = await handler(args, { signal });
    } catch (error) {
      if (signal.aborted) {
        return makeObservation(
          isTimeoutSignal(signal) ? 'timeout' : 'cancelled',
          [],
          sha256(''),
          normalizedArgsForTool(tool, args),
          [],
          isTimeoutSignal(signal) ? 'TIMEOUT' : 'REQUEST_CANCELLED',
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      return makeObservation(
        'error',
        [],
        sha256(reason),
        normalizedArgsForTool(tool, args),
        [],
        reason,
      );
    }

    if (signal.aborted) {
      return makeObservation(
        isTimeoutSignal(signal) ? 'timeout' : 'cancelled',
        [],
        sha256(''),
        normalizedArgsForTool(tool, args),
        [],
        isTimeoutSignal(signal) ? 'TIMEOUT' : 'REQUEST_CANCELLED',
      );
    }

    const result = rawResult as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    const text = asString(result.content?.[0]?.text) ?? '';
    const rawDigest = sha256(utf8Bytes(text));
    const isError = asBoolean(result.isError) ?? false;
    const envelope: Record<string, unknown> =
      result.structuredContent !== undefined &&
      result.structuredContent !== null &&
      typeof result.structuredContent === 'object'
        ? result.structuredContent
        : {};

    const { status, reasonCode } = statusFromEnvelope(tool, envelope, isError);
    const refusalTextExposure = status === 'ok'
      ? 0
      : (Array.isArray(result.content) ? result.content : []).reduce((total, item) => {
          if (item === null || typeof item !== 'object') return total;
          const contentText = asString((item as { text?: unknown }).text);
          return total + (contentText === undefined ? 0 : sourceExposureBytesFromText(contentText, envelope));
        }, 0);
    if (status === 'ok') {
      const validation = validateSearchEnvelope(tool, envelope);
      if (!validation.valid) {
        return makeObservation(
          'error',
          [],
          rawDigest,
          normalizedArgsForTool(tool, args),
          [],
          validation.reason,
        );
      }
    }
    const candidates = status === 'ok' ? normalizeCandidates(tool, envelope) : [];
    const sourceAdoptions = verifiedSourceAdoptionsForTool(tool, args, envelope, status);
    const navigation =
      tool === 'get_definition' || tool === 'get_references' || tool === 'get_implementations'
        ? toNavigation(envelope)
        : undefined;

    return makeObservation(
      status,
      rankCandidates(candidates),
      rawDigest,
      normalizedArgsForTool(tool, args),
      sourceAdoptions,
      reasonCode,
      navigation,
      status === 'ok' ? undefined : sourceExposureBytes(envelope) + refusalTextExposure,
    );
  };

  return Object.freeze({
    arm: 'N' as QualityArm,
    invoke,
  });
};
