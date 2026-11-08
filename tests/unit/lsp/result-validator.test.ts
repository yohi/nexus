import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import type { Location, LocationLink, Range } from 'vscode-languageserver-protocol';

import { validateNavigationResults } from '../../../src/lsp/result-validator.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';

const tempDirs: string[] = [];

const makeDir = async (prefix: string): Promise<string> => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const write = async (root: string, relativePath: string, content: string | Uint8Array): Promise<string> => {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return absolute;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const range = (sl: number, sc: number, el: number, ec: number): Range => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const A_TEXT = 'export const alpha = 1;\nexport const beta = 2;\n';
const B_TEXT = "const s = '😀';\r\nconst t = 1;\r\n";

const setup = async () => {
  const root = await makeDir('nexus-lsp-results-');
  const sanitizer = await PathSanitizer.create(root);
  const a = await write(root, 'src/a.ts', A_TEXT);
  const b = await write(root, 'src/b.ts', B_TEXT);
  const uri = (relativePath: string) => pathToFileURL(path.join(root, relativePath)).href;
  return { root, sanitizer, a, b, uri };
};

type Raw = Parameters<typeof validateNavigationResults>[0]['raw'];

const validate = async (
  ctx: Awaited<ReturnType<typeof setup>>,
  raw: unknown,
  options: { maxResults?: number; isExcluded?: (p: string) => boolean | Promise<boolean>; signal?: AbortSignal } = {},
) =>
  validateNavigationResults({
    raw: raw as Raw,
    sanitizer: ctx.sanitizer,
    isExcluded: options.isExcluded ?? (() => false),
    maxResults: options.maxResults ?? 100,
    signal: options.signal,
  });

describe('validateNavigationResults', () => {
  it('treats null as a verified empty result', async () => {
    const ctx = await setup();
    await expect(validate(ctx, null)).resolves.toEqual({
      locations: [],
      truncated: false,
      sourceValidation: 'verified',
      excludedResultCount: 0,
    });
  });

  it('normalizes Location results to project-relative 1-based lines', async () => {
    const ctx = await setup();
    const raw: Location[] = [{ uri: ctx.uri('src/a.ts'), range: range(1, 13, 1, 17) }];
    await expect(validate(ctx, raw)).resolves.toEqual({
      locations: [{ filePath: 'src/a.ts', startLine: 2, startCharacter: 13, endLine: 2, endCharacter: 17 }],
      truncated: false,
      sourceValidation: 'verified',
      excludedResultCount: 0,
    });
  });

  it('accepts a single Location object (non-array definition reply)', async () => {
    const ctx = await setup();
    const raw: Location = { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) };
    await expect(validate(ctx, raw)).resolves.toMatchObject({
      locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 18 }],
      sourceValidation: 'verified',
    });
  });

  it('normalizes LocationLink.targetSelectionRange only when contained in targetRange', async () => {
    const ctx = await setup();
    const contained: LocationLink = {
      targetUri: ctx.uri('src/a.ts'),
      targetRange: range(0, 0, 0, 23),
      targetSelectionRange: range(0, 13, 0, 18),
    };
    const escaping: LocationLink = {
      targetUri: ctx.uri('src/a.ts'),
      targetRange: range(1, 0, 1, 10),
      targetSelectionRange: range(1, 13, 1, 17),
    };
    await expect(validate(ctx, [contained, escaping])).resolves.toEqual({
      locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 18 }],
      truncated: false,
      sourceValidation: 'partial',
      excludedResultCount: 1,
    });
  });

  it('omits a LocationLink whose targetRange itself is out of bounds', async () => {
    const ctx = await setup();
    const link: LocationLink = {
      targetUri: ctx.uri('src/a.ts'),
      targetRange: range(0, 0, 50, 0),
      targetSelectionRange: range(0, 13, 0, 18),
    };
    await expect(validate(ctx, [link])).resolves.toMatchObject({
      locations: [],
      sourceValidation: 'partial',
      excludedResultCount: 1,
    });
  });

  it('validates ranges against CRLF line breaks and surrogate pairs in current source', async () => {
    const ctx = await setup();
    const emoji = B_TEXT.indexOf('😀');
    const valid: Location[] = [
      { uri: ctx.uri('src/b.ts'), range: range(0, emoji, 0, emoji + 2) },
      { uri: ctx.uri('src/b.ts'), range: range(1, 6, 1, 7) },
      { uri: ctx.uri('src/b.ts'), range: range(2, 0, 2, 0) },
    ];
    const invalid: Location[] = [
      // splits the surrogate pair
      { uri: ctx.uri('src/b.ts'), range: range(0, emoji, 0, emoji + 1) },
      // includes the CR of a CRLF break
      { uri: ctx.uri('src/b.ts'), range: range(1, 0, 1, 13) },
      // beyond the last line
      { uri: ctx.uri('src/b.ts'), range: range(3, 0, 3, 0) },
    ];
    const result = await validate(ctx, [...valid, ...invalid]);
    expect(result).toEqual({
      locations: [
        { filePath: 'src/b.ts', startLine: 1, startCharacter: emoji, endLine: 1, endCharacter: emoji + 2 },
        { filePath: 'src/b.ts', startLine: 2, startCharacter: 6, endLine: 2, endCharacter: 7 },
        { filePath: 'src/b.ts', startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 0 },
      ],
      truncated: false,
      sourceValidation: 'partial',
      excludedResultCount: 3,
    });
  });

  // Well-shaped but semantically unusable ranges are omitted (partial), not protocol errors.
  it.each<[string, Range]>([
    ['start after end (inverted)', range(0, 10, 0, 5)],
    ['start line after end line (inverted)', range(1, 0, 0, 3)],
    ['character beyond line length', range(0, 0, 0, 24)],
    ['line beyond end of file', range(9, 0, 9, 0)],
  ])('omits a well-shaped but unusable range: %s', async (_name, unusableRange) => {
    const ctx = await setup();
    const result = await validate(ctx, [
      { uri: ctx.uri('src/a.ts'), range: unusableRange },
      { uri: ctx.uri('src/a.ts'), range: range(0, 0, 0, 1) },
    ]);
    expect(result).toEqual({
      locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 }],
      truncated: false,
      sourceValidation: 'partial',
      excludedResultCount: 1,
    });
  });

  it('omits an inverted LocationLink targetRange as partial', async () => {
    const ctx = await setup();
    const link = {
      targetUri: ctx.uri('src/a.ts'),
      targetRange: range(0, 20, 0, 0),
      targetSelectionRange: range(0, 13, 0, 18),
    };
    await expect(validate(ctx, [link])).resolves.toMatchObject({
      locations: [],
      sourceValidation: 'partial',
      excludedResultCount: 1,
    });
  });

  describe('shape-invalid entries reject the whole reply as LSP_PROTOCOL_ERROR', () => {
    const okRange = range(0, 0, 0, 1);
    const cases: [string, (uri: (p: string) => string) => unknown][] = [
      ['non-record entry (number)', () => 42],
      ['non-record entry (null)', () => null],
      ['non-record entry (string)', (uri) => uri('src/a.ts')],
      ['record that is neither Location nor LocationLink', () => ({ foo: 1 })],
      ['Location missing range', (uri) => ({ uri: uri('src/a.ts') })],
      ['Location with non-object range', (uri) => ({ uri: uri('src/a.ts'), range: 'x' })],
      ['Location range missing end', (uri) => ({ uri: uri('src/a.ts'), range: { start: { line: 0, character: 0 } } })],
      [
        'Location position missing character',
        (uri) => ({ uri: uri('src/a.ts'), range: { start: { line: 0 }, end: { line: 0, character: 1 } } }),
      ],
      [
        'Location position with string line',
        (uri) => ({ uri: uri('src/a.ts'), range: { start: { line: '0', character: 0 }, end: { line: 0, character: 1 } } }),
      ],
      ['Location negative line', (uri) => ({ uri: uri('src/a.ts'), range: range(-1, 0, 0, 3) })],
      ['Location negative character', (uri) => ({ uri: uri('src/a.ts'), range: range(0, -1, 0, 3) })],
      ['Location fractional character', (uri) => ({ uri: uri('src/a.ts'), range: range(0, 1.5, 0, 3) })],
      ['Location non-string uri', () => ({ uri: 42, range: okRange })],
      ['LocationLink non-string targetUri', () => ({ targetUri: null, targetRange: okRange, targetSelectionRange: okRange })],
      [
        'LocationLink missing targetRange',
        (uri) => ({ targetUri: uri('src/a.ts'), targetSelectionRange: okRange }),
      ],
      [
        'LocationLink malformed targetRange',
        (uri) => ({ targetUri: uri('src/a.ts'), targetRange: { start: {}, end: {} }, targetSelectionRange: okRange }),
      ],
      [
        'LocationLink missing targetSelectionRange',
        (uri) => ({ targetUri: uri('src/a.ts'), targetRange: okRange }),
      ],
    ];

    it.each(cases)('%s', async (_name, makeEntry) => {
      const ctx = await setup();
      const valid = { uri: ctx.uri('src/a.ts'), range: okRange };
      // A malformed entry anywhere in the array rejects the reply, even next to valid ones.
      await expect(validate(ctx, [valid, makeEntry(ctx.uri)])).resolves.toEqual({
        status: 'error',
        reasonCode: 'LSP_PROTOCOL_ERROR',
      });
    });

    it.each(cases.filter(([, makeEntry]) => {
      const entry = makeEntry((p) => p);
      return typeof entry === 'object' && entry !== null;
    }))('%s as a single non-array reply', async (_name, makeEntry) => {
      const ctx = await setup();
      await expect(validate(ctx, makeEntry(ctx.uri))).resolves.toEqual({
        status: 'error',
        reasonCode: 'LSP_PROTOCOL_ERROR',
      });
    });
  });

  it('validates symlink aliases of one file against a single canonical source read', async () => {
    const ctx = await setup();
    await fs.symlink(path.join(ctx.root, 'src', 'a.ts'), path.join(ctx.root, 'src', 'alias.ts'));
    const seen: string[] = [];
    const result = await validate(
      ctx,
      [
        { uri: ctx.uri('src/alias.ts'), range: range(0, 13, 0, 18) },
        { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) },
      ],
      {
        isExcluded: (p) => {
          seen.push(p);
          return false;
        },
      },
    );
    expect(result).toEqual({
      locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 18 }],
      truncated: false,
      sourceValidation: 'verified',
      excludedResultCount: 0,
    });
    // The alias is exclusion-checked itself; the canonical file is checked (and read) once.
    expect(seen.filter((p) => p === 'src/a.ts')).toHaveLength(1);
    expect(seen).toContain('src/alias.ts');
  });

  it('omits invalid, non-file, escaping, excluded and missing URIs', async () => {
    const ctx = await setup();
    const outside = await makeDir('nexus-lsp-results-outside-');
    const outsideFile = await write(outside, 'x.ts', 'export const x = 1;\n');
    await fs.symlink(outsideFile, path.join(ctx.root, 'src', 'link.ts'));
    await write(ctx.root, 'secrets/key.ts', 'export const key = 1;\n');
    const r = range(0, 0, 0, 1);
    const raw = [
      { uri: 'not a uri', range: r },
      { uri: 'https://example.com/src/a.ts', range: r },
      { uri: `${ctx.uri('src/a.ts')}?q=1`, range: r },
      { uri: `${ctx.uri('src/a.ts')}#frag`, range: r },
      { uri: 'file://remote-host/src/a.ts', range: r },
      { uri: 'src/a.ts', range: r },
      { uri: pathToFileURL(outsideFile).href, range: r },
      { uri: ctx.uri('src/link.ts'), range: r },
      { uri: ctx.uri('secrets/key.ts'), range: r },
      { uri: ctx.uri('src/missing.ts'), range: r },
      { uri: pathToFileURL(ctx.root).href, range: r },
      { uri: ctx.uri('src/a.ts'), range: r },
    ];
    const result = await validate(ctx, raw, { isExcluded: (p) => p.startsWith('secrets/') });
    expect(result).toEqual({
      locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 1 }],
      truncated: false,
      sourceValidation: 'partial',
      excludedResultCount: raw.length - 1,
    });
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it('applies exclusions to the canonical target of an in-project symlink', async () => {
    const ctx = await setup();
    await write(ctx.root, 'secrets/key.ts', 'export const key = 1;\n');
    await fs.symlink(path.join(ctx.root, 'secrets', 'key.ts'), path.join(ctx.root, 'src', 'alias.ts'));
    const result = await validate(ctx, [{ uri: ctx.uri('src/alias.ts'), range: range(0, 0, 0, 1) }], {
      isExcluded: (p) => Promise.resolve(p.startsWith('secrets/')),
    });
    expect(result).toMatchObject({ locations: [], sourceValidation: 'partial', excludedResultCount: 1 });
  });

  it('omits locations in files with invalid UTF-8', async () => {
    const ctx = await setup();
    await write(ctx.root, 'src/bad.ts', new Uint8Array([0x61, 0xff, 0x0a]));
    const result = await validate(ctx, [{ uri: ctx.uri('src/bad.ts'), range: range(0, 0, 0, 1) }]);
    expect(result).toMatchObject({ locations: [], sourceValidation: 'partial', excludedResultCount: 1 });
  });

  it('deduplicates and sorts deterministically regardless of input order or result shape', async () => {
    const ctx = await setup();
    const entries: (Location | LocationLink)[] = [
      { uri: ctx.uri('src/b.ts'), range: range(1, 6, 1, 7) },
      { uri: ctx.uri('src/a.ts'), range: range(1, 13, 1, 17) },
      { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) },
      { targetUri: ctx.uri('src/a.ts'), targetRange: range(0, 0, 0, 23), targetSelectionRange: range(0, 13, 0, 18) },
      { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) },
      { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 14) },
    ];
    const expected = [
      { filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 14 },
      { filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 18 },
      { filePath: 'src/a.ts', startLine: 2, startCharacter: 13, endLine: 2, endCharacter: 17 },
      { filePath: 'src/b.ts', startLine: 2, startCharacter: 6, endLine: 2, endCharacter: 7 },
    ];
    const forward = await validate(ctx, entries);
    const reversed = await validate(ctx, [...entries].reverse());
    expect(forward).toEqual({ locations: expected, truncated: false, sourceValidation: 'verified', excludedResultCount: 0 });
    expect(reversed).toEqual(forward);
  });

  it('caps results after dedupe/sort and reports truncation explicitly', async () => {
    const ctx = await setup();
    const raw: Location[] = [
      { uri: ctx.uri('src/b.ts'), range: range(1, 6, 1, 7) },
      { uri: ctx.uri('src/a.ts'), range: range(1, 13, 1, 17) },
      { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) },
      { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) },
    ];
    await expect(validate(ctx, raw, { maxResults: 2 })).resolves.toEqual({
      locations: [
        { filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 18 },
        { filePath: 'src/a.ts', startLine: 2, startCharacter: 13, endLine: 2, endCharacter: 17 },
      ],
      truncated: true,
      sourceValidation: 'verified',
      excludedResultCount: 0,
    });
    await expect(validate(ctx, raw, { maxResults: 3 })).resolves.toMatchObject({ truncated: false });
  });

  it('combines capped and omitted results with partial metadata', async () => {
    const ctx = await setup();
    const raw = [
      { uri: ctx.uri('src/b.ts'), range: range(1, 6, 1, 7) },
      { uri: ctx.uri('src/a.ts'), range: range(1, 13, 1, 17) },
      { uri: ctx.uri('src/a.ts'), range: range(0, 13, 0, 18) },
      { uri: 'https://example.com/x.ts', range: range(0, 0, 0, 1) },
    ];
    await expect(validate(ctx, raw, { maxResults: 1 })).resolves.toEqual({
      locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 13, endLine: 1, endCharacter: 18 }],
      truncated: true,
      sourceValidation: 'partial',
      excludedResultCount: 1,
    });
  });

  it('returns a protocol error for a non-array, non-location reply', async () => {
    const ctx = await setup();
    await expect(validate(ctx, 'garbage')).resolves.toEqual({ status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' });
    await expect(validate(ctx, { foo: 1 })).resolves.toEqual({ status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' });
  });

  it('returns an error for an invalid internal maxResults bound', async () => {
    const ctx = await setup();
    await expect(validate(ctx, null, { maxResults: 0 })).resolves.toEqual({
      status: 'error',
      reasonCode: 'INVARIANT_VIOLATION',
    });
  });

  it('returns cancelled when the signal is aborted', async () => {
    const ctx = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      validate(ctx, [{ uri: ctx.uri('src/a.ts'), range: range(0, 0, 0, 1) }], { signal: controller.signal }),
    ).resolves.toEqual({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' });
  });

  it('returns cancelled when the signal aborts during validation', async () => {
    const ctx = await setup();
    const controller = new AbortController();
    const result = await validate(
      ctx,
      [
        { uri: ctx.uri('src/a.ts'), range: range(0, 0, 0, 1) },
        { uri: ctx.uri('src/b.ts'), range: range(0, 0, 0, 1) },
      ],
      {
        signal: controller.signal,
        isExcluded: () => {
          controller.abort();
          return false;
        },
      },
    );
    expect(result).toEqual({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' });
  });
});
