import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSharpLanguagePlugin } from '../../../src/plugins/languages/csharp.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseCSharpFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'csharp', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new CSharpLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'csharp', bytes, text });
  return { bytes, result };
};

describe('C# structured parser', () => {
  it('extracts declarations, direct owners, exact ranges, and imports', async () => {
    const { bytes, result } = await parseCSharpFixture('Exactness.cs');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));

    expect(result.status).toBe('ok');
    expect(byName.get('MyApp')?.kind).toBe('namespace');
    expect(byName.get('MyApp.Exactness')?.kind).toBe('class');
    expect(byName.get('MyApp.Exactness.Point')?.kind).toBe('struct');
    expect(byName.get('MyApp.Exactness.IDrawable')?.kind).toBe('interface');
    expect(byName.get('MyApp.Exactness.Color')?.kind).toBe('enum');
    expect(byName.get('MyApp.Exactness.Person')?.kind).toBe('record');
    expect(byName.get('MyApp.Exactness.Exactness')?.kind).toBe('constructor');
    expect(byName.get('MyApp.Exactness.Method')?.kind).toBe('method');
    expect(byName.get('MyApp.Exactness.Point.X')?.kind).toBe('property');
    expect(byName.get('MyApp.Exactness.Method')?.parentSymbolId).toBe(byName.get('MyApp.Exactness')?.symbolId);
    expect(byName.get('MyApp.Exactness.Point.X')?.parentSymbolId).toBe(byName.get('MyApp.Exactness.Point')?.symbolId);

    const point = byName.get('MyApp.Exactness.Point');
    expect(point?.rawSource).toBe(decodeUtf8(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));
    expect(point?.sourceHash).toBe(sha256Hex(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));

    const regular = result.imports.find((item) => item.moduleSpecifier === 'System');
    const staticImport = result.imports.find((item) => item.moduleSpecifier === 'System.Math');
    expect(regular?.completeness).toBe('complete');
    expect(staticImport?.completeness).toBe('partial');
  });

  it('applies file-scoped namespace to following declarations', async () => {
    const { result } = await parseCSharpFixture('FileScoped.cs');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));
    expect(byName.get('FileScoped')?.kind).toBe('namespace');
    expect(byName.get('FileScoped.Container')?.kind).toBe('class');
    expect(byName.get('FileScoped.Container.Method')?.parentSymbolId)
      .toBe(byName.get('FileScoped.Container')?.symbolId);
  });

  it('does not flatten members from a broken class', async () => {
    const { result } = await parseCSharpFixture('Partial.cs');
    const names = new Set(result.declarations.map((declaration) => declaration.qualifiedName));
    expect(result.status).toBe('degraded');
    expect(names.has('MyApp.Unaffected')).toBe(true);
    expect(names.has('BrokenNamespace.Broken')).toBe(false);
    expect(names.has('BrokenNamespace.Broken.Good')).toBe(false);
    expect(names.has('Good')).toBe(false);
  });

  it('preserves UTF-8 byte ranges for declarations near multi-byte text', async () => {
    const { bytes, result } = await parseCSharpFixture('Unicode.cs');
    const point = result.declarations.find((declaration) => declaration.qualifiedName === 'UnicodeDemo.Point');

    expect(point?.kind).toBe('class');
    const rawBytes = bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0);
    expect(point?.rawSource).toBe(decodeUtf8(rawBytes));
    expect(point?.sourceHash).toBe(sha256Hex(rawBytes));
    expect(rawBytes.byteLength).toBeGreaterThan(decodeUtf8(rawBytes).length);
  });
});
