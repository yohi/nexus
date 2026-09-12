import type Parser from 'tree-sitter';
import type { SymbolKind } from '../../types/index.js';
import { hasSyntaxProblem } from './java-structured-support.js';

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

type UnresolvedDescriptor = DeclarationDescriptor;

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
}

const keyFor = (node: Parser.SyntaxNode, index = 0): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}:${index}`;

const join = (scope: string, name: string): string => scope === '' ? name : `${scope}.${name}`;

const nameFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'type_identifier', 'scoped_identifier'].includes(child.type))?.text;

const bodyFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.childForFieldName('body') ?? node.namedChildren.find((child) =>
    ['class_body', 'interface_body', 'enum_body', 'record_body', 'block'].includes(child.type));

const kindFor = (node: Parser.SyntaxNode): SymbolKind | undefined => {
  switch (node.type) {
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'enum_declaration': return 'enum';
    case 'record_declaration': return 'record';
    case 'method_declaration': return 'method';
    case 'constructor_declaration': return 'constructor';
    case 'field_declaration': return 'field';
    default: return undefined;
  }
};

const descriptorsForNode = (node: Parser.SyntaxNode, scope: Scope): UnresolvedDescriptor[] => {
  if (node.type === 'package_declaration') {
    const name = nameFor(node);
    return name === undefined ? [] : [{
      node, rangeNode: node, scopeNode: scope.scopeNode,
      declarationKey: keyFor(node), ownerKey: scope.ownerKey, kind: 'namespace', name,
      qualifiedName: join(scope.qualifiedName, name),
    }];
  }

  const kind = kindFor(node);
  if (kind === undefined) return [];
  if (kind === 'field') {
    return node.namedChildren
      .filter((child) => child.type === 'variable_declarator')
      .flatMap((child, index) => {
        const name = child.childForFieldName('name')?.text;
        return name === undefined ? [] : [{
          node, rangeNode: node, scopeNode: scope.scopeNode,
          declarationKey: keyFor(child, index), ownerKey: scope.ownerKey, kind, name,
          qualifiedName: join(scope.qualifiedName, name),
        }];
      })
  }

  const name = nameFor(node);
  return name === undefined ? [] : [{
    node, rangeNode: node, scopeNode: scope.scopeNode,
    declarationKey: keyFor(node), ownerKey: scope.ownerKey, kind, name,
    qualifiedName: join(scope.qualifiedName, name),
  }];
};

const isContainer = (descriptor: UnresolvedDescriptor): boolean =>
  ['namespace', 'class', 'interface', 'enum', 'record'].includes(descriptor.kind);

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const packageNode = root.namedChildren.find((child) => child.type === 'package_declaration');
  const packageDescriptor = packageNode === undefined
    ? undefined
    : descriptorsForNode(packageNode, { qualifiedName: '' })[0];
  const unresolved: UnresolvedDescriptor[] = [];
  if (packageDescriptor !== undefined) unresolved.push(packageDescriptor);

  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptors = descriptorsForNode(node, scope);
    for (const descriptor of descriptors) {
      if (descriptor.node === packageNode) continue;
      unresolved.push(descriptor);
      if (isContainer(descriptor)) {
        const body = bodyFor(node);
        if (body === undefined || hasSyntaxProblem(node)) continue;
        const childScope = {
          qualifiedName: descriptor.qualifiedName,
          ownerKey: descriptor.declarationKey,
          scopeNode: descriptor.node,
        };
        for (const child of body.namedChildren) walk(child, childScope);
      }
    }
  };

  const baseScope = packageDescriptor === undefined
    ? { qualifiedName: '' }
    : {
        qualifiedName: packageDescriptor.qualifiedName,
        ownerKey: packageDescriptor.declarationKey,
        scopeNode: packageDescriptor.node,
      };
  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration' || child.type === 'import_declaration') continue;
    walk(child, baseScope);
  }
  return unresolved;
};
