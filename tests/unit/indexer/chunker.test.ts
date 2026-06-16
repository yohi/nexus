import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FileToChunk, LanguagePlugin } from '../../../src/types/index.js';
import { Chunker } from '../../../src/indexer/chunker.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

describe('Chunker', () => {
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
});

describe('Chunker – maxChunkChars', () => {
  it('splits an oversized AST declaration into multiple sub-chunks', async () => {
    // 1 declaration whose content is 200 chars; limit is 100
    const longContent = 'x'.repeat(200);
    const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 100 });

    const chunks = await chunker.extractChunksWithYield(
      {
        rootType: 'program',
        declarations: [{ type: 'function', name: 'bigFn', startLine: 1, endLine: 10, content: longContent }],
      },
      { filePath: 'big.ts', language: 'typescript', content: longContent },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 100)).toBe(true);
    // All sub-chunks belong to the same original symbol
    expect(chunks.every((c) => c.symbolName === 'bigFn')).toBe(true);
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

  it('fixed-line chunks also respect maxChunkChars', () => {
    // 4 lines of 60 chars each; limit 100 → each 50-line window (here just 4 lines) is fine,
    // but a single window of all 4 lines = 4*60+3 = 243 chars > 100 → must split
    const longLine = 'a'.repeat(60);
    const content = Array.from({ length: 4 }, () => longLine).join('\n');
    const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 100 });
    const chunks = chunker.chunkByFixedLines(
      { filePath: 'f.txt', language: 'text', content },
      { windowSize: 4, overlap: 0 },
    );

    expect(chunks.every((c) => c.content.length <= 100)).toBe(true);
  });
});
