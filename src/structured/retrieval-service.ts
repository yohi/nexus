import path from 'node:path';

import type {
  IStructuredCatalog,
  StructuredImportRecord,
  StructuredIndexState,
  StructuredTombstone,
} from '../storage/interfaces/structured-catalog.js';
import { PathTraversalError, type PathSanitizer } from '../server/path-sanitizer.js';
import type { VerifiedSymbolNavigationResult } from '../lsp/contracts.js';
import { resolveTsIdentifierPosition } from '../lsp/identifier-locator.js';
import { CanonicalSourceError, readCanonicalSource } from '../lsp/target-resolver.js';
import { sha256Hex, decodeUtf8 } from './hash.js';
import { Utf8SourceError } from './utf8-offsets.js';
import type { StructuredDeclaration, StructuredRetrievalReasonCode } from './contracts.js';
import { packRelatedImports, tokenCounter } from './tokenizer.js';

type SourceStatus =
  | { status: 'ok'; freshness: 'fresh'; reindexRequired: false; source: string }
  | { status: 'stale_identity'; freshness: 'unknown'; reindexRequired: false; reasonCode: 'SYMBOL_RETIRED' }
  | { status: 'index_incomplete'; freshness?: string; reindexRequired?: boolean; reasonCode: StructuredRetrievalReasonCode | 'INDEX_PENDING_GENERATION' | 'INDEX_FILE_HASH_MISMATCH' | 'INDEX_IMPORT_HASH_MISMATCH' | 'INDEX_SYMBOL_HASH_MISMATCH' | 'INDEX_GENERATION_MISSING' | 'SYMBOL_RETIRED' | 'STRUCTURED_INDEX_MISSING' | 'FILE_NOT_FOUND' | 'INDEX_FILE_MISSING' }
  | { status: 'stale'; freshness?: string; reindexRequired?: boolean; reasonCode: StructuredRetrievalReasonCode | 'INDEX_FILE_HASH_MISMATCH' | 'INDEX_IMPORT_HASH_MISMATCH' | 'INDEX_FILE_MISSING' }
  | { status: 'not_found'; freshness?: string; reindexRequired?: boolean; reasonCode: 'FILE_NOT_FOUND' | 'SYMBOL_NOT_FOUND' | 'SYMBOL_RETIRED' | 'STRUCTURED_INDEX_MISSING' }
  | { status: 'excluded'; freshness?: string; reindexRequired?: boolean; reasonCode: 'PATH_EXCLUDED' }
  | { status: 'unsupported'; freshness?: string; reindexRequired?: boolean; reasonCode: 'unsupported_language' | 'STRUCTURED_SCHEMA_UNSUPPORTED' }
  | { status: 'failed'; reasonCode: 'parse_error' | 'invariant_violation' }
  | { status: 'not_indexed'; freshness?: string; reindexRequired?: boolean; reasonCode: 'STRUCTURED_INDEX_MISSING' | 'STRUCTURED_SCHEMA_UNSUPPORTED' };

type GlobalStateStatus =
  | {
      readonly status: 'not_indexed';
      readonly freshness: 'unknown';
      readonly reindexRequired: true;
      readonly reasonCode: 'STRUCTURED_INDEX_MISSING';
    }
  | {
      readonly status: 'unsupported';
      readonly freshness: 'unknown';
      readonly reindexRequired: false;
      readonly reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED';
    }
  | {
      readonly status: 'index_incomplete';
      readonly freshness: 'unknown';
      readonly reindexRequired: true;
      readonly reasonCode: 'INDEX_PENDING_GENERATION';
    };

type VerifiedSymbol =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly declaration: StructuredDeclaration;
      readonly filePath: string;
      /** Active generation checked during verification. */
      readonly generationId: string;
      readonly fileSha256: string;
      readonly fileCompleteness: 'complete' | 'partial';
    }
  | { readonly ok: false; readonly status: SourceStatus & { request?: { symbolId: string } } };

type NavigationFailure = Exclude<VerifiedSymbolNavigationResult, { readonly status: 'ok' }>;

