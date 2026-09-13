import type Parser from 'tree-sitter';
import { hasSyntaxProblem } from './tree-sitter-structured-support.js';

type DeclarationKind = 'namespace' | 'function' | 'struct' | 'class' | 'enum' | 'method' | 'constructor';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly qualifiedName: string;
}

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly typeName?: string;
}

const keyFor = (node: Parser.SyntaxNode, index = 0): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}:${index}`;

const join = (scope: string, name: string): string => scope === '' ? name : `${scope}.${name}`;

const declaratorName = (node: Parser.SyntaxNode): string | undefined => {
  const nested = node.childForFieldName('declarator');
  if (nested !== null) return declaratorName(nested) ?? nested.text;
  return node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'field_identifier', 'type_identifier'].includes(child.type))?.text;
};

const functionDeclaratorFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined => {
  if (node.type === 'function_declarator' || node.type === 'function_field_declarator') return node;
  for (const child of node.namedChildren) {
    const result = functionDeclaratorFor(child);
    if (result !== undefined) return result;
  }
  return undefined;
};

const memberDescriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (node.type !== 'function_definition' && node.type !== 'declaration' && node.type !== 'field_declaration') return undefined;
  const declarator = functionDeclaratorFor(node);
  const name = declarator === undefined ? undefined : declaratorName(declarator);
  if (name === undefined || scope.typeName === undefined) return undefined;
  const kind = name === scope.typeName ? 'constructor' : 'method';
  return {
    node,
    rangeNode: node,
    scopeNode: scope.scopeNode,
    declarationKey: keyFor(node),
    ownerKey: scope.ownerKey,
    kind,
    name,
    qualifiedName: join(scope.qualifiedName, name),
  };
};

const typeKindFor = (node: Parser.SyntaxNode): 'struct' | 'class' | 'enum' => {
  if (node.type === 'struct_specifier') return 'struct';
  if (node.type === 'class_specifier') return 'class';
  return 'enum';
};

const namespaceDescriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (node.type !== 'namespace_definition') return undefined;
  const name = node.childForFieldName('name')?.text;
  return name === undefined ? undefined : {
    node, rangeNode: node, scopeNode: scope.scopeNode, declarationKey: keyFor(node),
    ownerKey: scope.ownerKey, kind: 'namespace', name,
    qualifiedName: join(scope.qualifiedName, name),
  };
};

const typeDescriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (node.type !== 'struct_specifier' && node.type !== 'class_specifier' && node.type !== 'enum_specifier') {
    return undefined;
  }
  const name = node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    child.type === 'type_identifier')?.text;
  return name === undefined ? undefined : {
    node, rangeNode: node, scopeNode: scope.scopeNode, declarationKey: keyFor(node),
    ownerKey: scope.ownerKey, kind: typeKindFor(node), name,
    qualifiedName: join(scope.qualifiedName, name),
  };
};

const functionDescriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (node.type !== 'function_definition') return undefined;
  const name = declaratorName(node);
  return name === undefined ? undefined : {
    node, rangeNode: node, scopeNode: scope.scopeNode, declarationKey: keyFor(node),
    ownerKey: scope.ownerKey, kind: 'function', name,
    qualifiedName: join(scope.qualifiedName, name),
  };
};

const descriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (scope.typeName !== undefined) {
    const member = memberDescriptorFor(node, scope);
    if (member !== undefined) return member;
  }
  return namespaceDescriptorFor(node, scope)
    ?? typeDescriptorFor(node, scope)
    ?? functionDescriptorFor(node, scope);
};

const bodyFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.childForFieldName('body') ?? node.namedChildren.find((child) =>
    ['declaration_list', 'field_declaration_list', 'compound_statement'].includes(child.type));

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const unresolved: DeclarationDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptor = descriptorFor(node, scope);
    if (descriptor !== undefined) {
      unresolved.push(descriptor);
      if (!['namespace', 'struct', 'class'].includes(descriptor.kind)) return;
      if (
        hasSyntaxProblem(descriptor.node) ||
        hasSyntaxProblem(descriptor.rangeNode) ||
        (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
      ) return;
      const body = bodyFor(node);
      if (body === undefined) return;
      const childScope: Scope = {
        qualifiedName: descriptor.qualifiedName,
        ownerKey: descriptor.declarationKey,
        scopeNode: node,
        ...(descriptor.kind === 'class' || descriptor.kind === 'struct' ? { typeName: descriptor.name } : {}),
      };
      for (const child of body.namedChildren) walk(child, childScope);
      return;
    }
    for (const child of node.namedChildren) walk(child, scope);
  };

  for (const child of root.namedChildren) walk(child, { qualifiedName: '' });
  return unresolved;
};
