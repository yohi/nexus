import { describe, expect, it } from 'vitest';
import { PythonLanguagePlugin } from '../../../../src/plugins/languages/python.js';

describe('PythonLanguagePlugin bugs', () => {
  it('handles multi-line parenthesized imports', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
from pathlib import (
    Path,
    PurePath,
)
import os

def main():
    pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/main.py',
      language: 'python',
      content,
    });

    const imports = result.declarations.filter(d => d.type === 'import');
    expect(imports).toHaveLength(1);
    expect(imports[0].startLine).toBe(1);
    expect(imports[0].endLine).toBe(5);
    expect(imports[0].content).toContain('from pathlib import (');
    expect(imports[0].content).toContain('Path,');
    expect(imports[0].content).toContain('PurePath,');
    expect(imports[0].content).toContain(')');
    expect(imports[0].content).toContain('import os');
  });

  it('separates non-contiguous imports', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
import os

class A:
    pass

import sys

def f():
    pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/main.py',
      language: 'python',
      content,
    });

    const imports = result.declarations.filter(d => d.type === 'import');
    expect(imports).toHaveLength(2);
    
    expect(imports[0]).toEqual(expect.objectContaining({
      type: 'import',
      name: 'imports',
      startLine: 1,
      endLine: 1,
      content: 'import os',
    }));
    
    expect(imports[1]).toEqual(expect.objectContaining({
      type: 'import',
      name: 'imports',
      startLine: 6,
      endLine: 6,
      content: 'import sys',
    }));
  });
});
