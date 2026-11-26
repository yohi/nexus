import type { PathSanitizer } from '../path-sanitizer.js';
import type { ContentRangeWithOffsets } from '../../storage/interfaces/content-store.js';
import { resolveLineRange, sliceContent, type LineRange } from './context-helpers.js';
import type { GetContextToolArgs } from './get-context-schema.js';

const PREVIEW_LINES = 20;
const DEFERRED_HINT = 'Call get_context with startLine/endLine to fetch specific ranges.';

export interface GetContextEagerResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  startByte?: number;
  endByte?: number;
}

export interface GetContextDeferredResult {
  filePath: string;
  mode: 'deferred';
  totalLines: number;
  summary: string;
  previewStartLine: number;
  previewEndLine: number;
  hint: string;
}

export type GetContextResult = GetContextEagerResult | GetContextDeferredResult;

export interface GetContextContentReader {
  (
    filePath: string,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ): Promise<string>;
  readRangeWithOffsets?: (
    filePath: string,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ) => Promise<ContentRangeWithOffsets | undefined>;
}

const buildInvalidRangeError = (
  totalLines: number,
  startLine: number | undefined,
  endLine: number | undefined,
): Error => {
  const clampedStart = Math.max(1, Math.min(startLine ?? 1, totalLines));
  const clampedEnd = Math.max(1, Math.min(endLine ?? totalLines, totalLines));
  return new Error(`Invalid line range: startLine (${clampedStart}) is greater than endLine (${clampedEnd})`);
};

/**
 * Computes the preview window for deferred mode.
 *
 * - Both startLine and endLine given: the requested range, clamped to file boundaries.
 * - Only startLine given: startLine through startLine + PREVIEW_LINES - 1 (clamped).
 * - Only endLine given: endLine - PREVIEW_LINES + 1 through endLine (clamped).
 * - Neither given: the first PREVIEW_LINES lines of the file.
 */
const resolveDeferredPreviewRange = (
  totalLines: number,
  startLine: number | undefined,
  endLine: number | undefined,
): LineRange => {
  if (startLine !== undefined && endLine !== undefined) {
    const range = resolveLineRange(totalLines, startLine, endLine);
    if (range === null) {
      throw buildInvalidRangeError(totalLines, startLine, endLine);
    }
    return range;
  }

  if (startLine !== undefined) {
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    return { startLine: clampedStart, endLine: Math.min(clampedStart + PREVIEW_LINES - 1, totalLines) };
  }

  if (endLine !== undefined) {
    const clampedEnd = Math.max(1, Math.min(endLine, totalLines));
    return { startLine: Math.max(1, clampedEnd - PREVIEW_LINES + 1), endLine: clampedEnd };
  }

  return { startLine: 1, endLine: Math.min(PREVIEW_LINES, totalLines) };
};

export const executeGetContext = async (
  loadFileContent: GetContextContentReader,
  sanitizer: PathSanitizer,
  args: GetContextToolArgs,
  signal?: AbortSignal,
): Promise<GetContextResult> => {
  const sanitizedPath = await sanitizer.sanitize(args.filePath);
  if (args.mode !== 'deferred' && loadFileContent.readRangeWithOffsets !== undefined) {
    const rangedContent = await loadFileContent.readRangeWithOffsets(
      sanitizedPath,
      args.startLine ?? 1,
      args.endLine ?? Number.MAX_SAFE_INTEGER,
      signal,
    );
    if (rangedContent !== undefined) {
      return { filePath: args.filePath, ...rangedContent };
    }
  }

  const hasExplicitEagerRange = args.mode !== 'deferred' && args.startLine !== undefined && args.endLine !== undefined;
  const requestedStartLine = args.startLine;
  const requestedEndLine = args.endLine;
  const canReadRequestedRange =
    hasExplicitEagerRange &&
    requestedStartLine !== undefined &&
    requestedEndLine !== undefined &&
    requestedStartLine <= requestedEndLine;
  const content = await loadFileContent(
    sanitizedPath,
    canReadRequestedRange ? requestedStartLine : 1,
    canReadRequestedRange ? requestedEndLine : Number.MAX_SAFE_INTEGER,
    signal,
  );
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (hasExplicitEagerRange && requestedStartLine !== undefined && requestedEndLine !== undefined) {
    const range = resolveLineRange(totalLines, requestedStartLine, requestedEndLine);
    if (range === null) {
      throw buildInvalidRangeError(totalLines, requestedStartLine, requestedEndLine);
    }
    return {
      filePath: args.filePath,
      content: canReadRequestedRange ? content : sliceContent(content, range),
      startLine: range.startLine,
      endLine: canReadRequestedRange ? requestedEndLine : range.endLine,
    };
  }

  if (args.mode === 'deferred') {
    const previewRange = resolveDeferredPreviewRange(totalLines, args.startLine, args.endLine);

    return {
      filePath: args.filePath,
      mode: 'deferred',
      totalLines,
      summary: sliceContent(content, previewRange),
      previewStartLine: previewRange.startLine,
      previewEndLine: previewRange.endLine,
      hint: DEFERRED_HINT,
    };
  }

  const range = resolveLineRange(totalLines, args.startLine, args.endLine);

  if (range === null) {
    throw buildInvalidRangeError(totalLines, args.startLine, args.endLine);
  }

  return {
    filePath: args.filePath,
    content: sliceContent(content, range),
    startLine: range.startLine,
    endLine: range.endLine,
  };
};
