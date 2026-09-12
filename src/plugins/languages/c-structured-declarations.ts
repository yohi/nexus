import type Parser from 'tree-sitter';
import { hasSyntaxProblem } from './c-structured-support.js';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: 'function' | 'struct' | 'enum';
  readonly name: string;
  readonly qualifiedName: string;
}

const keyFor = (node: Parser.SyntaxNode): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}`;

const declaratorName = (node: Parser.SyntaxNode): string | undefined => {
  const named = node.childForFieldName('declarator');
  if (named !== null) return declaratorName(named) ?? named.text;
  return node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'type_identifier'].includes(child.type))?.text;
};

const descriptorFor = (node: Parser.SyntaxNode): DeclarationDescriptor | undefined => {
  if (node.type === 'function_definition') {
    const name = declaratorName(node);
    return name === undefined ? undefined : {
      node, rangeNode: node, declarationKey: keyFor(node), kind: 'function', name, qualifiedName: name,
    };
  }
  const taggedType = node.type === 'declaration' ? node.childForFieldName('type') : node;
  if (taggedType?.type === 'struct_specifier' || taggedType?.type === 'enum_specifier') {
    const name = taggedType.childForFieldName('name')?.text ?? taggedType.namedChildren.find((child) =>
      child.type === 'type_identifier')?.text;
    return name === undefined ? undefined : {
      node,
      rangeNode: taggedType,
      declarationKey: keyFor(node),
      kind: taggedType.type === 'struct_specifier' ? 'struct' : 'enum',
      name,
      qualifiedName: name,
    };
  }
  return undefined;
};

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const result: DeclarationDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    const descriptor = descriptorFor(node);
    if (descriptor !== undefined) {
      if (!hasSyntaxProblem(descriptor.node) && !hasSyntaxProblem(descriptor.rangeNode)) result.push(descriptor);
      return;
    }
    for (const child of node.namedChildren) walk(child);
  };
  for (const child of root.namedChildren) walk(child);
  return result;
};
