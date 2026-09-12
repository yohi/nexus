import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLanguagePlugin } from '../../../src/plugins/languages/c.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseCFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'c', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new CLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'c', bytes, text });
  return { bytes, result };
};

describe('C structured parser', () => {
  it('extracts function, struct, enum, and include imports', async () => {
    const { result } = await parseCFixture('exactness.c');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));

    expect(result.status).toBe('ok');
    expect(byName.get('Point')?.kind).toBe('struct');
    expect(byName.get('Color')?.kind).toBe('enum');
    expect(byName.get('top_level')?.kind).toBe('function');

    const stdio = result.imports.find((i) => i.moduleSpecifier === 'stdio.h');
    const local = result.imports.find((i) => i.moduleSpecifier === 'local.h');
    expect(stdio).toBeDefined();
    expect(local).toBeDefined();
    expect(stdio?.completeness).toBe('complete');
  });

  it('keeps exact byte ranges and skips malformed declarations without flattening', async () => {
    const { bytes, result } = await parseCFixture('partial.c');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));
    expect(result.status).toBe('degraded');
    expect(byName.get('good')?.kind).toBe('function');
    expect(byName.has('bad')).toBe(false);
    const good = byName.get('good');
    expect(good?.rawSource).toBe(decodeUtf8(bytes.subarray(good?.startByte ?? 0, good?.endByte ?? 0)));
    expect(good?.sourceHash).toBe(sha256Hex(bytes.subarray(good?.startByte ?? 0, good?.endByte ?? 0)));
  });
});
