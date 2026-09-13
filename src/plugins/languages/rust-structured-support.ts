import type { TreeSitterStartByteContext } from './tree-sitter-structured-support.js';

export const declarationStartByteFor = ({
  node,
  offsets,
  textLines,
  lineStartOffsets,
}: TreeSitterStartByteContext): number => {
  let lineIndex = node.startPosition.row;
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
  const lineStartOffset = lineStartOffsets[lineIndex] ?? 0;
  const charOffset = lineIndex === node.startPosition.row
    ? lineStartOffset + node.startPosition.column
    : lineStartOffset;
  return offsets.byteOffsetAtUtf16(charOffset);
};
