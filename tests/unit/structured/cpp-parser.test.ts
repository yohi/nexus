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

  it('preserves valid sibling classes and excludes a broken class', async () => {
    const { result } = await parseCppFixture('partial-class.cpp');
    const names = new Set(result.declarations.map((declaration) => declaration.qualifiedName));
    expect(result.status).toBe('degraded');
    expect(names.has('app.Good')).toBe(true);
    expect(names.has('app.AlsoGood')).toBe(true);
    expect(names.has('app.Bad')).toBe(false);
    expect(names.has('app.Bad.method')).toBe(false);
  });

  it('keeps exact byte ranges and hashes', async () => {
    const { bytes, result } = await parseCppFixture('exactness.cpp');
    const declaration = result.declarations.find((item) => item.qualifiedName === 'app.Widget');
    expect(declaration?.rawSource).toBe(decodeUtf8(bytes.subarray(declaration?.startByte ?? 0, declaration?.endByte ?? 0)));
    expect(declaration?.sourceHash).toBe(sha256Hex(bytes.subarray(declaration?.startByte ?? 0, declaration?.endByte ?? 0)));
  });
});
