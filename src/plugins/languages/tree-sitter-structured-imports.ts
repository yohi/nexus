import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';

import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './tree-sitter-structured-support.js';

export interface TreeSitterImportContext {
  readonly source: StructuredSource;
  readonly root: Parser.SyntaxNode;
  readonly offsets: Utf8OffsetTable;
}

export interface TreeSitterImportCandidate {
  readonly moduleSpecifier: string;
  readonly bindingName?: string;
  readonly completeness: 'complete' | 'partial';
}

interface TreeSitterImportCollectorOptions extends TreeSitterImportContext {
  readonly isImportNode: (node: Parser.SyntaxNode) => boolean;
  readonly candidatesFor: (node: Parser.SyntaxNode) => readonly TreeSitterImportCandidate[];
  readonly includeBindingInKey?: boolean;
}

export const collectTreeSitterImports = ({
  source,
  root,
  offsets,
  isImportNode,
  candidatesFor,
  includeBindingInKey = true,
}: TreeSitterImportCollectorOptions): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (!isImportNode(node) || hasSyntaxProblem(node)) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    for (const candidate of candidatesFor(node)) {
      const bindingKey = includeBindingInKey ? `:${candidate.bindingName ?? ''}` : '';
      const key = `${source.filePath}:${startByte}:${candidate.moduleSpecifier}${bindingKey}`;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const stableImportKey = `${key}:${occurrence}`;
      imports.push({
        id: `import_v1_${createHash('sha256').update(stableImportKey, 'utf8').digest('base64url')}`,
        moduleSpecifier: candidate.moduleSpecifier,
        bindingName: candidate.bindingName,
        startByte,
        endByte,
        sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
        completeness: candidate.completeness,
        position: positionFor(node),
      });
    }
  }
  return imports;
};

const includePathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.namedChildren.find((child) =>
    child.type === 'system_lib_string' || child.type === 'string_literal');
  return pathNode === undefined ? undefined : pathNode.text.slice(1, -1);
};

export const importsForPreprocessorIncludes = (
  context: TreeSitterImportContext,
): readonly StructuredImport[] => collectTreeSitterImports({
  ...context,
  includeBindingInKey: false,
  isImportNode: (node) => node.type === 'preproc_include',
  candidatesFor: (node) => {
    const moduleSpecifier = includePathFor(node);
    return moduleSpecifier === undefined
      ? []
      : [{ moduleSpecifier, completeness: 'complete' }];
  },
});
