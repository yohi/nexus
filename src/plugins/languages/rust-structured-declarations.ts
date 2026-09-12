import type Parser from 'tree-sitter';
import type { SymbolKind } from '../../types/index.js';
import { hasSyntaxProblem } from './rust-structured-support.js';

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

interface UnresolvedDescriptor extends DeclarationDescriptor {
  readonly targetQualifiedName?: string;
}

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
}

const declarationKeyFor = (node: Parser.SyntaxNode): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}`;

const joinQualifiedName = (scope: string, name: string): string =>
  scope === '' ? name : `${scope}.${name}`;

const nameNodeText = (node: Parser.SyntaxNode): string | undefined => {
  const name = node.childForFieldName('name');
  return name?.text;
};

const bodyNode = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.children.find((child) => child.type === 'declaration_list' || child.type === 'block');

const kindForType = (node: Parser.SyntaxNode): SymbolKind => {
  if (node.type === 'enum_item') return 'enum';
  if (node.type === 'trait_item') return 'trait';
  return 'struct';
};

const kindForFunction = (
  node: Parser.SyntaxNode,
  scope: Scope,
): SymbolKind => {
  if (node.type === 'function_item' && scope.scopeNode?.type === 'impl_item') {
    return 'method';
  }
  return 'function';
};

const declarationFor = (
  node: Parser.SyntaxNode,
  scope: Scope,
): UnresolvedDescriptor | undefined => {
  const declarationKey = declarationKeyFor(node);
  const ownerKey = scope.ownerKey;
  const scopeNode = scope.scopeNode;
  if (node.type === 'mod_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: 'namespace',
      name,
      qualifiedName: joinQualifiedName(scope.qualifiedName, name),
    };
  }
  if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'trait_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: kindForType(node),
      name,
      qualifiedName: joinQualifiedName(scope.qualifiedName, name),
    };
  }
  if (node.type === 'impl_item') {
    const typeNode = node.childForFieldName('type') ?? node.children.find((c) => c.type === 'type');
    const traitNode = node.childForFieldName('trait');
    const name = typeNode?.text;
    if (!name) return undefined;
    const targetQualifiedName = joinQualifiedName(scope.qualifiedName, name);
    const qualifiedName = traitNode
      ? `${joinQualifiedName(scope.qualifiedName, traitNode.text)}.${name}.impl`
      : `${targetQualifiedName}.impl`;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: 'impl',
      name,
      qualifiedName,
      targetQualifiedName,
    };
  }
  if (node.type === 'function_item' || node.type === 'function_signature_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: kindForFunction(node, scope),
      name,
      qualifiedName: joinQualifiedName(scope.qualifiedName, name),
    };
  }
  return undefined;
};

const isContainer = (descriptor: UnresolvedDescriptor): boolean =>
  descriptor.kind === 'namespace' || descriptor.kind === 'impl' || descriptor.kind === 'trait';

type TypeDescriptor = Pick<UnresolvedDescriptor, 'qualifiedName' | 'declarationKey'>;

const childrenScopeFor = (
  descriptor: UnresolvedDescriptor,
  typeDescriptors: readonly TypeDescriptor[],
): Scope => {
  if (descriptor.kind === 'impl') {
    const targetQualifiedName = descriptor.targetQualifiedName ?? descriptor.qualifiedName;
    const targetCandidates = typeDescriptors.filter((candidate) => candidate.qualifiedName === targetQualifiedName);
    const target = targetCandidates.length === 1 ? targetCandidates[0] : undefined;
    return {
      qualifiedName: targetQualifiedName,
      ownerKey: target?.declarationKey,
      scopeNode: descriptor.node,
    };
  }
  return {
    qualifiedName: descriptor.qualifiedName,
    ownerKey: descriptor.declarationKey,
    scopeNode: descriptor.node,
  };
};

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const typeDescriptors: TypeDescriptor[] = [];
  const collectTypeDescriptors = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptor = declarationFor(node, scope);
    if (descriptor === undefined) return;
    if (descriptor.kind === 'struct' || descriptor.kind === 'enum' || descriptor.kind === 'trait') {
      typeDescriptors.push(descriptor);
    }
    if (!isContainer(descriptor)) return;
    const body = bodyNode(node);
    if (body === undefined) return;
    const childScope = descriptor.kind === 'impl'
      ? { qualifiedName: descriptor.targetQualifiedName ?? descriptor.qualifiedName, scopeNode: descriptor.node }
      : { qualifiedName: descriptor.qualifiedName, ownerKey: descriptor.declarationKey, scopeNode: descriptor.node };
    for (const child of body.namedChildren) collectTypeDescriptors(child, childScope);
  };
  for (const child of root.namedChildren) collectTypeDescriptors(child, { qualifiedName: '' });

  const unresolved: UnresolvedDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptor = declarationFor(node, scope);
    if (descriptor === undefined) return;
    unresolved.push(descriptor);
    if (!isContainer(descriptor)) return;
    if (hasSyntaxProblem(node)) return;
    const body = bodyNode(node);
    if (body === undefined) return;
    const childScope = childrenScopeFor(descriptor, typeDescriptors);
    for (const child of body.namedChildren) walk(child, childScope);
  };

  for (const child of root.namedChildren) {
    walk(child, { qualifiedName: '' });
  }

  return unresolved.map(({ targetQualifiedName: _target, ...descriptor }) => descriptor);
};
