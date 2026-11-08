import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NavigationToolArgs, VerifiedSymbolNavigationResult } from '../../../src/lsp/contracts.js';
import {
  createLspLineTable,
  InvalidNavigationArgumentsError,
  lspDocumentLanguageIdForPath,
  resolveNavigationTarget,
} from '../../../src/lsp/target-resolver.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import type { SymbolRetrievalService } from '../../../src/structured/retrieval-service.js';

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

const sha = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type SymbolsMock = SymbolRetrievalService & { resolveVerifiedNavigationTarget: ReturnType<typeof vi.fn> };

const symbolsReturning = (
  impl: (input: { symbolId: string; signal?: AbortSignal }) => VerifiedSymbolNavigationResult,
): SymbolsMock =>
  ({
    resolveVerifiedNavigationTarget: vi.fn((input: { symbolId: string; signal?: AbortSignal }) =>
      Promise.resolve().then(() => impl(input)),
    ),
  }) as unknown as SymbolsMock;

const unusedSymbols = (): SymbolsMock =>
  symbolsReturning(() => {
    throw new Error('symbol service must not be called');
  });

const okSymbol = (filePath: string, content: string, position = { line: 1, character: 16 }): VerifiedSymbolNavigationResult => ({
  status: 'ok',
  target: {
    symbolId: 'sym-1',
    filePath,
    languageId: 'typescript',
    position,
    fileSha256: sha(content),
    generationId: 'gen-1',
  },
});

const setup = async () => {
  const root = await makeDir('nexus-lsp-target-');
  const sanitizer = await PathSanitizer.create(root);
  return { root, sanitizer };
};

const failureShape = { capability: 'not_checked', locations: [], truncated: false, sourceValidation: 'unknown' };

describe('lspDocumentLanguageIdForPath', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/a.cts', 'typescript'],
    ['src/a.d.ts', 'typescript'],
    ['src/a.tsx', 'typescriptreact'],
    ['src/a.js', 'javascript'],
    ['src/a.mjs', 'javascript'],
    ['src/a.cjs', 'javascript'],
    ['src/a.jsx', 'javascriptreact'],
  ])('maps %s to %s', (filePath, expected) => {
    expect(lspDocumentLanguageIdForPath(filePath)).toBe(expected);
  });

  it.each(['src/a.TS', 'src/a.Tsx', 'src/a.json', 'src/a.py', 'src/Makefile', 'src/.ts', 'src.ts/readme', 'src/a.ts.bak'])(
    'returns null for %s (case-sensitive, exhaustive table)',
    (filePath) => {
      expect(lspDocumentLanguageIdForPath(filePath)).toBeNull();
    },
  );
});

