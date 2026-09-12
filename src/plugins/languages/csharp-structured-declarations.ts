import type Parser from 'tree-sitter';
import type { SymbolKind } from '../../types/index.js';
import { hasSyntaxProblem } from './csharp-structured-support.js';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
}

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
}

const declarationKeyFor = (node: Parser.SyntaxNode, index = 0): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}:${index}`;

const join = (scope: string, name: string): string => scope === '' ? name : `${scope}.${name}`;

const bodyFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.childForFieldName('body') ??
  node.namedChildren.find((child) =>
    ['declaration_list', 'class_body', 'struct_body', 'enum_body', 'block'].includes(child.type));

const kindFor = (node: Parser.SyntaxNode): SymbolKind | undefined => {
  switch (node.type) {
    case 'namespace_declaration':
    case 'file_scoped_namespace_declaration': return 'namespace';
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'struct_declaration': return 'struct';
    case 'enum_declaration': return 'enum';
    case 'record_declaration': return 'record';
    case 'method_declaration': return 'method';
    case 'constructor_declaration': return 'constructor';
    case 'property_declaration': return 'property';
    default: return undefined;
  }
};

const nameFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'type_identifier', 'qualified_name'].includes(child.type))?.text;

const descriptorsForNode = (node: Parser.SyntaxNode, scope: Scope): readonly DeclarationDescriptor[] => {
  const kind = kindFor(node);
  if (kind === undefined) return [];
  const name = nameFor(node);
  return name === undefined ? [] : [{
    node,
    rangeNode: node,
    scopeNode: scope.scopeNode,
    declarationKey: declarationKeyFor(node),
    ownerKey: scope.ownerKey,
    kind,
    name,
    qualifiedName: join(scope.qualifiedName, name),
  }];
};

const isContainer = (kind: SymbolKind): boolean =>
  ['namespace', 'class', 'interface', 'struct', 'enum', 'record'].includes(kind);

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const unresolved: DeclarationDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptors = descriptorsForNode(node, scope);
    if (descriptors.length > 0) {
      unresolved.push(...descriptors);
      const container = descriptors[0];
      if (container === undefined || !isContainer(container.kind)) return;
      if (
        hasSyntaxProblem(container.node) ||
        hasSyntaxProblem(container.rangeNode) ||
        (container.scopeNode !== undefined && hasSyntaxProblem(container.scopeNode))
      ) return;
      const body = bodyFor(node);
      if (body === undefined) return;
      const childScope: Scope = {
        qualifiedName: container.qualifiedName,
        ownerKey: container.declarationKey,
        scopeNode: node,
      };
      for (const child of body.namedChildren) walk(child, childScope);
      return;
    }
    for (const child of node.namedChildren) walk(child, scope);
  };

  const walkSiblings = (children: readonly Parser.SyntaxNode[], scope: Scope): void => {
    let currentScope = scope;
    for (const child of children) {
      if (child.type !== 'file_scoped_namespace_declaration') {
        walk(child, currentScope);
        continue;
      }

      const descriptor = descriptorsForNode(child, currentScope)[0];
      if (descriptor === undefined) continue;
      unresolved.push(descriptor);
      if (
        hasSyntaxProblem(descriptor.node) ||
        hasSyntaxProblem(descriptor.rangeNode) ||
        (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
      ) return;
      currentScope = {
        qualifiedName: descriptor.qualifiedName,
        ownerKey: descriptor.declarationKey,
        scopeNode: descriptor.node,
      };
    }
  };

  walkSiblings(root.namedChildren, { qualifiedName: '' });
  return unresolved;
};