const navigationFailure = (
  status: NavigationFailure['status'],
  reasonCode: string,
  reindexRequired: boolean,
): NavigationFailure => ({ status, reasonCode, reindexRequired });

const defaultReindexRequired: Readonly<Record<NavigationFailure['status'], boolean>> = {
  stale_identity: false,
  stale: true,
  not_found: false,
  not_indexed: true,
  index_incomplete: true,
  excluded: false,
  unsupported: false,
  degraded: false,
  error: false,
  cancelled: false,
};

/** Maps a private verifySymbol() failure onto the navigation result contract (Design §6.1). */
const navigationFailureFromStatus = (status: SourceStatus): NavigationFailure => {
  if (status.status === 'failed') {
    return navigationFailure('error', status.reasonCode === 'parse_error' ? 'PARSE_ERROR' : 'INVARIANT_VIOLATION', false);
  }
  if (status.status === 'ok') {
    return navigationFailure('error', 'INVARIANT_VIOLATION', false);
  }
  return navigationFailure(
    status.status,
    status.reasonCode,
    status.reindexRequired ?? defaultReindexRequired[status.status],
  );
};

export interface SymbolRetrievalServiceOptions {
  catalog: IStructuredCatalog;
  sanitizer: PathSanitizer;
  isExcluded?: (filePath: string) => boolean | Promise<boolean>;
  isSupportedLanguage?: (language: string) => boolean;
}

export class SymbolRetrievalService {
  constructor(private readonly options: SymbolRetrievalServiceOptions) {}

