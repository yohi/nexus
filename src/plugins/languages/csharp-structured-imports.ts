import type Parser from 'tree-sitter';

import type { StructuredImport } from '../../structured/contracts.js';
import {
  collectTreeSitterImports,
  type TreeSitterImportContext,
} from './tree-sitter-structured-imports.js';

interface CSharpImportPath {
  readonly moduleSpecifier: string;
  readonly bindingName?: string;
}

const pathFor = (node: Parser.SyntaxNode): CSharpImportPath | undefined => {
  const bindingName = node.childForFieldName('name');
  const equals = node.children.find((child) => child.type === '=');
  if (bindingName !== null && equals !== undefined) {
    const moduleSpecifier = node.namedChildren.find((child) => child.startIndex > equals.endIndex);
    if (moduleSpecifier !== undefined) {
      return { moduleSpecifier: moduleSpecifier.text, bindingName: bindingName.text };
    }
  }

  const alias = node.namedChildren.find((child) => child.type === 'identifier');
  const qualifiedPath = node.namedChildren.find((child) =>
    ['qualified_name', 'alias_qualified_name'].includes(child.type));
  if (alias !== undefined && qualifiedPath !== undefined) {
    return { moduleSpecifier: qualifiedPath.text, bindingName: alias.text };
  }

  const pathNode = node.childForFieldName('name') ?? qualifiedPath ?? alias;
  return pathNode === undefined ? undefined : { moduleSpecifier: pathNode.text };
};

export const importsFor = ({ source, root, offsets }: TreeSitterImportContext): readonly StructuredImport[] =>
  collectTreeSitterImports({
    source,
    root,
    offsets,
    includeBindingInKey: false,
    isImportNode: (node) => node.type === 'using_directive',
    candidatesFor: (node) => {
      const path = pathFor(node);
      if (path === undefined) return [];
      const staticImport = node.text.trimStart().startsWith('using static ');
      return [{ ...path, completeness: staticImport ? 'partial' : 'complete' }];
    },
  });
