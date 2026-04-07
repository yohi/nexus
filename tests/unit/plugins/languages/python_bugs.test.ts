import { describe, expect, it } from 'vitest';
import { PythonLanguagePlugin } from '../../../../src/plugins/languages/python.js';

describe('PythonLanguagePlugin bugs', () => {
  it('detects backslash line-continuations in imports', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
from os import path, \\
    name, \\
    environ
import sys, \\
    json
`.trim();

    const result = await parser.parse({
      filePath: 'src/main.py',
      language: 'python',
      content,
    });

    const imports = result.declarations.filter(d => d.type === 'import');
    expect(imports).toHaveLength(1);
    
    expect(imports[0]).toEqual(expect.objectContaining({
      type: 'import',
      startLine: 1,
      endLine: 5,
    }));
  });

  it('skips class body to avoid mis-extracting inner methods', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
class MyClass:
    def method1(self):
        pass
        
    def method2(self, x):
        return x

def top_level_func():
    pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/classes.py',
      language: 'python',
      content,
    });

    // Only 1 class and 1 function should be detected as top-level declarations
    const classDecls = result.declarations.filter(d => d.type === 'class');
    const funcDecls = result.declarations.filter(d => d.type === 'function');
    const methodDecls = result.declarations.filter(d => d.type === 'method');

    expect(classDecls).toHaveLength(1);
    expect(funcDecls).toHaveLength(1);
    expect(methodDecls).toHaveLength(0); // methods should be skipped inside class body

    expect(classDecls[0]!.name).toBe('MyClass');
    expect(classDecls[0]!.startLine).toBe(1);
    expect(classDecls[0]!.endLine).toBe(6);

    expect(funcDecls[0]!.name).toBe('top_level_func');
    expect(funcDecls[0]!.startLine).toBe(8);
  });
});
