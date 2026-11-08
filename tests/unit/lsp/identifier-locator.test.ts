import { describe, expect, it } from 'vitest';

import { resolveTsIdentifierPosition } from '../../../src/lsp/identifier-locator.js';
import { TypeScriptStructuredParser } from '../../../src/plugins/languages/typescript-structured.js';
import type { StructuredDeclaration } from '../../../src/structured/contracts.js';
import { createStructuredSource } from '../../shared/structured-test-helpers.js';

const parse = async (
  text: string,
  filePath = 'src/a.ts',
): Promise<{ bytes: Uint8Array; declarations: readonly StructuredDeclaration[] }> => {
  const source = createStructuredSource(filePath, text);
  const parsed = await new TypeScriptStructuredParser().parseStructured(source);
  return { bytes: source.bytes, declarations: parsed.declarations };
};

const only = (
  declarations: readonly StructuredDeclaration[],
  qualifiedName: string,
): StructuredDeclaration => {
  const matches = declarations.filter((declaration) => declaration.qualifiedName === qualifiedName);
  expect(matches).toHaveLength(1);
  return matches[0] as StructuredDeclaration;
};

const locate = (
  bytes: Uint8Array,
  declaration: StructuredDeclaration,
  filePath = 'src/a.ts',
): { line: number; character: number } | null => resolveTsIdentifierPosition({ bytes, declaration, filePath });

