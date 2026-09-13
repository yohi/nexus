import type Parser from 'tree-sitter';

import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredImport,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
  type Utf8OffsetTable,
} from '../../structured/utf8-offsets.js';
import {
  diagnosticsFor,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
  startByteFor,
  type TreeSitterDeclarationDescriptor,
  type TreeSitterStartByteContext,
} from './tree-sitter-structured-support.js';
import type { TreeSitterImportContext } from './tree-sitter-structured-imports.js';

export interface TreeSitterRuntime<TLanguage> {
  readonly Parser: typeof Parser;
  readonly language: TLanguage;
}

export interface TreeSitterStructuredParserOptions {
  readonly languageId: string;
  readonly parserVersion: string;
  readonly emptySourceMessage: string;
  readonly declarationsFor: (root: Parser.SyntaxNode) => readonly TreeSitterDeclarationDescriptor[];
  readonly importsFor: (context: TreeSitterImportContext) => readonly StructuredImport[];
  readonly signatureFor?: (source: StructuredSource, node: Parser.SyntaxNode) => string;
  readonly startByteFor?: (context: TreeSitterStartByteContext) => number;
  readonly diagnosticFor?: (node: Parser.SyntaxNode) => string;
  readonly checkScopeNode?: boolean;
}

interface DeclarationDraft {
  readonly declaration: StructuredDeclaration;
  readonly descriptor: TreeSitterDeclarationDescriptor;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
  options: TreeSitterStructuredParserOptions,
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: options.languageId,
  parserVersion: options.parserVersion,
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

const lineStartOffsetsFor = (text: string): readonly number[] => {
  const lineStarts = [0];
  for (let newlineIndex = text.indexOf('\n'); newlineIndex !== -1; newlineIndex = text.indexOf('\n', newlineIndex + 1)) {
    lineStarts.push(newlineIndex + 1);
  }
  return lineStarts;
};

const declarationsWithIds = (
  source: StructuredSource,
  descriptors: readonly TreeSitterDeclarationDescriptor[],
  offsets: Utf8OffsetTable,
  options: TreeSitterStructuredParserOptions,
): readonly StructuredDeclaration[] => {
  const resolveSignature = options.signatureFor ?? signatureFor;
  const resolveStartByte = options.startByteFor ?? ((context) => startByteFor(context.node, context.offsets));
  const textLines = options.startByteFor === undefined ? [] : source.text.split('\n');
  const lineStartOffsets = options.startByteFor === undefined ? [] : lineStartOffsetsFor(source.text);
  const occurrences = new Map<string, number>();
  const drafts = descriptors.flatMap((descriptor): readonly DeclarationDraft[] => {
    const scopeHasProblem = options.checkScopeNode === true
      && descriptor.scopeNode !== undefined
      && hasSyntaxProblem(descriptor.scopeNode);
    if (hasSyntaxProblem(descriptor.node) || hasSyntaxProblem(descriptor.rangeNode) || scopeHasProblem) return [];

    const signature = resolveSignature(source, descriptor.node);
    const signatureDiscriminator = descriptor.signaturePrefix === undefined
      ? signature
      : `${descriptor.signaturePrefix} ${signature}`.trim();
    const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const startByte = resolveStartByte({ node: descriptor.rangeNode, offsets, textLines, lineStartOffsets });
    const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
    const declaration: StructuredDeclaration = {
      symbolId: createSymbolId({
        filePath: source.filePath,
        qualifiedName: descriptor.qualifiedName,
        kind: descriptor.kind,
        signatureDiscriminator,
        occurrence,
      }),
      qualifiedName: descriptor.qualifiedName,
      kind: descriptor.kind,
      signatureDiscriminator,
      position: positionFor(descriptor.rangeNode),
      name: descriptor.name,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      languageId: source.language,
      isExact: true,
      rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
    };
    return [{ descriptor, declaration }];
  });
  const symbolByKey = new Map(drafts.map(({ descriptor, declaration }) => [descriptor.declarationKey, declaration.symbolId]));
  return drafts.map(({ descriptor, declaration }) => {
    const parentSymbolId = descriptor.ownerKey === undefined ? undefined : symbolByKey.get(descriptor.ownerKey);
    return parentSymbolId === undefined ? declaration : { ...declaration, parentSymbolId };
  });
};

const parseStructuredSource = async <TLanguage>(
  source: StructuredSource,
  runtime: TreeSitterRuntime<TLanguage>,
  options: TreeSitterStructuredParserOptions,
): Promise<StructuredParseResult> => {
  if (source.bytes.byteLength === 0) {
    return {
      status: 'degraded',
      retrievability: 'partial',
      declarations: [],
      imports: [],
      failure: { reasonCode: 'invariant_violation', message: options.emptySourceMessage },
    };
  }

  const parser = new runtime.Parser();
  parser.setLanguage(runtime.language);
  const root = parser.parse(source.text).rootNode;
  let offsets: Utf8OffsetTable;
  try {
    offsets = createUtf8OffsetTable(source.text, source.bytes);
  } catch (error) {
    if (error instanceof Utf8SourceError) return failedStructuredSource(error);
    throw error;
  }

  const diagnostics = diagnosticsFor(root, options.diagnosticFor);
  const declarations = declarationsWithIds(source, options.declarationsFor(root), offsets, options);
  const imports = options.importsFor({ source, root, offsets });
  const generation = generationFor(source, diagnostics, options);
  if (diagnostics.length === 0) {
    return { status: 'ok', retrievability: 'exact', declarations, imports, generation };
  }
  return {
    status: 'degraded',
    retrievability: 'partial',
    declarations,
    imports,
    generation,
    failure: { reasonCode: 'parse_error', message: `${options.languageId} parse diagnostics were reported.` },
  };
};

export const createTreeSitterStructuredParserClass = <TLanguage>(
  options: TreeSitterStructuredParserOptions,
): new (runtime: TreeSitterRuntime<TLanguage>) => StructuredLanguageParser => class implements StructuredLanguageParser {
  constructor(private readonly runtime: TreeSitterRuntime<TLanguage>) {}

  parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    return parseStructuredSource(source, this.runtime, options);
  }
};
