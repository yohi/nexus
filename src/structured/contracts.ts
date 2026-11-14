import type { SymbolKind } from '../types/index.js';

export interface StructuredSource {
  readonly filePath: string;
  readonly language: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface StructuredLanguageParser {
  parseStructured(source: StructuredSource): Promise<StructuredParseResult>;
}

export interface SymbolPosition {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface SymbolMetadata {
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly signatureDiscriminator: string;
  readonly position: SymbolPosition;
}

export interface StructuredDeclaration extends SymbolMetadata {
  readonly name: string;
  readonly symbolId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sourceHash: string;
  readonly parentSymbolId?: string;
  readonly languageId: string;
  readonly isExact: boolean;
  readonly rawSource?: string;
  readonly importBindingIds?: readonly string[];
}

export interface StructuredImport {
  readonly id: string;
  readonly moduleSpecifier?: string;
  readonly bindingName?: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sourceHash: string;
  readonly completeness: 'complete' | 'partial';
  readonly diagnostics?: readonly unknown[];
  readonly position: SymbolPosition;
}

export interface StructuredGeneration {
  readonly generationId: string;
  readonly schemaVersion: 1;
  readonly rebuildEpoch?: number | undefined;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly fileHash: string;
  readonly fileCompleteness: 'complete' | 'partial';
  readonly fileDiagnostics?: readonly unknown[];
}

export const structuredRetrievalStatus = {
  ok: 'ok',
  degraded: 'degraded',
  unsupported: 'unsupported',
  failed: 'failed',
} as const;
export type StructuredRetrievalStatus = typeof structuredRetrievalStatus[keyof typeof structuredRetrievalStatus];

export type StructuredFileState =
  | { readonly status: 'exact'; readonly retrievability: 'complete' }
  | { readonly status: 'degraded'; readonly retrievability: 'partial' }
  | { readonly status: 'unsupported'; readonly retrievability: 'none' };

export const structuredRetrievalReasonCode = {
  parseError: 'parse_error',
  unsupportedLanguage: 'unsupported_language',
  invalidUtf8: 'invalid_utf8',
  invariantViolation: 'invariant_violation',
} as const;
export type StructuredRetrievalReasonCode = typeof structuredRetrievalReasonCode[keyof typeof structuredRetrievalReasonCode];

export interface StructuredFailure {
  readonly reasonCode: StructuredRetrievalReasonCode;
  readonly message: string;
}

export type StructuredParseResult = {
  readonly declarations: readonly StructuredDeclaration[];
  readonly imports: readonly StructuredImport[];
  readonly generation?: StructuredGeneration;
} & (
  | { readonly status: 'ok'; readonly retrievability: 'exact'; readonly failure?: never }
  | { readonly status: 'degraded'; readonly retrievability: 'partial'; readonly failure: StructuredFailure }
  | { readonly status: 'unsupported'; readonly retrievability: 'none'; readonly failure: StructuredFailure }
  | { readonly status: 'failed'; readonly retrievability: 'none'; readonly failure: StructuredFailure }
);
