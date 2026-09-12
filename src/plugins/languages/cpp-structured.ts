import type Parser from 'tree-sitter';
import type Cpp from 'tree-sitter-cpp';
import type {
  StructuredDeclaration,
  StructuredGeneration,
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
} from '../../structured/utf8-offsets.js';
import { declarationsFor, type DeclarationDescriptor } from './cpp-structured-declarations.js';
import { importsFor } from './cpp-structured-imports.js';
import {
  diagnosticsFor,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
  startByteFor,
} from './cpp-structured-support.js';

export interface CppTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Cpp: typeof Cpp;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'cpp',
  parserVersion: '0.23.4',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

const declarationsWithIds = (
  source: StructuredSource,
  descriptors: readonly DeclarationDescriptor[],
  offsets: ReturnType<typeof createUtf8OffsetTable>,
): readonly StructuredDeclaration[] => {
  const occurrences = new Map<string, number>();
  const drafts = descriptors.flatMap((descriptor) => {
    if (
      hasSyntaxProblem(descriptor.node) ||
      hasSyntaxProblem(descriptor.rangeNode) ||
      (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
    ) return [];
    const signatureDiscriminator = signatureFor(source, descriptor.node);
    const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const startByte = startByteFor(descriptor.rangeNode, offsets);
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

export class CppStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: CppTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (source.bytes.length === 0) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'C++ structured parsing requires source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Cpp);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const diagnostics = diagnosticsFor(root);
    const declarations = declarationsWithIds(source, declarationsFor(root), offsets);
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);
    return diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations, imports, generation }
      : {
          status: 'degraded',
          retrievability: 'partial',
          declarations,
          imports,
          generation,
          failure: { reasonCode: 'parse_error', message: 'C++ parse diagnostics were reported.' },
        };
  }
}
