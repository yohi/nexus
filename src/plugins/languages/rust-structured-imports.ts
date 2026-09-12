import type Parser from 'tree-sitter';
import { createHash } from 'node:crypto';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './rust-structured-support.js';

interface ModuleSpecifier {
  readonly specifier: string;
  readonly bindingName?: string;
  readonly completeness: 'complete' | 'partial';
}

const moduleSpecifiersFor = (node: Parser.SyntaxNode): readonly ModuleSpecifier[] => {
  if (node.type !== 'use_declaration') return [];
  const argument = node.childForFieldName('argument');
  if (!argument) return [];

  const recursive = (n: Parser.SyntaxNode, prefix: string): readonly ModuleSpecifier[] => {
    if (n.type === 'scoped_identifier' || n.type === 'identifier') {
      const specifier = `${prefix}${n.text}`.replace(/^::/, '');
      const bindingName = n.type === 'identifier'
        ? n.text
        : (n.childForFieldName('name')?.text ?? n.text.split('::').at(-1));
      return [{ specifier, bindingName, completeness: 'complete' }];
    }
    if (n.type === 'use_wildcard') {
      const path = n.childForFieldName('path') ?? n.children.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      return [{
        specifier: `${prefix}${path?.text ?? ''}`.replace(/^::/, ''),
        bindingName: undefined,
        completeness: 'partial',
      }];
    }
    if (n.type === 'use_list') {
      return n.namedChildren.flatMap((child) => recursive(child, prefix));
    }
    return [];
  };

  const bindings = recursive(argument, '');
  return bindings.map((b) => ({
    specifier: b.specifier,
    bindingName: b.bindingName,
    completeness: b.completeness,
  }));
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const imports: StructuredImport[] = [];
  const occurrences = new Map<string, number>();

  for (const node of root.namedChildren) {
    if (node.type !== 'use_declaration' || hasSyntaxProblem(node)) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);

    for (const binding of moduleSpecifiersFor(node)) {
      const importKey = `${source.filePath}:${startByte}:${binding.specifier}:${binding.bindingName ?? ''}`;
      const occurrence = occurrences.get(importKey) ?? 0;
      occurrences.set(importKey, occurrence + 1);
      const stableImportKey = `${importKey}:${occurrence}`;
      imports.push({
        id: `import_v1_${createHash('sha256').update(stableImportKey, 'utf8').digest('base64url')}`,
        moduleSpecifier: binding.specifier,
        bindingName: binding.bindingName,
        startByte,
        endByte,
        sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
        completeness: binding.completeness,
        position: positionFor(node),
      });
    }
  }

  return imports;
};
