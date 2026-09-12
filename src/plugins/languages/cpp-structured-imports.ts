import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './cpp-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.namedChildren.find((child) =>
    child.type === 'system_lib_string' || child.type === 'string_literal');
  if (pathNode === undefined) return undefined;
  return pathNode.text.slice(1, -1);
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'preproc_include' || hasSyntaxProblem(node)) continue;
    const moduleSpecifier = pathFor(node);
    if (moduleSpecifier === undefined) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    const key = `${source.filePath}:${startByte}:${moduleSpecifier}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    imports.push({
      id: `import_v1_${createHash('sha256').update(`${key}:${occurrence}`, 'utf8').digest('base64url')}`,
      moduleSpecifier,
      bindingName: undefined,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
