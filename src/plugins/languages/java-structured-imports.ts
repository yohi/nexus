import type Parser from 'tree-sitter';

import type { StructuredImport } from '../../structured/contracts.js';
import {
  collectTreeSitterImports,
  type TreeSitterImportContext,
} from './tree-sitter-structured-imports.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'scoped_identifier'].includes(child.type))?.text;

export const importsFor = ({ source, root, offsets }: TreeSitterImportContext): readonly StructuredImport[] =>
  collectTreeSitterImports({
    source,
    root,
    offsets,
    isImportNode: (node) => node.type === 'import_declaration',
    candidatesFor: (node) => {
      const path = pathFor(node);
      if (path === undefined) return [];
      const wildcard = path.endsWith('.*') || /\.\*\s*;\s*$/u.test(node.text);
      const moduleSpecifier = path.endsWith('.*') ? path.slice(0, -2) : path;
      const bindingName = wildcard ? undefined : moduleSpecifier.split('.').at(-1);
      return [{ moduleSpecifier, bindingName, completeness: wildcard ? 'partial' : 'complete' }];
    },
  });