describe('resolveNavigationTarget — argument shape', () => {
  it.each<[string, NavigationToolArgs]>([
    ['empty', {}],
    ['mixed symbolId and filePath', { symbolId: 'sym-1', filePath: 'src/a.ts', line: 1, character: 0 }],
    ['symbolId with line', { symbolId: 'sym-1', line: 1 }],
    ['partial file target (no character)', { filePath: 'src/a.ts', line: 1 }],
    ['partial file target (no line)', { filePath: 'src/a.ts', character: 0 }],
    ['position without file', { line: 1, character: 0 }],
    ['line zero', { filePath: 'src/a.ts', line: 0, character: 0 }],
    ['negative character', { filePath: 'src/a.ts', line: 1, character: -1 }],
    ['fractional line', { filePath: 'src/a.ts', line: 1.5, character: 0 }],
    ['empty symbolId', { symbolId: '' }],
    ['empty filePath', { filePath: '', line: 1, character: 0 }],
    ['absolute filePath', { filePath: '/etc/passwd.ts', line: 1, character: 0 }],
    ['file URI filePath', { filePath: 'file:///etc/a.ts', line: 1, character: 0 }],
    ['NUL in filePath', { filePath: 'src/a\u0000.ts', line: 1, character: 0 }],
    ['non-positive maxResults', { symbolId: 'sym-1', maxResults: 0 }],
    ['maxResults above hard maximum', { symbolId: 'sym-1', maxResults: 1001 }],
  ])('rejects %s before any resolution', async (_name, args) => {
    const { sanitizer } = await setup();
    const symbols = unusedSymbols();
    const isExcluded = vi.fn(() => false);
    await expect(resolveNavigationTarget({ args, symbols, sanitizer, isExcluded })).rejects.toBeInstanceOf(
      InvalidNavigationArgumentsError,
    );
    expect(symbols.resolveVerifiedNavigationTarget).not.toHaveBeenCalled();
    expect(isExcluded).not.toHaveBeenCalled();
  });

  it('does not reflect untrusted input in the invalid-argument message', async () => {
    const { sanitizer } = await setup();
    const error = await resolveNavigationTarget({
      args: { filePath: '/secret/host/path.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidNavigationArgumentsError);
    expect((error as Error).message).not.toContain('/secret/host');
    expect((error as InvalidNavigationArgumentsError).reasonCode).toBe('INVALID_NAVIGATION_TARGET');
  });
});

describe('resolveNavigationTarget — explicit file and position', () => {
  it('accepts a saved dirty file with no catalog entry without consulting the symbol service', async () => {
    const { root, sanitizer } = await setup();
    const content = 'export function foo() {}\n';
    const absolute = await write(root, 'src/dirty.ts', content);
    const symbols = unusedSymbols();

    const result = await resolveNavigationTarget({
      args: { filePath: 'src/dirty.ts', line: 1, character: 16 },
      symbols,
      sanitizer,
      isExcluded: () => false,
    });

    expect(result).toEqual({
      status: 'ok',
      target: {
        uri: pathToFileURL(absolute).href,
        filePath: 'src/dirty.ts',
        position: { line: 0, character: 16 },
        text: content,
        fileSha256: sha(content),
        languageId: 'typescript',
      },
    });
    expect(symbols.resolveVerifiedNavigationTarget).not.toHaveBeenCalled();
  });

  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/a.cts', 'typescript'],
    ['src/a.tsx', 'typescriptreact'],
    ['src/a.js', 'javascript'],
    ['src/a.mjs', 'javascript'],
    ['src/a.cjs', 'javascript'],
    ['src/a.jsx', 'javascriptreact'],
  ])('derives the LSP language for %s from its extension (%s)', async (filePath, languageId) => {
    const { root, sanitizer } = await setup();
    await write(root, filePath, 'x\n');
    const result = await resolveNavigationTarget({
      args: { filePath, line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toMatchObject({ status: 'ok', target: { languageId } });
  });

  it('returns unsupported for an unknown extension', async () => {
    const { root, sanitizer } = await setup();
    await write(root, 'src/a.py', 'x = 1\n');
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/a.py', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'unsupported', reasonCode: 'unsupported_language', ...failureShape });
  });

  it('refuses lexical path traversal as excluded', async () => {
    const { sanitizer } = await setup();
    const isExcluded = vi.fn(() => false);
    for (const filePath of ['../outside.ts', 'src/../../outside.ts']) {
      const result = await resolveNavigationTarget({
        args: { filePath, line: 1, character: 0 },
        symbols: unusedSymbols(),
        sanitizer,
        isExcluded,
      });
      expect(result).toEqual({ status: 'excluded', reasonCode: 'PATH_EXCLUDED', ...failureShape });
    }
    expect(isExcluded).not.toHaveBeenCalled();
  });

  it('refuses a symlink that escapes the project root', async () => {
    const { root, sanitizer } = await setup();
    const outside = await makeDir('nexus-lsp-outside-');
    const target = await write(outside, 'secret.ts', 'export const secret = 1;\n');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.symlink(target, path.join(root, 'src', 'link.ts'));

    const result = await resolveNavigationTarget({
      args: { filePath: 'src/link.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'excluded', reasonCode: 'PATH_EXCLUDED', ...failureShape });
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it('refuses a configured exclusion, including when reached through an in-project symlink', async () => {
    const { root, sanitizer } = await setup();
    await write(root, 'secrets/key.ts', 'export const key = 1;\n');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.symlink(path.join(root, 'secrets', 'key.ts'), path.join(root, 'src', 'alias.ts'));
    const isExcluded = (filePath: string) => filePath.startsWith('secrets/');

    for (const filePath of ['secrets/key.ts', 'src/alias.ts']) {
      const result = await resolveNavigationTarget({
        args: { filePath, line: 1, character: 0 },
        symbols: unusedSymbols(),
        sanitizer,
        isExcluded,
      });
      expect(result).toEqual({ status: 'excluded', reasonCode: 'PATH_EXCLUDED', ...failureShape });
    }
  });

  it('supports an async exclusion predicate', async () => {
    const { root, sanitizer } = await setup();
    await write(root, 'src/a.ts', 'x\n');
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/a.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => Promise.resolve(true),
    });
    expect(result).toMatchObject({ status: 'excluded', reasonCode: 'PATH_EXCLUDED' });
  });

  it('returns not_found for a missing file or a directory', async () => {
    const { root, sanitizer } = await setup();
    await fs.mkdir(path.join(root, 'src', 'dir.ts'), { recursive: true });
    for (const filePath of ['src/missing.ts', 'src/dir.ts']) {
      const result = await resolveNavigationTarget({
        args: { filePath, line: 1, character: 0 },
        symbols: unusedSymbols(),
        sanitizer,
        isExcluded: () => false,
      });
      expect(result).toEqual({ status: 'not_found', reasonCode: 'FILE_NOT_FOUND', ...failureShape });
    }
  });

  it('returns error for invalid UTF-8 source bytes', async () => {
    const { root, sanitizer } = await setup();
    await write(root, 'src/bad.ts', new Uint8Array([0x63, 0xff, 0xfe, 0x0a]));
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/bad.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'error', reasonCode: 'invalid_utf8', ...failureShape });
  });

  // TypeScript/tsserver treat U+2028/U+2029 as line breaks while LSP does not, so positions in
  // such files cannot be mapped reliably: fail closed instead of returning a wrong position.
  it.each([
    ['U+2028', '/* a\u2028b */\nconst y = 2;\nconst x = 1;\nconst z = 3;\n'],
    ['U+2029', '/* a\u2029b */\nconst y = 2;\nconst x = 1;\nconst z = 3;\n'],
  ])('returns unsupported/UNSUPPORTED_LINE_TERMINATOR for a file containing %s', async (_name, content) => {
    const { root, sanitizer } = await setup();
    await write(root, 'src/sep.ts', content);
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/sep.ts', line: 3, character: 6 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'unsupported', reasonCode: 'UNSUPPORTED_LINE_TERMINATOR', ...failureShape });
  });

  it('never returns an ok position for a verified symbolId whose file contains U+2028', async () => {
    const { root, sanitizer } = await setup();
    const content = '/* a\u2028b */\nconst y = 2;\nconst x = 1;\nconst z = 3;\n';
    await write(root, 'src/sep.ts', content);
    // TypeScript coordinates for `x` (1-based line 4) would name `z` in LSP coordinates.
    const symbols = symbolsReturning(() => okSymbol('src/sep.ts', content, { line: 4, character: 6 }));
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols,
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'unsupported', reasonCode: 'UNSUPPORTED_LINE_TERMINATOR', ...failureShape });
  });

  describe('position bounds', () => {
    const resolveAt = async (content: string, line: number, character: number) => {
      const { root, sanitizer } = await setup();
      await write(root, 'src/p.ts', content);
      return resolveNavigationTarget({
        args: { filePath: 'src/p.ts', line, character },
        symbols: unusedSymbols(),
        sanitizer,
        isExcluded: () => false,
      });
    };

    it('accepts character 0 and the end-of-line position', async () => {
      await expect(resolveAt('abc\n', 1, 0)).resolves.toMatchObject({
        status: 'ok',
        target: { position: { line: 0, character: 0 } },
      });
      await expect(resolveAt('abc\n', 1, 3)).resolves.toMatchObject({ status: 'ok' });
    });

    it('accepts the empty trailing line and an empty file', async () => {
      await expect(resolveAt('abc\n', 2, 0)).resolves.toMatchObject({
        status: 'ok',
        target: { position: { line: 1, character: 0 } },
      });
      await expect(resolveAt('', 1, 0)).resolves.toMatchObject({ status: 'ok' });
    });

    it('rejects out-of-bounds lines and characters', async () => {
      const outOfRange = { status: 'not_found', reasonCode: 'POSITION_OUT_OF_RANGE', ...failureShape };
      await expect(resolveAt('abc\n', 3, 0)).resolves.toEqual(outOfRange);
      await expect(resolveAt('abc\n', 1, 4)).resolves.toEqual(outOfRange);
      await expect(resolveAt('', 1, 1)).resolves.toEqual(outOfRange);
    });

    it('treats CRLF and lone CR as single line breaks excluded from the line length', async () => {
      await expect(resolveAt('ab\r\ncd', 1, 2)).resolves.toMatchObject({ status: 'ok' });
      await expect(resolveAt('ab\r\ncd', 1, 3)).resolves.toMatchObject({ reasonCode: 'POSITION_OUT_OF_RANGE' });
      await expect(resolveAt('ab\r\ncd', 2, 2)).resolves.toMatchObject({
        status: 'ok',
        target: { position: { line: 1, character: 2 } },
      });
      await expect(resolveAt('ab\r\ncd', 3, 0)).resolves.toMatchObject({ reasonCode: 'POSITION_OUT_OF_RANGE' });
      await expect(resolveAt('ab\rcd ef', 2, 4)).resolves.toMatchObject({ status: 'ok' });
      await expect(resolveAt('ab\rcd ef', 3, 0)).resolves.toMatchObject({ reasonCode: 'POSITION_OUT_OF_RANGE' });
    });

    it('splits LSP lines only on \\n, \\r\\n and \\r (U+2028/U+2029 are not LSP terminators)', () => {
      expect(createLspLineTable('ab\rcd\u2028ef\u2029g')).toEqual({ starts: [0, 3], lengths: [2, 7] });
    });

    it('counts non-BMP characters as two UTF-16 code units and refuses splitting a surrogate pair', async () => {
      const content = "const s = '😀'; const t = 1;\n";
      const tIndex = content.indexOf('t =');
      await expect(resolveAt(content, 1, tIndex)).resolves.toMatchObject({
        status: 'ok',
        target: { position: { line: 0, character: tIndex } },
      });
      const emojiIndex = content.indexOf('😀');
      await expect(resolveAt(content, 1, emojiIndex + 1)).resolves.toEqual({
        status: 'not_found',
        reasonCode: 'POSITION_INSIDE_SURROGATE_PAIR',
        ...failureShape,
      });
      await expect(resolveAt(content, 1, emojiIndex + 2)).resolves.toMatchObject({ status: 'ok' });
    });
  });

  it('fails closed when the target is deleted during the request', async () => {
    const { root, sanitizer } = await setup();
    const absolute = await write(root, 'src/gone.ts', 'x\n');
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/gone.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: async () => {
        await fs.rm(absolute);
        return false;
      },
    });
    expect(result).toEqual({ status: 'not_found', reasonCode: 'FILE_NOT_FOUND', ...failureShape });
  });

  it('fails closed when the target is replaced by an escaping symlink during the request', async () => {
    const { root, sanitizer } = await setup();
    const outside = await makeDir('nexus-lsp-outside-');
    const secret = await write(outside, 'secret.ts', 'export const secret = 1;\n');
    const absolute = await write(root, 'src/swap.ts', 'x\n');
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/swap.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: async () => {
        await fs.rm(absolute);
        await fs.symlink(secret, absolute);
        return false;
      },
    });
    expect(result.status).not.toBe('ok');
    expect(['stale', 'excluded']).toContain(result.status);
    expect(JSON.stringify(result)).not.toContain('secret = 1');
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const { root, sanitizer } = await setup();
    await write(root, 'src/a.ts', 'x\n');
    const controller = new AbortController();
    controller.abort();
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/a.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => false,
      signal: controller.signal,
    });
    expect(result).toEqual({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED', ...failureShape });
  });

  it('maps an exclusion predicate failure to a sanitized error', async () => {
    const { root, sanitizer } = await setup();
    await write(root, 'src/a.ts', 'x\n');
    const result = await resolveNavigationTarget({
      args: { filePath: 'src/a.ts', line: 1, character: 0 },
      symbols: unusedSymbols(),
      sanitizer,
      isExcluded: () => {
        throw new Error(`boom at ${root}`);
      },
    });
    expect(result).toMatchObject({ status: 'error', ...failureShape });
    expect(JSON.stringify(result)).not.toContain(root);
  });
});

