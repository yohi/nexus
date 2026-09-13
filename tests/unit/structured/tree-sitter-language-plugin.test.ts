import { describe, expect, it } from 'vitest';
import type { StructuredSource } from '../../../src/structured/contracts.js';
import { createTreeSitterLanguagePlugin } from '../../../src/plugins/languages/tree-sitter-language-plugin.js';

describe('tree-sitter language plugin adapter', () => {
  it('passes the original bytes to the structured parser', async () => {
    let observedSource: StructuredSource | undefined;
    const Plugin = createTreeSitterLanguagePlugin({
      languageId: 'test',
      fileExtensions: ['.test'],
      rootType: 'source_file',
      createStructuredParser: async () => ({
        parseStructured: async (source) => {
          observedSource = source;
          return {
            status: 'ok',
            retrievability: 'exact',
            declarations: [],
            imports: [],
          };
        },
      }),
    });
    const bytes = new Uint8Array([0, 1, 2]);
    const parser = await new Plugin().createParser();

    await parser.parse({ filePath: 'sample.test', language: 'test', content: 'text', bytes });

    expect(observedSource?.bytes).toBe(bytes);
    expect(observedSource?.text).toBe('text');
  });
});
