import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseCppFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'cpp', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new CppLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'cpp', bytes, text });
  return { bytes, result };
};

describe('C++ structured parser', () => {
  it('extracts namespace, function, struct, class, enum, constructor, method', async () => {
    const { result } = await parseCppFixture('exactness.cpp');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));

    expect(result.status).toBe('ok');
    expect(byName.get('app')?.kind).toBe('namespace');
    expect(byName.get('app.Point')?.kind).toBe('struct');
    expect(byName.get('app.StructWidget')?.kind).toBe('struct');
    expect(byName.get('app.StructWidget.StructWidget')?.kind).toBe('constructor');
    expect(byName.get('app.StructWidget.render')?.kind).toBe('method');
    expect(byName.get('app.StructWidget.render')?.parentSymbolId)
      .toBe(byName.get('app.StructWidget')?.symbolId);
    expect(byName.get('app.Widget')?.kind).toBe('class');
    expect(byName.get('app.Widget.Widget')?.kind).toBe('constructor');
    expect(byName.get('app.Widget.render')?.kind).toBe('method');
    expect(byName.get('app.InlineWidget.InlineWidget')?.kind).toBe('constructor');
    expect(byName.get('app.InlineWidget.inlineRender')?.kind).toBe('method');
    expect(byName.get('app.Widget.render')?.parentSymbolId).toBe(byName.get('app.Widget')?.symbolId);
    expect(byName.get('app.Color')?.kind).toBe('enum');
    expect(byName.get('app.freeFunction')?.kind).toBe('function');
    const duplicateClasses = result.declarations.filter((item) => item.qualifiedName === 'app.Duplicate');
    const first = result.declarations.find((item) => item.qualifiedName === 'app.Duplicate.first');
    const second = result.declarations.find((item) => item.qualifiedName === 'app.Duplicate.second');
    expect(duplicateClasses).toHaveLength(2);
    expect(first?.parentSymbolId).toBe(duplicateClasses[0]?.symbolId);
    expect(second?.parentSymbolId).toBe(duplicateClasses[1]?.symbolId);
    expect(result.imports.find((item) => item.moduleSpecifier === 'vector')?.completeness).toBe('complete');
    expect(result.imports.find((item) => item.moduleSpecifier === 'exactness.h')?.completeness).toBe('complete');
  });

  it('treats .h as C++', async () => {
    const plugin = new CppLanguagePlugin();
    expect(plugin.supports('src/example.h')).toBe(true);
    const { result } = await parseCppFixture('exactness.h');
    expect(result.declarations.find((d) => d.qualifiedName === 'app.HeaderOnly')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'app.HeaderOnly.headerMethod')?.kind).toBe('method');
  });

  it('preserves valid sibling scopes and does not flatten a broken namespace', async () => {
    const { result } = await parseCppFixture('partial.cpp');
    const names = new Set(result.declarations.map((declaration) => declaration.qualifiedName));
    expect(result.status).toBe('degraded');
    expect(names.has('app.good')).toBe(true);
    expect(names.has('broken')).toBe(false);
    expect(names.has('broken.bad')).toBe(false);
    expect(names.has('bad')).toBe(false);
  });

  it('keeps exact byte ranges and hashes', async () => {
    const { bytes, result } = await parseCppFixture('exactness.cpp');
    const declaration = result.declarations.find((item) => item.qualifiedName === 'app.Widget');
    expect(declaration?.rawSource).toBe(decodeUtf8(bytes.subarray(declaration?.startByte ?? 0, declaration?.endByte ?? 0)));
    expect(declaration?.sourceHash).toBe(sha256Hex(bytes.subarray(declaration?.startByte ?? 0, declaration?.endByte ?? 0)));
  });

  it('keeps C++ template prefixes in declaration ranges and signatures', async () => {
    const classSource = [
      'template <typename T>',
      'class Point {',
      'public:',
      '    T value;',
      '};',
    ].join('\n');
    const functionSource = 'template <typename T>\nT add(T left, T right) { return left + right; }';
    const text = `${classSource}\n\n${functionSource}\n`;
    const bytes = new TextEncoder().encode(text);
    const parser = await new CppLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({
      filePath: 'template.cpp',
      language: 'cpp',
      bytes,
      text,
    });

    const point = result.declarations.find((declaration) => declaration.qualifiedName === 'Point');
    const add = result.declarations.find((declaration) => declaration.qualifiedName === 'add');

    expect(result.status).toBe('ok');
    expect(point?.rawSource).toBe(classSource);
    expect(point?.startByte).toBe(0);
    expect(point?.endByte).toBe(Buffer.byteLength(classSource, 'utf8'));
    expect(point?.signatureDiscriminator).toBe('template <typename T> class Point');
    expect(add?.rawSource).toBe(functionSource);
    expect(add?.signatureDiscriminator).toBe('template <typename T> T add(T left, T right)');
  });

  it('collects nested and macro include targets with accurate completeness', async () => {
    const text = [
      '#include <vector>',
      '#include HEADER',
      '#include MACRO(foo)',
      '#if FLAG',
      '#include "conditional.h"',
      '#endif',
      'namespace nested {',
      '#include "nested.h"',
      '}',
      '',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const parser = await new CppLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({
      filePath: 'includes.cpp',
      language: 'cpp',
      bytes,
      text,
    });

    const findImport = (moduleSpecifier: string) =>
      result.imports.find((item) => item.moduleSpecifier === moduleSpecifier);

    expect(result.status).toBe('ok');
    expect(findImport('vector')?.completeness).toBe('complete');
    expect(findImport('HEADER')?.completeness).toBe('partial');
    expect(findImport('MACRO(foo)')?.completeness).toBe('partial');
    expect(findImport('conditional.h')?.completeness).toBe('complete');
    expect(findImport('nested.h')?.completeness).toBe('complete');
  });
});
