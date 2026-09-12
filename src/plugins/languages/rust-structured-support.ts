import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (node: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (current: Parser.SyntaxNode): void => {
    if (current.isError || current.isMissing) {
      diagnostics.push(`${current.type} at ${current.startPosition.row + 1}:${current.startPosition.column}`);
    }
    for (const child of current.children) visit(child);
  };
  visit(node);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.children.find((child) => child.type === 'block');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const findDeclarationStartByte = (
  textLines: readonly string[],
  startLine: number,
  startColumn: number,
  offsets: Utf8OffsetTable,
): number => {
  let lineIndex = startLine - 1;
  while (lineIndex > 0) {
    const previousLine = textLines[lineIndex - 1];
    if (previousLine === undefined) break;
    const trimmed = previousLine.trim();
    if (trimmed === '') break;
    if (trimmed.startsWith('//')) {
      lineIndex -= 1;
      continue;
    }
    break;
  }
  const lineStartOffset = textLines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
  const charOffset = lineIndex === startLine - 1 ? lineStartOffset + startColumn : lineStartOffset;
  return offsets.byteOffsetAtUtf16(charOffset);
};
