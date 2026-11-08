import { describe, expect, it } from 'vitest';

import type { IContentStore } from '../../../../src/storage/interfaces/content-store.js';
import { buildToolHandlers, createContentReader } from '../../../../src/server/tools/tool-support.js';
import { createTestNexusOptions } from '../../../shared/create-test-nexus-options.js';

describe('buildToolHandlers', () => {
  it('returns handlers for all twelve tools', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    expect(Object.keys(handlers).sort()).toEqual([
      'get_context',
      'get_definition',
      'get_file_outline',
      'get_implementations',
      'get_references',
      'get_symbol_context',
      'get_symbol_source',
      'grep_search',
      'hybrid_search',
      'index_status',
      'reindex',
      'semantic_search',
    ]);
  });

  it('grep_search returns matches as structuredContent', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.grep_search({ pattern: 'authenticate' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.['matches']).toEqual([
      expect.objectContaining({ filePath: 'src/auth.ts' }),
    ]);
  });

  it('get_context on an unknown file returns the legacy error shape', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.get_context({ filePath: 'nope.ts' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: true });
    expect(result.structuredContent).not.toHaveProperty('code');
  });

  it('awaits initialization before executing', async () => {
    const { options } = await createTestNexusOptions();
    const calls: string[] = [];
    const handlers = buildToolHandlers(options, async () => {
      calls.push('init');
    });
    await handlers.index_status({});
    expect(calls).toEqual(['init']);
  });
});

describe('createContentReader', () => {
  const createStore = (overrides: Partial<IContentStore>): IContentStore => ({
    put: async () => undefined,
    get: async () => null,
    delete: async () => undefined,
    exists: async () => false,
    readRange: async () => 'FROM_STORE',
    ...overrides,
  });

  it('reads through the ContentStore when available', async () => {
    const reader = createContentReader(createStore({
      readRange: async (_path: string, startLine: number, endLine: number): Promise<string> =>
        `${startLine}-${endLine}`,
    }), async () => {
      throw new Error('filesystem reader must not be called');
    });

    await expect(reader('src/auth.ts', 2, 4)).resolves.toBe('2-4');
  });

  it('falls back to the filesystem reader when ContentStore reading fails', async () => {
    const reader = createContentReader(
      createStore({
        readRange: async () => {
          throw new Error('store unavailable');
        },
      }),
      async () => 'FROM_FILESYSTEM',
    );

    await expect(reader('src/auth.ts')).resolves.toBe('FROM_FILESYSTEM');
  });

  it('uses ContentStore reads for get_context', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers({
      ...options,
      contentStore: createStore({
        readRange: async (_path: string, startLine: number, endLine: number): Promise<string> =>
          `${startLine}-${endLine}`,
      }),
      loadFileContent: async () => {
        throw new Error('filesystem reader must not be called');
      },
    });

    const result = await handlers.get_context({ filePath: 'src/index.ts', startLine: 2, endLine: 4 });
    expect(result.structuredContent).toMatchObject({ filePath: 'src/index.ts', content: '2-4' });
  });

  it('uses ContentStore reads for hybrid search snippets', async () => {
    const { options, grepEngine } = await createTestNexusOptions();
    const handlers = buildToolHandlers({
      ...options,
      contentStore: createStore({}),
      loadFileContent: async () => {
        throw new Error('filesystem reader must not be called');
      },
    });

    grepEngine.addFile('src/index.ts', 'export const test = true;\n');
    const result = await handlers.hybrid_search({ query: 'export', includeSnippet: true });
    expect(result.structuredContent).toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ snippet: 'FROM_STORE' })]),
    });
  });

  it('applies the requested line range when falling back from ContentStore', async () => {
    const reader = createContentReader(
      createStore({
        readRange: async () => {
          throw new Error('store unavailable');
        },
      }),
      async () => ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'),
    );

    await expect(reader('src/index.ts', 2, 4)).resolves.toBe('line2\nline3\nline4');
  });
});
