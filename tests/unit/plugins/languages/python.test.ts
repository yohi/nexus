import { describe, expect, it } from 'vitest';

import { PythonLanguagePlugin } from '../../../../src/plugins/languages/python.js';

describe('PythonLanguagePlugin', () => {
  it('supports python file extensions', () => {
    const plugin = new PythonLanguagePlugin();

    expect(plugin.supports('src/utils.py')).toBe(true);
    expect(plugin.supports('src/utils.ts')).toBe(false);
  });

  it('extracts classes and functions with line ranges', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
import os
from pathlib import Path

class SessionStore:
    def __init__(self, root: Path):
        self.root = root

    def read(self, key: str) -> str:
        return key

def build_token(user_id: str) -> str:
    return f"token:{user_id}"
`.trim();

    const result = await parser.parse({
      filePath: 'src/utils.py',
      language: 'python',
      content,
    });

    expect(result.rootType).toBe('module');
    expect(result.declarations).toEqual([
      expect.objectContaining({
        type: 'import',
        name: 'imports',
        startLine: 1,
        endLine: 3,
      }),
      expect.objectContaining({
        type: 'class',
        name: 'SessionStore',
        startLine: 4,
        endLine: 9,
      }),
      expect.objectContaining({
        type: 'method',
        name: '__init__',
        startLine: 5,
        endLine: 6,
      }),
      expect.objectContaining({
        type: 'method',
        name: 'read',
        startLine: 8,
        endLine: 9,
      }),
      expect.objectContaining({
        type: 'function',
        name: 'build_token',
        startLine: 11,
        endLine: 12,
      }),
    ]);
  });
});
