import type Parser from 'tree-sitter';
import type { StructuredImport } from '../../structured/contracts.js';
import {
  collectTreeSitterImports,
  type TreeSitterImportContext,
} from './tree-sitter-structured-imports.js';

interface ModuleSpecifier {
  readonly moduleSpecifier: string;
  readonly bindingName?: string;
  readonly completeness: 'complete' | 'partial';
}

const moduleSpecifiersFor = (node: Parser.SyntaxNode): readonly ModuleSpecifier[] => {
  if (node.type !== 'use_declaration') return [];
  const argument = node.childForFieldName('argument');
  if (!argument) return [];

  const recursive = (n: Parser.SyntaxNode, prefix: string): readonly ModuleSpecifier[] => {
    if (n.type === 'scoped_identifier' || n.type === 'identifier') {
      const moduleSpecifier = `${prefix}${n.text}`.replace(/^::/, '');
      const bindingName = n.type === 'identifier'
        ? n.text
        : (n.childForFieldName('name')?.text ?? n.text.split('::').at(-1));
      return [{ moduleSpecifier, bindingName, completeness: 'complete' }];
    }
    if (n.type === 'use_as_clause') {
      const path = n.childForFieldName('path') ?? n.namedChildren[0];
      const alias = n.childForFieldName('alias') ?? n.namedChildren.at(-1);
      if (path === undefined || alias === undefined) return [];
      return [{
        moduleSpecifier: `${prefix}${path.text}`.replace(/^::/, ''),
        bindingName: alias.text,
        completeness: 'complete',
      }];
    }
    if (n.type === 'scoped_use_list') {
      const path = n.childForFieldName('path') ?? n.namedChildren.find((child) => child.type !== 'use_list');
      const list = n.childForFieldName('list') ?? n.namedChildren.find((child) => child.type === 'use_list');
      if (path === undefined || list === undefined) return [];
      const nestedPrefix = `${prefix}${path.text}`.replace(/^::/, '') + '::';
      return recursive(list, nestedPrefix);
    }
    if (n.type === 'use_wildcard') {
      const path = n.childForFieldName('path') ?? n.children.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      return [{
        moduleSpecifier: `${prefix}${path?.text ?? ''}`.replace(/^::/, ''),
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
    moduleSpecifier: b.moduleSpecifier,
    bindingName: b.bindingName,
    completeness: b.completeness,
  }));
};

export const importsFor = ({ source, root, offsets }: TreeSitterImportContext): readonly StructuredImport[] =>
  collectTreeSitterImports({
    source,
    root,
    offsets,
    isImportNode: (node) => node.type === 'use_declaration',
    candidatesFor: moduleSpecifiersFor,
  });