describe('resolveTsIdentifierPosition', () => {
  it('returns the name token of an exported function, not the export keyword', async () => {
    const { bytes, declarations } = await parse('export function foo() { return 1; }');
    expect(locate(bytes, only(declarations, 'foo'))).toEqual({ line: 1, character: 16 });
  });

  it('skips JSDoc, decorators and modifiers before the name token', async () => {
    const text = [
      '/** doc */',
      'export abstract class Base {',
      '  /** method doc */',
      '  public static async run(): Promise<void> {}',
      '}',
    ].join('\n');
    const { bytes, declarations } = await parse(text);
    expect(locate(bytes, only(declarations, 'Base'))).toEqual({ line: 2, character: 22 });
    expect(locate(bytes, only(declarations, 'Base.run'))).toEqual({ line: 4, character: 22 });
  });

  it('resolves methods and nested namespace members by qualified name', async () => {
    const text = [
      'export namespace Outer {',
      '  export namespace Inner {',
      '    export class Widget {',
      '      render() { return 1; }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { bytes, declarations } = await parse(text);
    expect(locate(bytes, only(declarations, 'Outer'))).toEqual({ line: 1, character: 17 });
    expect(locate(bytes, only(declarations, 'Outer.Inner'))).toEqual({ line: 2, character: 19 });
    expect(locate(bytes, only(declarations, 'Outer.Inner.Widget'))).toEqual({ line: 3, character: 17 });
    expect(locate(bytes, only(declarations, 'Outer.Inner.Widget.render'))).toEqual({ line: 4, character: 6 });
  });

  it('resolves variables, interfaces, enums, type aliases and properties', async () => {
    const text = [
      'export const handler = () => 1;',
      'interface Shape { size: number }',
      'enum Color { Red }',
      'type Alias = string;',
      'class Box { value = 1; get size() { return 1; } }',
    ].join('\n');
    const { bytes, declarations } = await parse(text);
    expect(locate(bytes, only(declarations, 'handler'))).toEqual({ line: 1, character: 13 });
    expect(locate(bytes, only(declarations, 'Shape'))).toEqual({ line: 2, character: 10 });
    expect(locate(bytes, only(declarations, 'Color'))).toEqual({ line: 3, character: 5 });
    expect(locate(bytes, only(declarations, 'Alias'))).toEqual({ line: 4, character: 5 });
    expect(locate(bytes, only(declarations, 'Box.value'))).toEqual({ line: 5, character: 12 });
    expect(locate(bytes, only(declarations, 'Box.size'))).toEqual({ line: 5, character: 27 });
  });

  it('maps each overload and repeated same-signature declaration to its own token', async () => {
    const text = [
      'export function f(a: string): void;',
      'export function f(a: number): void;',
      'export function f(a: unknown): void {}',
      'declare function g(): void;',
      'declare function g(): void;',
    ].join('\n');
    const { bytes, declarations } = await parse(text);
    const fs = declarations.filter((declaration) => declaration.qualifiedName === 'f');
    expect(fs).toHaveLength(3);
    expect(fs.map((declaration) => locate(bytes, declaration))).toEqual([
      { line: 1, character: 16 },
      { line: 2, character: 16 },
      { line: 3, character: 16 },
    ]);
    const gs = declarations.filter((declaration) => declaration.qualifiedName === 'g');
    expect(gs).toHaveLength(2);
    expect(gs[0]?.symbolId).not.toBe(gs[1]?.symbolId);
    expect(gs.map((declaration) => locate(bytes, declaration))).toEqual([
      { line: 4, character: 17 },
      { line: 5, character: 17 },
    ]);
  });

  it('reports UTF-16 characters for Unicode and non-BMP source', async () => {
    const text = '/* 😀 é */ export function naïve() {}\nconst 𝒳 = 1;';
    const { bytes, declarations } = await parse(text);
    // "/* 😀 é */ " is 11 UTF-16 code units (the emoji is a surrogate pair).
    expect(locate(bytes, only(declarations, 'naïve'))).toEqual({ line: 1, character: 27 });
    expect(locate(bytes, only(declarations, '𝒳'))).toEqual({ line: 2, character: 6 });
  });

  it('refuses default anonymous constructs without an unambiguous identifier', async () => {
    for (const text of [
      'export default function () { return 1; }',
      'export default class { run() {} }',
      'export default () => 1;',
      'export default function named() { return 1; }',
    ]) {
      const { bytes, declarations } = await parse(text);
      const declaration = only(declarations, 'default');
      expect(locate(bytes, declaration)).toBeNull();
    }
  });

  it('refuses constructors and string-named ambient modules', async () => {
    const { bytes, declarations } = await parse('class A { constructor() {} }\ndeclare module "pkg" {}');
    expect(locate(bytes, only(declarations, 'A.constructor'))).toBeNull();
    expect(locate(bytes, only(declarations, 'pkg'))).toBeNull();
  });

  it('refuses nonexact or partial declaration ranges instead of guessing', async () => {
    const { bytes, declarations } = await parse('export function foo() { return 1; }\nfunction bar() {}');
    const foo = only(declarations, 'foo');
    expect(locate(bytes, { ...foo, startByte: foo.startByte + 7 })).toBeNull();
    expect(locate(bytes, { ...foo, endByte: foo.endByte - 1 })).toBeNull();
    expect(locate(bytes, { ...foo, isExact: false })).toBeNull();
  });

  it('never falls through to a textually similar declaration', async () => {
    const text = 'namespace A { export function run() {} }\nnamespace B { export function run() {} }';
    const { bytes, declarations } = await parse(text);
    const aRun = only(declarations, 'A.run');
    const bRun = only(declarations, 'B.run');
    expect(locate(bytes, aRun)).toEqual({ line: 1, character: 30 });
    expect(locate(bytes, bRun)).toEqual({ line: 2, character: 30 });
    // Range of B.run with A.run's identity, or a mismatched kind/signature, must not resolve.
    expect(locate(bytes, { ...aRun, startByte: bRun.startByte, endByte: bRun.endByte })).toBeNull();
    expect(locate(bytes, { ...aRun, kind: 'method' })).toBeNull();
    expect(locate(bytes, { ...aRun, signatureDiscriminator: 'other' })).toBeNull();
    expect(locate(bytes, { ...aRun, name: 'other' })).toBeNull();
  });

  it('parses JavaScript and TSX by file extension', async () => {
    const js = await parse('export function jsFn() {}', 'src/a.js');
    expect(locate(js.bytes, only(js.declarations, 'jsFn'), 'src/a.js')).toEqual({ line: 1, character: 16 });
    const tsx = await parse('export const View = () => <div />;', 'src/a.tsx');
    expect(locate(tsx.bytes, only(tsx.declarations, 'View'), 'src/a.tsx')).toEqual({ line: 1, character: 13 });
  });
});