  async getFileOutline(input: { filePath: string; signal?: AbortSignal }): Promise<unknown> {
    const relativePath = this.options.sanitizer.validateProjectRelative(input.filePath);
    const state = await this.options.catalog.getStructuredIndexState();
    const domain = this.checkGlobalState(state);
    if (domain !== undefined) {
      return { ...domain, request: { filePath: input.filePath } };
    }

    if (this.options.isExcluded) {
      const excluded = await this.options.isExcluded(relativePath);
      if (excluded) {
        return {
          status: 'excluded',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'PATH_EXCLUDED',
          request: { filePath: input.filePath },
        };
      }
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolution = await this.options.catalog.resolveFile(relativePath);
      if (resolution.kind === 'pending') {
        return {
          status: 'index_incomplete',
          freshness: 'unknown',
          reindexRequired: true,
          reasonCode: 'INDEX_PENDING_GENERATION',
          request: { filePath: input.filePath },
        };
      }

      const readResult = await this.readCurrentBytes(relativePath, input.signal);
      if (resolution.kind === 'missing') {
        if (readResult.status !== 'ok') {
          return {
            status: 'not_found',
            freshness: 'unknown',
            reindexRequired: false,
            reasonCode: 'FILE_NOT_FOUND',
            request: { filePath: input.filePath },
          };
        }
        return {
          status: 'not_indexed',
          freshness: 'unknown',
          reindexRequired: true,
          reasonCode: 'STRUCTURED_INDEX_MISSING',
          request: { filePath: input.filePath },
        };
      }

      // Active file: verify freshness before returning metadata.
      if (readResult.status === 'excluded') {
        return {
          status: 'excluded',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'PATH_EXCLUDED',
          request: { filePath: input.filePath },
        };
      }
      if (readResult.status !== 'ok') {
        return {
          status: 'stale',
          freshness: 'stale',
          reindexRequired: true,
          reasonCode: readResult.reasonCode,
          request: { filePath: input.filePath },
        };
      }

      const generation = await this.options.catalog.getGeneration(relativePath, resolution.generationId);
      if (generation === null) {
        if (attempt === 0) {
          continue;
        }
        return {
          status: 'index_incomplete',
          freshness: 'unknown',
          reindexRequired: true,
          reasonCode: 'INDEX_GENERATION_MISSING',
          request: { filePath: input.filePath },
        };
      }

      const fileHash = sha256Hex(readResult.bytes);
      if (fileHash !== generation.fileHash) {
        const currentResolution = await this.options.catalog.resolveFile(relativePath);
        if (attempt === 0 && currentResolution.kind === 'active' && currentResolution.generationId !== resolution.generationId) {
          continue;
        }
        return {
          status: 'stale',
          freshness: 'stale',
          reindexRequired: true,
          reasonCode: 'INDEX_FILE_HASH_MISMATCH',
          request: { filePath: input.filePath },
        };
      }

      if (this.options.isSupportedLanguage && !this.options.isSupportedLanguage(generation.parserId)) {
        const currentResolution = await this.options.catalog.resolveFile(relativePath);
        if (attempt === 0 && currentResolution.kind === 'active' && currentResolution.generationId !== resolution.generationId) {
          continue;
        }
        return {
          status: 'unsupported',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'unsupported_language',
          request: { filePath: input.filePath },
        };
      }

      const declarations = await this.options.catalog.getFileDeclarations(relativePath);
      const currentResolution = await this.options.catalog.resolveFile(relativePath);
      if (currentResolution.kind !== 'active' || currentResolution.generationId !== resolution.generationId) {
        if (attempt === 0) {
          continue;
        }
        return {
          status: 'stale',
          freshness: 'stale',
          reindexRequired: true,
          reasonCode: 'INDEX_FILE_HASH_MISMATCH',
          request: { filePath: input.filePath },
        };
      }

      const symbols = declarations.map((declaration) => ({
        name: declaration.name,
        qualifiedName: declaration.qualifiedName,
        symbolId: declaration.symbolId,
        kind: declaration.kind,
        signatureDiscriminator: declaration.signatureDiscriminator,
        position: declaration.position,
        isExact: declaration.isExact,
        languageId: declaration.languageId,
        parentSymbolId: declaration.parentSymbolId ?? null,
      }));

      return {
        ...(generation.fileCompleteness === 'partial'
          ? { status: 'degraded', retrievability: 'partial', reasonCode: 'PARSER_COVERAGE_PARTIAL' }
          : { status: 'ok' }),
        freshness: 'fresh',
        reindexRequired: false,
        file: {
          filePath: relativePath,
          language: generation.parserId,
          parserId: generation.parserId,
          parserVersion: generation.parserVersion,
        },
        symbols,
        request: { filePath: input.filePath },
      };
    }

    return {
      status: 'index_incomplete',
      freshness: 'unknown',
      reindexRequired: true,
      reasonCode: 'INDEX_GENERATION_MISSING',
      request: { filePath: input.filePath },
    };
  }

  async getSymbolSource(input: { symbolId: string; signal?: AbortSignal }): Promise<SourceStatus & { request?: { symbolId: string } }> {
    const verified = await this.verifySymbol(input);
    if (!verified.ok) {
      return verified.status;
    }

    const symbolSlice = verified.bytes.subarray(verified.declaration.startByte, verified.declaration.endByte);
    const source = decodeUtf8(symbolSlice);
    return { status: 'ok', freshness: 'fresh', reindexRequired: false, source, request: { symbolId: input.symbolId } };
  }

  async getSymbolContext(input: { symbolId: string; tokenBudget: number; signal?: AbortSignal }): Promise<unknown> {
    const verified = await this.verifySymbol(input);
    if (!verified.ok) {
      return { ...verified.status, request: { symbolId: input.symbolId, tokenBudget: input.tokenBudget } };
    }

    const symbolSlice = verified.bytes.subarray(verified.declaration.startByte, verified.declaration.endByte);
    const symbolSource = decodeUtf8(symbolSlice);

    const importRecords = await this.options.catalog.getImportsForSymbol(input.symbolId);
    const candidates = this.verifyImports(verified.bytes, importRecords);
    if (!candidates.ok) {
      return { ...candidates.status, request: { symbolId: input.symbolId, tokenBudget: input.tokenBudget } };
    }

    const packed = packRelatedImports({
      symbolSource,
      imports: candidates.imports,
      tokenBudget: input.tokenBudget,
    });

    const importsById = new Map(importRecords.map((record) => [record.id, record]));
    const filePath = verified.filePath;
    const importsCompleteness = this.mergeCompleteness(importRecords);

    return {
      status: 'ok',
      freshness: 'fresh',
      reindexRequired: false,
      context: packed.context,
      filePath,
      imports: packed.imports.map((item) => ({
        id: item.id,
        moduleSpecifier: importsById.get(item.id)?.moduleSpecifier,
        startByte: item.startByte,
        endByte: importsById.get(item.id)?.endByte,
      })),
      importsCompleteness,
      tokenizer: packed.tokenizer,
      tokenizerVersion: packed.tokenizerVersion,
      budget: {
        requested: input.tokenBudget,
        actual: tokenCounter.count(packed.context),
        exceeded: packed.budget.exceeded,
        omittedForBudget: packed.budget.omittedForBudget,
      },
      request: { symbolId: input.symbolId, tokenBudget: input.tokenBudget },
    };
  }

