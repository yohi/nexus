import type Parser from 'tree-sitter';

import type { StructuredImport } from '../../structured/contracts.js';
import {
  collectTreeSitterImports,
  type TreeSitterImportContext,
} from './tree-sitter-structured-imports.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.childForFieldName('name') ?? node.namedChildren.find((child) =>
    ['identifier', 'qualified_name', 'alias_qualified_name'].includes(child.type));
  return pathNode?.text;
};

export const importsFor = ({ source, root, offsets }: TreeSitterImportContext): readonly StructuredImport[] =>
  collectTreeSitterImports({
    source,
    root,
    offsets,
    includeBindingInKey: false,
    isImportNode: (node) => node.type === 'using_directive',
    candidatesFor: (node) => {
      const moduleSpecifier = pathFor(node);
      if (moduleSpecifier === undefined) return [];
      const staticImport = node.text.trimStart().startsWith('using static ');
      return [{ moduleSpecifier, completeness: staticImport ? 'partial' : 'complete' }];
    },
  });
