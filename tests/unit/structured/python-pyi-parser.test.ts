import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
import { decodeUtf8 } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'python', name);

const parsePyiFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new PythonLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'python', bytes, text });
  return { bytes, result, text };
};

describe('Python stub structured parser', () => {
  it('parses .pyi with class, method, and function declarations', async () => {
    const { result } = await parsePyiFixture('exactness.pyi');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));
    expect(byName.get('Drawable')?.kind).toBe('class');
    expect(byName.get('Drawable.draw')?.kind).toBe('method');
    expect(byName.get('render')?.kind).toBe('function');
  });

  it('keeps valid declarations when a later declaration is malformed', async () => {
    const { result } = await parsePyiFixture('partial.pyi');
    expect(result.status).toBe('degraded');
    expect(result.declarations.find((d) => d.qualifiedName === 'good')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'bad')).toBeUndefined();
  });
});
