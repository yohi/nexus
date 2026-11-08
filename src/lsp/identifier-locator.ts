import ts from 'typescript';

import { describeDeclaration } from '../plugins/languages/typescript-structured-declarations.js';
import { declarationStart, signatureFor } from '../plugins/languages/typescript-structured-signatures.js';
import type { StructuredDeclaration } from '../structured/contracts.js';
import { decodeUtf8 } from '../structured/hash.js';
import { createUtf8OffsetTable, Utf8SourceError } from '../structured/utf8-offsets.js';

export interface IdentifierPosition {
  /** Nexus 1-based line. */
  readonly line: number;
  /** UTF-16 code units, 0-based. */
  readonly character: number;
}

/**
 * Returns the declaration's *name token* only when it is an identifier or private identifier.
 * Keywords (`constructor`), string-literal module names and anonymous constructs yield undefined.
 */
const nameTokenOf = (node: ts.Node): ts.Identifier | ts.PrivateIdentifier | undefined => {
  if (ts.isExportAssignment(node) || ts.isConstructorDeclaration(node)) return undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isVariableDeclaration(node)
  ) {
    const name: ts.Node | undefined = node.name;
    if (name !== undefined && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) return name;
  }
  return undefined;
};

/**
 * Locates the AST identifier token for a verified Structured Catalog declaration.
 *
 * The declaration must correspond to exactly one AST declaration with the same indexed kind,
 * qualified name, signature discriminator and exact byte range. Any ambiguity, unsupported
 * declaration shape or name mismatch returns null; locations are never guessed from text.
 *
 * @throws Utf8SourceError when the bytes are not consistent UTF-8 source.
 */
export const resolveTsIdentifierPosition = (input: {
  bytes: Uint8Array;
  declaration: StructuredDeclaration;
  filePath: string;
}): IdentifierPosition | null => {
  const { bytes, declaration, filePath } = input;
  if (!declaration.isExact) return null;
  if (declaration.startByte < 0 || declaration.endByte > bytes.length || declaration.startByte >= declaration.endByte) {
    return null;
  }

  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Utf8SourceError('invalid_utf8', 'Navigation source bytes are not valid UTF-8.', { cause: error });
    }
    throw error;
  }
  const offsets = createUtf8OffsetTable(text, bytes);
  // Script kind (TS/TSX/JS/JSX) is inferred from the file extension, matching structured indexing.
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);

  const matches: ts.Node[] = [];
  const visit = (node: ts.Node, parents: readonly string[]): void => {
    const descriptor = describeDeclaration(node);
    if (descriptor) {
      const start = declarationStart(sourceFile, descriptor.rangeStartNode);
      const qualifiedName = [...parents, descriptor.name].join('.');
      if (
        offsets.byteOffsetAtUtf16(start) === declaration.startByte &&
        offsets.byteOffsetAtUtf16(node.end) === declaration.endByte &&
        descriptor.kind === declaration.kind &&
        qualifiedName === declaration.qualifiedName &&
        descriptor.name === declaration.name &&
        signatureFor(sourceFile, descriptor) === declaration.signatureDiscriminator
      ) {
        matches.push(node);
      }
    }
    const childParents = descriptor?.createsScope ? [...parents, descriptor.name] : parents;
    ts.forEachChild(node, (child) => visit(child, childParents));
  };
  visit(sourceFile, []);

  if (matches.length !== 1) return null;
  const match = matches[0] as ts.Node;
  const token = nameTokenOf(match);
  if (token === undefined) return null;

  // The name token must spell the indexed name and lie inside the verified declaration slice.
  if (token.text.normalize('NFC') !== declaration.name) return null;
  const tokenStart = token.getStart(sourceFile);
  const tokenStartByte = offsets.byteOffsetAtUtf16(tokenStart);
  const tokenEndByte = offsets.byteOffsetAtUtf16(token.end);
  if (tokenStartByte < declaration.startByte || tokenEndByte > declaration.endByte || tokenStartByte >= tokenEndByte) {
    return null;
  }

  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < tokenStart; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a || code === 0x0d) {
      if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index += 1;
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line: line + 1, character: tokenStart - lineStart };
};
