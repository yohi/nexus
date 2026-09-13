import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RustLanguagePlugin } from '../../../src/plugins/languages/rust.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'rust', name);

const parseRustFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new RustLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'rust', bytes, text });
  return { bytes, result, text };
};

describe('Rust structured parser', () => {
  it('extracts nested declarations and impl methods with stable symbolIds', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(byName.get('outer')?.kind).toBe('namespace');
    expect(byName.get('outer.Point')?.kind).toBe('struct');
    expect(byName.get('outer.Color')?.kind).toBe('enum');
    expect(byName.get('outer.Point.impl')?.kind).toBe('impl');
    expect(byName.get('outer.Point.new')?.kind).toBe('method');
    expect(byName.get('outer.Drawable')?.kind).toBe('trait');
    expect(byName.get('outer.Drawable.draw')?.kind).toBe('function');
    expect(byName.get('outer.nested')?.kind).toBe('namespace');
    expect(byName.get('outer.nested.Marker')?.kind).toBe('struct');
    expect(byName.get('top_level')?.kind).toBe('function');
    expect(byName.get('outer.Point.new')?.parentSymbolId).toBe(byName.get('outer.Point')?.symbolId);
    expect(byName.get('outer.Point')?.symbolId).toMatch(/^symbol_v1_/);

    const pointMethods = result.declarations.filter((d) => d.qualifiedName === 'outer.Point.new');
    expect(pointMethods).toHaveLength(2);
    expect(new Set(pointMethods.map((d) => d.symbolId)).size).toBe(2);
    expect(new Set(pointMethods.map((d) => d.parentSymbolId))).toEqual(new Set([byName.get('outer.Point')?.symbolId]));

    const pointImpls = result.declarations.filter((d) => d.qualifiedName === 'outer.Point.impl');
    expect(pointImpls).toHaveLength(2);
    expect(new Set(pointImpls.map((d) => d.symbolId)).size).toBe(2);
  });

  it('keeps repeated canonical names distinct', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const duplicates = result.declarations.filter((d) => d.qualifiedName === 'outer.Duplicate');
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((d) => d.symbolId)).size).toBe(2);
  });

  it('uses dot separator in qualifiedName', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const names = result.declarations.map((d) => d.qualifiedName);
    expect(names).toContain('outer.Point');
    expect(names).toContain('outer.Point.new');
    expect(names).toContain('outer.Drawable');
    expect(names).toContain('outer.nested.Marker');
  });

  it('extracts use imports and marks wildcard imports partial', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const fileImport = result.imports.find((i) => i.moduleSpecifier === 'std::fs::File');
    const wildcard = result.imports.find((i) => i.moduleSpecifier === 'std::io' && i.bindingName === undefined);

    expect(fileImport?.bindingName).toBe('File');
    expect(fileImport?.completeness).toBe('complete');
    expect(wildcard?.completeness).toBe('partial');
  });

  it('keeps valid declarations when a later declaration is malformed', async () => {
    const { result } = await parseRustFixture('partial.rs');

    expect(result.status).toBe('degraded');
    expect(result.retrievability).toBe('partial');
    expect(result.declarations.find((d) => d.qualifiedName === 'Good')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'Bad')).toBeUndefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'inside')).toBeUndefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'broken.inside')).toBeUndefined();
  });

  it('matches rawSource, byte offsets, and sourceHash to the original file', async () => {
    const { bytes, result, text } = await parseRustFixture('exactness.rs');
    const point = result.declarations.find((d) => d.qualifiedName === 'outer.Point');
    expect(point?.rawSource).toBe(decodeUtf8(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));
    expect(point?.sourceHash).toBe(sha256Hex(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));
    expect(point?.startByte).toBe(Buffer.byteLength(text.slice(0, text.indexOf('pub struct Point')), 'utf8'));
  });

  it('does not let a broken container affect owner resolution of valid siblings', async () => {
    const text = [
      'pub struct Point;',
      '',
      'impl Point {',
      '    pub fn valid() {}',
      '}',
      '',
      'impl Point {',
      '    pub struct Point;',
      '    pub fn broken( {}',
      '}',
      '',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const parser = await new RustLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({
      filePath: 'broken-container.rs',
      language: 'rust',
      bytes,
      text,
    });

    const point = result.declarations.find((d) => d.qualifiedName === 'Point');
    const validMethod = result.declarations.find((d) => d.qualifiedName === 'Point.valid');

    expect(validMethod?.kind).toBe('method');
    expect(validMethod?.parentSymbolId).toBe(point?.symbolId);
    expect(result.declarations.find((d) => d.qualifiedName === 'Point.broken')).toBeUndefined();
  });

  it('normalizes generic impl targets and resolves method parents', async () => {
    const text = [
      'pub struct Point<T> {',
      '    value: T,',
      '}',
      '',
      'impl<T> Point<T> {',
      '    pub fn local(&self) {}',
      '}',
      '',
      'mod outer {',
      '    pub struct Point<T> {',
      '        value: T,',
      '    }',
      '}',
      '',
      'impl<T> outer::Point<T> {',
      '    pub fn scoped(&self) {}',
      '}',
      '',
      'pub trait Drawable<T> {',
      '    fn draw(&self);',
      '}',
      '',
      'impl<T> Drawable<T> for Point<T> {',
      '    pub fn draw(&self) {}',
      '}',
      '',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const parser = await new RustLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({
      filePath: 'generic-impl.rs',
      language: 'rust',
      bytes,
      text,
    });

    const point = result.declarations.find((declaration) => declaration.qualifiedName === 'Point');
    const nestedPoint = result.declarations.find((declaration) => declaration.qualifiedName === 'outer.Point');
    const local = result.declarations.find((declaration) => declaration.qualifiedName === 'Point.local');
    const scoped = result.declarations.find((declaration) => declaration.qualifiedName === 'outer.Point.scoped');
    const traitImpl = result.declarations.find((declaration) => declaration.qualifiedName === 'Drawable.Point.impl');
    const traitMethod = result.declarations.find((declaration) => declaration.qualifiedName === 'Point.draw');

    expect(result.status).toBe('ok');
    expect(local?.parentSymbolId).toBe(point?.symbolId);
    expect(scoped?.parentSymbolId).toBe(nestedPoint?.symbolId);
    expect(traitImpl?.kind).toBe('impl');
    expect(traitMethod?.parentSymbolId).toBe(point?.symbolId);
  });

  it('extracts grouped, aliased, and nested use imports', async () => {
    const text = [
      'use std::collections::{HashMap, BTreeMap};',
      'use foo::bar as baz;',
      'mod nested {',
      '    use crate::{a, inner::{b, c as d}};',
      '    use std::io::*;',
      '}',
      '',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const parser = await new RustLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({
      filePath: 'grouped-imports.rs',
      language: 'rust',
      bytes,
      text,
    });

    const findImport = (moduleSpecifier: string, bindingName?: string) =>
      result.imports.find((item) => item.moduleSpecifier === moduleSpecifier && item.bindingName === bindingName);

    expect(findImport('std::collections::HashMap', 'HashMap')?.completeness).toBe('complete');
    expect(findImport('std::collections::BTreeMap', 'BTreeMap')?.completeness).toBe('complete');
    expect(findImport('foo::bar', 'baz')?.completeness).toBe('complete');
    expect(findImport('crate::a', 'a')?.completeness).toBe('complete');
    expect(findImport('crate::inner::b', 'b')?.completeness).toBe('complete');
    expect(findImport('crate::inner::c', 'd')?.completeness).toBe('complete');
    expect(findImport('std::io')?.completeness).toBe('partial');
  });
});
