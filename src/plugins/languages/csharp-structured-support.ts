import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (root: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.isError || node.isMissing) {
      diagnostics.push(`${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column}`);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  if (node.type === 'property_declaration') return node.text.replace(/\s+/gu, ' ').trim();
  const body = node.childForFieldName('body') ?? node.childForFieldName('declaration_list');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const startByteFor = (node: Parser.SyntaxNode, offsets: Utf8OffsetTable): number =>
  offsets.byteOffsetAtUtf16(node.startIndex);
