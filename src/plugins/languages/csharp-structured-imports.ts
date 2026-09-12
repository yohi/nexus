import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './csharp-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.childForFieldName('name') ?? node.namedChildren.find((child) =>
    ['identifier', 'qualified_name', 'alias_qualified_name'].includes(child.type));
  return pathNode?.text;
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'using_directive' || hasSyntaxProblem(node)) continue;
    const moduleSpecifier = pathFor(node);
    if (moduleSpecifier === undefined) continue;
    const staticImport = node.text.trimStart().startsWith('using static ');
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
      completeness: staticImport ? 'partial' : 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
