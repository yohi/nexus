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
      ['method', 'getIssuer'],
      ['method', 'revoke'],
    ]);

    expect(chunks[2]?.content).toContain('Authenti');
    expect(chunks[2]?.content).toContain('authenticate');
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
});
