import type Parser from 'tree-sitter';

import type { StructuredSource, SymbolPosition } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import type { SymbolKind } from '../../types/index.js';

export interface TreeSitterDeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly signaturePrefix?: string;
}

export interface TreeSitterStartByteContext {
  readonly node: Parser.SyntaxNode;
  readonly offsets: Utf8OffsetTable;
  readonly textLines: readonly string[];
  readonly lineStartOffsets: readonly number[];
}

const defaultDiagnosticFor = (node: Parser.SyntaxNode): string =>
  `${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column}`;

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (
  root: Parser.SyntaxNode,
  formatDiagnostic: (node: Parser.SyntaxNode) => string = defaultDiagnosticFor,
): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.isError || node.isMissing) diagnostics.push(formatDiagnostic(node));
    for (const child of node.children) visit(child);
  };
  visit(root);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode): SymbolPosition => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.childForFieldName('body')
    ?? node.childForFieldName('declaration_list')
    ?? node.namedChildren.find((child) => child.type === 'block');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const startByteFor = (node: Parser.SyntaxNode, offsets: Utf8OffsetTable): number =>
  offsets.byteOffsetAtUtf16(node.startIndex);