  /**
   * Resolves a catalog `symbolId` to the verified AST identifier token of its declaration.
   * Fails closed: any stale, ambiguous or unsupported state returns a non-`ok` status without a target.
   * Unexpected I/O errors other than cancellation propagate, as with getSymbolSource().
   */
  async resolveVerifiedNavigationTarget(input: {
    symbolId: string;
    signal?: AbortSignal;
  }): Promise<VerifiedSymbolNavigationResult> {
    try {
      return await this.resolveVerifiedNavigationTargetUnsafe(input);
    } catch (error) {
      if (input.signal?.aborted || (error as Error | undefined)?.name === 'AbortError') {
        return navigationFailure('cancelled', 'REQUEST_CANCELLED', false);
      }
      throw error;
    }
  }

  private async resolveVerifiedNavigationTargetUnsafe(input: {
    symbolId: string;
    signal?: AbortSignal;
  }): Promise<VerifiedSymbolNavigationResult> {
    input.signal?.throwIfAborted();
    const verified = await this.verifySymbol(input);
    if (!verified.ok) {
      return navigationFailureFromStatus(verified.status);
    }

    const { declaration, filePath } = verified;
    if (!declaration.isExact || verified.fileCompleteness !== 'complete') {
      return navigationFailure('degraded', 'PARSER_COVERAGE_PARTIAL', false);
    }
    const languageId = declaration.languageId;
    if (languageId !== 'typescript' && languageId !== 'javascript') {
      return navigationFailure('unsupported', 'unsupported_language', false);
    }

    const containment = await this.checkCanonicalContainment(filePath);
    if (containment !== undefined) return containment;

    let position: { line: number; character: number } | null;
    try {
      position = resolveTsIdentifierPosition({ bytes: verified.bytes, declaration, filePath });
    } catch (error) {
      return navigationFailure('error', error instanceof Utf8SourceError ? 'INVARIANT_VIOLATION' : 'PARSE_ERROR', false);
    }
    if (position === null) {
      return navigationFailure('degraded', 'IDENTIFIER_TOKEN_UNRESOLVED', false);
    }

    // Recheck before returning: canonical containment, active generation, symbol identity, then current bytes.
    input.signal?.throwIfAborted();
    const recheckContainment = await this.checkCanonicalContainment(filePath);
    if (recheckContainment !== undefined) return recheckContainment;
    const currentFile = await this.options.catalog.resolveFile(filePath);
    if (currentFile.kind !== 'active' || currentFile.generationId !== verified.generationId) {
      return navigationFailure('stale', 'INDEX_FILE_HASH_MISMATCH', true);
    }
    const currentSymbol = await this.resolveSymbol(input.symbolId);
    if (currentSymbol.kind !== 'active' || currentSymbol.filePath !== filePath) {
      return navigationFailure('stale', 'INDEX_FILE_HASH_MISMATCH', true);
    }
    const reread = await this.readCurrentBytes(filePath, input.signal);
    if (reread.status === 'excluded') return navigationFailure('excluded', 'PATH_EXCLUDED', false);
    if (reread.status !== 'ok') {
      return navigationFailure('stale', reread.reasonCode, true);
    }
    if (sha256Hex(reread.bytes) !== verified.fileSha256) {
      return navigationFailure('stale', 'INDEX_FILE_HASH_MISMATCH', true);
    }
    input.signal?.throwIfAborted();

    return {
      status: 'ok',
      target: {
        symbolId: input.symbolId,
        filePath,
        languageId,
        position,
        fileSha256: verified.fileSha256,
        generationId: verified.generationId,
      },
    };
  }

