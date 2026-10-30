import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { FileToChunk, LanguagePlugin } from '../../../src/types/index.js';
import { Chunker } from '../../../src/indexer/chunker.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import type { StructuredDeclaration } from '../../../src/structured/contracts.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

describe('Chunker', () => {
  it('chunkFiles_no_plugin_reports_no_plugin_fallback', async () => {
    const chunker = new Chunker(new PluginRegistry());
    const reasons: string[] = [];
    const chunks = await chunker.chunkFiles([{
      filePath: 'unsupported.txt', language: 'text', content: 'plain text',
    }], (reason) => { reasons.push(reason); });
    expect(reasons).toEqual(['no_plugin']);
    expect(chunks).toHaveLength(1);
  });

  it('chunkFiles_empty_parse_reports_empty_parse_fallback', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage({
      languageId: 'empty', fileExtensions: ['.empty'], supports: (filePath: string) => filePath.endsWith('.empty'),
      createParser: async () => ({ parse: async () => ({ rootType: 'program', declarations: [] }) }),
    } satisfies LanguagePlugin);
    const reasons: string[] = [];
    const chunks = await new Chunker(registry).chunkFiles([
      { filePath: 'empty.empty', language: 'empty', content: 'plain text' },
    ], (reason) => { reasons.push(reason); });
    expect(reasons).toEqual(['empty_parse']);
    expect(chunks).toHaveLength(1);
  });

  it('chunkFiles_parse_exception_reports_parser_error_fallback_and_returns_fixed_chunks', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage({
      languageId: 'broken', fileExtensions: ['.broken'], supports: (filePath: string) => filePath.endsWith('.broken'),
      createParser: async () => ({ parse: async () => { throw new Error('private parser detail'); } }),
    } satisfies LanguagePlugin);
    const reasons: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const chunks = await new Chunker(registry).chunkFiles([
        { filePath: 'private.broken', language: 'broken', content: 'fallback content' },
      ], (reason) => { reasons.push(reason); });
      expect(reasons).toEqual(['parser_error']);
      expect(chunks).toHaveLength(1);
      expect(JSON.stringify(reasons)).not.toContain('private.broken');
    } finally {
      warn.mockRestore();
    }
  });

  it('creates chunks for imports, interfaces, functions, classes, and methods', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());

    const chunker = new Chunker(registry);
    const content = await readFile(fixturePath, 'utf8');
    const chunks = await chunker.chunkFiles([
      {
        filePath: fixturePath,
        language: 'typescript',
        content,
      },
    ]);

    expect(chunks.map((chunk) => [chunk.symbolKind, chunk.symbolName])).toEqual([
      ['import', 'imports'],
      ['interface', 'SessionRecord'],
      ['function', 'authenticate'],
      ['class', 'AuthService'],
      ['constructor', 'constructor'],
      ['method', 'getIssuer'],
      ['method', 'revoke'],
    ]);

    expect(chunks[2]?.content).toMatch(/\bauthenticate\b/);
  });

  it('falls back to fixed-line chunking for unsupported languages', async () => {
    const chunker = new Chunker(new PluginRegistry());
    const lines = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`).join('\n');
    const chunks = await chunker.chunkFiles([
      {
        filePath: 'notes.txt',
        language: 'text',
        content: lines,
      },
    ]);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[1]?.startLine).toBe(41);
    expect(chunks[2]?.startLine).toBe(81);
  });

  it('falls back to fixed-line chunking when parser throws', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage({
      languageId: 'broken',
      fileExtensions: ['.broken'],
      supports: (filePath: string) => filePath.endsWith('.broken'),
      createParser: async () => {
        throw new Error('parser initialization failed');
      },
    } satisfies LanguagePlugin);

    const chunker = new Chunker(registry);
    const chunks = await chunker.chunkFiles([
      {
        filePath: 'fixture.broken',
        language: 'broken',
        content: Array.from({ length: 55 }, (_, index) => `broken-${index}`).join('\n'),
      },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.symbolKind === 'file')).toBe(true);
  });

  it('yields to the event loop while extracting many nodes', async () => {
    const chunker = new Chunker(new PluginRegistry());
    const file: FileToChunk = {
      filePath: 'large.ts',
      language: 'typescript',
      content: 'export const noop = true;',
    };
    const yieldMarkers: string[] = [];

    await chunker.extractChunksWithYield(
      {
        rootType: 'program',
        declarations: Array.from({ length: 120 }, (_, index) => ({
          type: 'function',
          name: `fn${index}`,
          startLine: index + 1,
          endLine: index + 1,
          content: `export function fn${index}() { return ${index}; }`,
        })),
      },
      file,
      async () => {
        yieldMarkers.push('yield');
      },
    );

    expect(yieldMarkers.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty array for an empty file', async () => {
    const chunker = new Chunker(new PluginRegistry());
    const chunks = await chunker.chunkFiles([
      {
        filePath: 'empty.txt',
        language: 'text',
        content: '',
      },
    ]);

    expect(chunks).toHaveLength(0);
  });

  it('uses each declaration byte range when rawSource is omitted', async () => {
    const firstSource = 'export function first() {}\n';
    const secondSource = 'export function second() {}';
    const content = `${firstSource}${secondSource}`;
    const bytes = Buffer.from(content, 'utf8');
    const firstEndByte = Buffer.byteLength(firstSource, 'utf8');
    const declarations: StructuredDeclaration[] = [
      {
        name: 'first',
        symbolId: 'symbol-first',
        qualifiedName: 'first',
        kind: 'function',
        signatureDiscriminator: 'first()',
        position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 27 },
        startByte: 0,
        endByte: firstEndByte,
        sourceHash: 'hash-first',
        languageId: 'typescript',
        isExact: true,
      },
      {
        name: 'second',
        symbolId: 'symbol-second',
        qualifiedName: 'second',
        kind: 'function',
        signatureDiscriminator: 'second()',
        position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: 28 },
        startByte: firstEndByte,
        endByte: bytes.length,
        sourceHash: 'hash-second',
        languageId: 'typescript',
        isExact: true,
      },
    ];

    const chunker = new Chunker(new PluginRegistry());
    const chunks = await chunker.chunkStructuredFile(
      { filePath: 'src/functions.ts', language: 'typescript', content, bytes },
      { declarations, imports: [] },
    );

    expect(chunks.map((chunk) => chunk.content)).toEqual([firstSource, secondSource]);
    expect(chunks.map((chunk) => chunk.symbolId)).toEqual(['symbol-first', 'symbol-second']);
  });

  it('uses xxhash for chunk hashes', async () => {
    const chunker = new Chunker(new PluginRegistry());
    const chunks = await chunker.chunkFiles([
      {
        filePath: 'hello.txt',
        language: 'text',
        content: 'hello world',
      },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.hash).toMatch(/^[0-9a-f]{16}$/);
  });


  it('routes .mjs files through the TypeScript plugin and produces declaration chunks', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());

    const chunker = new Chunker(registry);
    const content = 'export function rebuilt() {\n  return 1;\n}\n';
    const chunks = await chunker.chunkFiles([
      {
        filePath: 'src/rebuilt.mjs',
        language: 'typescript',
        content,
      },
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks).toContainEqual(
      expect.objectContaining({ symbolName: 'rebuilt', symbolKind: 'function' }),
    );
});
});


describe('Chunker – maxChunkChars', () => {
  it('splits an oversized AST declaration into multiple sub-chunks', async () => {
    // 1 declaration whose content is 200 chars; limit is 100
    const longContent = 'x'.repeat(200);
    const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 100 });
    const symbolId = 'symbol_v1_test';
    const declaration = Object.assign(
      { type: 'function' as const, name: 'bigFn', startLine: 1, endLine: 10, content: longContent },
      { symbolId },
    );

    const chunks = await chunker.extractChunksWithYield(
      {
        rootType: 'program',
        declarations: [declaration],
      },
      { filePath: 'big.ts', language: 'typescript', content: longContent },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 100)).toBe(true);
    // All sub-chunks belong to the same original symbol
    expect(chunks.every((c) => c.symbolName === 'bigFn')).toBe(true);
    expect(chunks.every((c) => c.symbolId === symbolId)).toBe(true);
  });

  it('does NOT split chunks that are within the limit', async () => {
    const content = 'x'.repeat(50);
    const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 100 });

    const chunks = await chunker.extractChunksWithYield(
      {
        rootType: 'program',
        declarations: [{ type: 'function', name: 'smallFn', startLine: 1, endLine: 2, content }],
      },
      { filePath: 'small.ts', language: 'typescript', content },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(content);
  });

  it('fixed-line chunks also respect maxChunkChars', async () => {
    // 4 lines of 60 chars each; limit 100 → each 50-line window (here just 4 lines) is fine,
    // but a single window of all 4 lines = 4*60+3 = 243 chars > 100 → must split
    const longLine = 'a'.repeat(60);
    const content = Array.from({ length: 4 }, () => longLine).join('\n');
    const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 100 });
    const chunks = await chunker.chunkByFixedLines(
      { filePath: 'f.txt', language: 'text', content },
      { windowSize: 4, overlap: 0 },
    );

    expect(chunks.every((c) => c.content.length <= 100)).toBe(true);
  });

  it('keeps raw-source subchunk ranges and IDs aligned with leading Go comments', async () => {
    const rawSource = [
      '//go:noinline',
      '// Open opens a resource.',
      'func Open() {',
      '  return',
      '}',
    ].join('\n');
    const bytes = Buffer.from(rawSource, 'utf8');
    const declaration: StructuredDeclaration = {
      name: 'Open',
      symbolId: 'symbol-open',
      qualifiedName: 'Open',
      kind: 'function',
      signatureDiscriminator: 'Open()',
      position: { startLine: 3, startColumn: 0, endLine: 5, endColumn: 1 },
      startByte: 0,
      endByte: bytes.length,
      sourceHash: 'hash-open',
      languageId: 'go',
      isExact: true,
      rawSource,
    };
    const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 20 });

    const chunks = await chunker.chunkStructuredFile(
      { filePath: 'src/open.go', language: 'go', content: rawSource, bytes },
      { declarations: [declaration], imports: [] },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBe(5);
    expect(chunks.every((chunk) => chunk.startLine <= chunk.endLine)).toBe(true);
    expect(chunks.every((chunk, index) =>
      chunk.id === `src/open.go:${chunk.startLine}-${chunk.endLine}:Open-part${index + 1}`,
    )).toBe(true);
  });
});