describe('resolveNavigationTarget — verified symbolId', () => {
  it('converts the verified 1-based position to LSP zero-based and keeps the extension-derived language', async () => {
    const { root, sanitizer } = await setup();
    const content = '\nexport function foo() {}\n';
    const absolute = await write(root, 'src/view.tsx', content);
    const symbols = symbolsReturning(() => okSymbol('src/view.tsx', content, { line: 2, character: 16 }));

    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols,
      sanitizer,
      isExcluded: () => false,
    });

    expect(result).toEqual({
      status: 'ok',
      target: {
        uri: pathToFileURL(absolute).href,
        filePath: 'src/view.tsx',
        position: { line: 1, character: 16 },
        text: content,
        fileSha256: sha(content),
        // Catalog says 'typescript'; the LSP document ID derives only from `.tsx`.
        languageId: 'typescriptreact',
      },
    });
    expect(symbols.resolveVerifiedNavigationTarget).toHaveBeenCalledWith({ symbolId: 'sym-1', signal: undefined });
  });

  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/a.cts', 'typescript'],
    ['src/a.tsx', 'typescriptreact'],
    ['src/a.js', 'javascript'],
    ['src/a.mjs', 'javascript'],
    ['src/a.cjs', 'javascript'],
    ['src/a.jsx', 'javascriptreact'],
  ])('uses the same extension mapping for symbolId targets in %s (%s)', async (filePath, languageId) => {
    const { root, sanitizer } = await setup();
    const content = 'export function foo() {}\n';
    await write(root, filePath, content);
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => okSymbol(filePath, content)),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toMatchObject({ status: 'ok', target: { languageId } });
  });

  it('returns unsupported for a symbolId whose file has an unknown extension', async () => {
    const { root, sanitizer } = await setup();
    const content = 'export function foo() {}\n';
    await write(root, 'src/a.vue', content);
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => okSymbol('src/a.vue', content)),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'unsupported', reasonCode: 'unsupported_language', ...failureShape });
  });

  it('passes non-ok verification outcomes through fail-closed with not_checked capability', async () => {
    const { sanitizer } = await setup();
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => ({ status: 'stale_identity', reasonCode: 'SYMBOL_RETIRED', reindexRequired: false })),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({
      status: 'stale_identity',
      reasonCode: 'SYMBOL_RETIRED',
      reindexRequired: false,
      ...failureShape,
    });
  });

  it('returns stale when the verified file changed before the current-source check', async () => {
    const { root, sanitizer } = await setup();
    const verifiedContent = 'export function foo() {}\n';
    await write(root, 'src/a.ts', 'export function foo() { changed(); }\n');
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => okSymbol('src/a.ts', verifiedContent)),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({
      status: 'stale',
      reasonCode: 'INDEX_FILE_HASH_MISMATCH',
      reindexRequired: true,
      ...failureShape,
    });
  });

  it('returns stale when the verified file was deleted before the current-source check', async () => {
    const { sanitizer } = await setup();
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => okSymbol('src/deleted.ts', 'x\n')),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({
      status: 'stale',
      reasonCode: 'INDEX_FILE_MISSING',
      reindexRequired: true,
      ...failureShape,
    });
  });

  it('applies exclusions to the verified file as well', async () => {
    const { root, sanitizer } = await setup();
    const content = 'export function foo() {}\n';
    await write(root, 'src/a.ts', content);
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => okSymbol('src/a.ts', content)),
      sanitizer,
      isExcluded: () => true,
    });
    expect(result).toMatchObject({ status: 'excluded', reasonCode: 'PATH_EXCLUDED' });
  });

  it('treats an out-of-bounds verified position over unchanged bytes as an invariant violation', async () => {
    const { root, sanitizer } = await setup();
    const content = 'x\n';
    await write(root, 'src/a.ts', content);
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => okSymbol('src/a.ts', content, { line: 9, character: 0 })),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'error', reasonCode: 'INVARIANT_VIOLATION', ...failureShape });
  });

  it('maps non-cancel I/O errors thrown by verification to a sanitized error', async () => {
    const { root, sanitizer } = await setup();
    for (const code of ['EACCES', 'ELOOP']) {
      const error = Object.assign(new Error(`${code}: permission denied, open '${root}/src/a.ts'`), { code });
      const result = await resolveNavigationTarget({
        args: { symbolId: 'sym-1' },
        symbols: symbolsReturning(() => {
          throw error;
        }),
        sanitizer,
        isExcluded: () => false,
      });
      expect(result).toEqual({ status: 'error', reasonCode: 'FILE_READ_ERROR', ...failureShape });
      expect(JSON.stringify(result)).not.toContain(root);
    }
  });

  it('maps an AbortError thrown during verification to cancelled', async () => {
    const { sanitizer } = await setup();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const result = await resolveNavigationTarget({
      args: { symbolId: 'sym-1' },
      symbols: symbolsReturning(() => {
        throw abortError;
      }),
      sanitizer,
      isExcluded: () => false,
    });
    expect(result).toEqual({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED', ...failureShape });
  });
});