  private async checkCanonicalContainment(filePath: string): Promise<VerifiedSymbolNavigationResult | undefined> {
    try {
      const canonicalPath = await this.options.sanitizer.resolveExisting(filePath);
      const canonicalRelativePath = path.relative(this.options.sanitizer.getProjectRoot(), canonicalPath).split(path.sep).join('/');
      if (this.options.isExcluded && await this.options.isExcluded(canonicalRelativePath)) {
        return navigationFailure('excluded', 'PATH_EXCLUDED', false);
      }
      return undefined;
    } catch (error) {
      if (error instanceof PathTraversalError) {
        return navigationFailure('excluded', 'PATH_EXCLUDED', false);
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return navigationFailure('stale', 'INDEX_FILE_MISSING', true);
      }
      throw error;
    }
  }

  private async resolveSymbol(symbolId: string): Promise<
    | { readonly kind: 'active'; readonly declaration: StructuredDeclaration; readonly filePath: string }
    | { readonly kind: 'pending'; readonly declaration: StructuredDeclaration }
    | { readonly kind: 'tombstone'; readonly tombstone: StructuredTombstone }
    | { readonly kind: 'missing' }
  > {
    const pending = await this.options.catalog.getPendingSymbol(symbolId);
    if (pending.kind === 'pending') {
      return pending;
    }
    const active = await this.options.catalog.resolveSymbol(symbolId);
    return active;
  }

