import type Parser from 'tree-sitter';
import type Rust from 'tree-sitter-rust';
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
import { declarationsFor } from './rust-structured-declarations.js';
import { importsFor } from './rust-structured-imports.js';
import {
  diagnosticsFor,
  findDeclarationStartByte,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
} from './rust-structured-support.js';

export interface RustTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Rust: typeof Rust;
}

const generationFor = (source: StructuredSource, diagnostics: readonly string[]): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'rust',
  parserVersion: '0.24.0',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

export class RustStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: RustTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'Rust structured parsing requires original source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Rust);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const textLines = source.text.split('\n');
    const diagnostics = diagnosticsFor(root);
    const occurrences = new Map<string, number>();
    const drafts: { declaration: StructuredDeclaration; ownerKey?: string; declarationKey: string }[] = [];

    for (const descriptor of declarationsFor(root)) {
      if (
        hasSyntaxProblem(descriptor.node) ||
        hasSyntaxProblem(descriptor.rangeNode) ||
        (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
      ) continue;
      const signatureDiscriminator = signatureFor(source, descriptor.node);
      const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const startByte = findDeclarationStartByte(
        textLines,
        descriptor.rangeNode.startPosition.row + 1,
        descriptor.rangeNode.startPosition.column,
        offsets,
      );
      const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
      drafts.push({
        declarationKey: descriptor.declarationKey,
        declaration: {
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
        },
        ownerKey: descriptor.ownerKey,
      });
    }

    const ownerSymbols = new Map(
      drafts
        .map(({ declarationKey, declaration }) => [declarationKey, declaration.symbolId]),
    );
    const declarations = drafts.map(({ declaration, ownerKey }) => {
      const parentSymbolId = ownerKey === undefined ? undefined : ownerSymbols.get(ownerKey);
      return parentSymbolId ? { ...declaration, parentSymbolId } : declaration;
    });
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);

    if (diagnostics.length === 0) {
      return { status: 'ok', retrievability: 'exact', declarations, imports, generation };
    }
    return {
      status: 'degraded',
      retrievability: 'partial',
      declarations,
      imports,
      generation,
      failure: { reasonCode: 'parse_error', message: 'Rust parse diagnostics were reported.' },
    };
  }
}
