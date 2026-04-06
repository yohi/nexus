import { describe, expect, it } from 'vitest';

import { GoLanguagePlugin } from '../../../../src/plugins/languages/go.js';

describe('GoLanguagePlugin', () => {
  it('supports go file extensions', () => {
    const plugin = new GoLanguagePlugin();

    expect(plugin.supports('src/handler.go')).toBe(true);
    expect(plugin.supports('src/handler.ts')).toBe(false);
  });

  it('extracts imports, structs, functions, and methods', async () => {
    const plugin = new GoLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
package sample

import (
    "context"
    "net/http"
)

type Handler struct {
    client *http.Client
}

func NewHandler(client *http.Client) *Handler {
    return &Handler{client: client}
}

func (h *Handler) Serve(ctx context.Context) error {
    return nil
}
`.trim();

    const result = await parser.parse({
      filePath: 'src/handler.go',
      language: 'go',
      content,
    });

    expect(result.rootType).toBe('source_file');
    expect(result.declarations).toEqual([
      expect.objectContaining({
        type: 'import',
        name: 'imports',
        startLine: 3,
        endLine: 6,
      }),
      expect.objectContaining({
        type: 'class',
        name: 'Handler',
        startLine: 8,
        endLine: 10,
      }),
      expect.objectContaining({
        type: 'function',
        name: 'NewHandler',
        startLine: 12,
        endLine: 14,
      }),
      expect.objectContaining({
        type: 'method',
        name: 'Serve',
        startLine: 16,
        endLine: 18,
      }),
    ]);
  });
});