  private async verifySymbol(input: { symbolId: string; signal?: AbortSignal }): Promise<VerifiedSymbol> {
    const state = await this.options.catalog.getStructuredIndexState();
    const domain = this.checkGlobalState(state);
    if (domain !== undefined) {
      return { ok: false, status: { ...domain, request: { symbolId: input.symbolId } } };
    }

    const resolution = await this.resolveSymbol(input.symbolId);
    if (resolution.kind === 'tombstone') {
      return {
        ok: false,
        status: {
          status: 'stale_identity',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'SYMBOL_RETIRED',
          request: { symbolId: input.symbolId },
        },
      };
    }
    if (resolution.kind === 'missing') {
      return {
        ok: false,
        status: {
          status: 'not_found',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'SYMBOL_NOT_FOUND',
          request: { symbolId: input.symbolId },
        },
      };
    }
    if (resolution.kind === 'pending') {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_PENDING_GENERATION', request: { symbolId: input.symbolId } } };
    }

    const filePath = resolution.filePath;
    if (this.options.isExcluded) {
      const excluded = await this.options.isExcluded(filePath);
      if (excluded) {
        return {
          ok: false,
          status: {
            status: 'excluded',
            freshness: 'unknown',
            reindexRequired: false,
            reasonCode: 'PATH_EXCLUDED',
            request: { symbolId: input.symbolId },
          },
        };
      }
    }
    const fileResolution = await this.options.catalog.resolveFile(filePath);
    if (fileResolution.kind === 'pending') {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_PENDING_GENERATION', request: { symbolId: input.symbolId } } };
    }

    const activeGeneration = fileResolution.kind === 'active' ? fileResolution.generationId : undefined;
    if (activeGeneration === undefined) {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_PENDING_GENERATION', request: { symbolId: input.symbolId } } };
    }
    if (this.options.isSupportedLanguage && !this.options.isSupportedLanguage(resolution.declaration.languageId)) {
      return { ok: false, status: { status: 'unsupported', reasonCode: 'unsupported_language', request: { symbolId: input.symbolId } } };
    }

    const generation = await this.options.catalog.getGeneration(filePath, activeGeneration);
    if (generation === null) {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_GENERATION_MISSING', request: { symbolId: input.symbolId } } };
    }

    const readResult = await this.readCurrentBytes(filePath, input.signal);
    if (readResult.status === 'excluded') {
      return { ok: false, status: { status: 'excluded', reasonCode: 'PATH_EXCLUDED', request: { symbolId: input.symbolId } } };
    }
    if (readResult.status !== 'ok') {
      return { ok: false, status: { status: 'stale', reasonCode: readResult.reasonCode, request: { symbolId: input.symbolId } } };
    }

    const fileHash = sha256Hex(readResult.bytes);
    if (fileHash !== generation.fileHash) {
      return { ok: false, status: { status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH', request: { symbolId: input.symbolId } } };
    }

    const symbolSlice = readResult.bytes.subarray(resolution.declaration.startByte, resolution.declaration.endByte);
    const sliceHash = sha256Hex(symbolSlice);
    if (sliceHash !== resolution.declaration.sourceHash) {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_SYMBOL_HASH_MISMATCH', request: { symbolId: input.symbolId } } };
    }

    return {
      ok: true,
      bytes: readResult.bytes,
      declaration: resolution.declaration,
      filePath,
      generationId: activeGeneration,
      fileSha256: fileHash,
      fileCompleteness: generation.fileCompleteness,
    };
  }

  private verifyImports(
    bytes: Uint8Array,
    importRecords: readonly StructuredImportRecord[],
  ): { ok: true; imports: Array<{ id: string; rawSource: string; startByte: number }> } | { ok: false; status: SourceStatus } {
    const imports: Array<{ id: string; rawSource: string; startByte: number }> = [];
    for (const imported of importRecords) {
      const { startByte, endByte, sourceHash, id } = imported;
      if (startByte < 0 || endByte > bytes.length || startByte >= endByte) {
        return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' } };
      }
      const slice = bytes.subarray(startByte, endByte);
      if (sha256Hex(slice) !== sourceHash) {
        return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' } };
      }
      imports.push({ id, rawSource: decodeUtf8(slice), startByte });
    }
    return { ok: true, imports };
  }

  private mergeCompleteness(importRecords: readonly StructuredImportRecord[]): 'complete' | 'partial' {
    return importRecords.every((item) => item.completeness === 'complete') ? 'complete' : 'partial';
  }

  private async readCurrentBytes(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<
    | { status: 'ok'; bytes: Uint8Array }
    | { status: 'stale'; reasonCode: 'INDEX_FILE_MISSING' | 'INDEX_FILE_HASH_MISMATCH' }
    | { status: 'excluded'; reasonCode: 'PATH_EXCLUDED' }
  > {
    try {
      const snapshot = await readCanonicalSource({
        filePath,
        sanitizer: this.options.sanitizer,
        isExcluded: this.options.isExcluded ?? (() => false),
        signal,
      });
      return { status: 'ok', bytes: snapshot.bytes };
    } catch (error) {
      if (error instanceof CanonicalSourceError) {
        switch (error.failure) {
          case 'escaped':
          case 'excluded':
            return { status: 'excluded', reasonCode: 'PATH_EXCLUDED' };
          case 'missing':
          case 'not_file':
            return { status: 'stale', reasonCode: 'INDEX_FILE_MISSING' };
          case 'changed':
            return { status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH' };
        }
      }
      throw error;
    }
  }

  private checkGlobalState(state: StructuredIndexState): GlobalStateStatus | undefined {
    if (state.schemaVersion !== null && state.schemaVersion !== 1) {
      return {
        status: 'unsupported',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED',
      };
    }
    if (state.rebuildState === 'building') {
      return {
        status: 'index_incomplete',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'INDEX_PENDING_GENERATION',
      };
    }
    if (state.schemaVersion === null || state.rebuildState === 'failed') {
      return {
        status: 'not_indexed',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'STRUCTURED_INDEX_MISSING',
      };
    }
    return undefined;
  }
}
