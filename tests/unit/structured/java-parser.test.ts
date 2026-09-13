import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JavaLanguagePlugin } from '../../../src/plugins/languages/java.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseJavaFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'java', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new JavaLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'java', bytes, text });
  return { bytes, result, text };
};

describe('Java structured parser', () => {
  it('extracts package, class, interface, enum, record, constructor, method, field', async () => {
    const { bytes, result } = await parseJavaFixture('Exactness.java');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(result.status).toBe('ok');
    expect(byName.get('com.example')?.kind).toBe('namespace');
    expect(byName.get('com.example.Exactness')?.kind).toBe('class');
    expect(byName.get('com.example.Exactness.Point')?.kind).toBe('record');
    expect(byName.get('com.example.Exactness.Drawable')?.kind).toBe('interface');
    expect(byName.get('com.example.Exactness.Color')?.kind).toBe('enum');
    expect(byName.get('com.example.Exactness.field')?.kind).toBe('field');
    expect(byName.get('com.example.Exactness.Exactness')?.kind).toBe('constructor');
    expect(byName.get('com.example.Exactness.method')?.kind).toBe('method');
    expect(byName.get('com.example.Exactness')?.parentSymbolId)
      .toBe(byName.get('com.example')?.symbolId);
    expect(byName.get('com.example.Exactness.method')?.parentSymbolId)
      .toBe(byName.get('com.example.Exactness')?.symbolId);

    const point = byName.get('com.example.Exactness.Point');
    expect(point?.rawSource).toBe(
      decodeUtf8(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)),
    );
    expect(point?.sourceHash).toBe(
      sha256Hex(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)),
    );
  });

  it('extracts imports and marks wildcard imports partial', async () => {
    const { result } = await parseJavaFixture('Exactness.java');
    const listImport = result.imports.find((i) => i.moduleSpecifier === 'java.util.List');
    const wildcard = result.imports.find((i) => i.moduleSpecifier === 'java.util');
    expect(listImport?.bindingName).toBe('List');
    expect(listImport?.completeness).toBe('complete');
    expect(wildcard?.completeness).toBe('partial');
  });

  it('keeps package-less declarations at the root scope', async () => {
    const { result } = await parseJavaFixture('PackageLess.java');
    const declaration = result.declarations.find((d) => d.qualifiedName === 'PackageLess');
    expect(declaration?.kind).toBe('class');
    expect(declaration?.parentSymbolId).toBeUndefined();
  });

  it('does not flatten declarations from a broken class into package scope', async () => {
    const { result } = await parseJavaFixture('Partial.java');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));
    expect(result.status).toBe('degraded');
    expect(byName.get('com.example.Unaffected')?.kind).toBe('class');
    expect(byName.has('com.example.Broken')).toBe(false);
    expect(byName.has('com.example.Broken.good')).toBe(false);
    expect(byName.has('good')).toBe(false);
  });
});
