import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './java-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'scoped_identifier'].includes(child.type))?.text;

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'import_declaration' || hasSyntaxProblem(node)) continue;
    const path = pathFor(node);
    if (path === undefined) continue;
    const wildcard = path.endsWith('.*') || /\.\*\s*;\s*$/u.test(node.text);
    const moduleSpecifier = path.endsWith('.*') ? path.slice(0, -2) : path;
    const bindingName = wildcard ? undefined : moduleSpecifier.split('.').at(-1);
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    const importKey = `${source.filePath}:${startByte}:${moduleSpecifier}:${bindingName ?? ''}`;
    const occurrence = occurrences.get(importKey) ?? 0;
    occurrences.set(importKey, occurrence + 1);
    imports.push({
      id: `import_v1_${createHash('sha256').update(`${importKey}:${occurrence}`, 'utf8').digest('base64url')}`,
      moduleSpecifier,
      bindingName,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: wildcard ? 'partial' : 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
