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

  it('extracts class methods correctly (regression check)', async () => {
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

    const classDecls = result.declarations.filter(d => d.type === 'class');
    const funcDecls = result.declarations.filter(d => d.type === 'function');
    const methodDecls = result.declarations.filter(d => d.type === 'method');

    expect(classDecls).toHaveLength(1);
    expect(funcDecls).toHaveLength(1);
    expect(methodDecls).toHaveLength(2); // Should extract methods now

    expect(classDecls[0]!.name).toBe('MyClass');
    expect(methodDecls[0]!.name).toBe('method1');
    expect(methodDecls[1]!.name).toBe('method2');
    expect(funcDecls[0]!.name).toBe('top_level_func');
  });

  it('includes decorators in declaration range', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
@decorator1
@decorator2(arg=1)
class MyClass:
    @property
    def my_prop(self):
        return 1

@async_dec
async def my_func():
    pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/decorators.py',
      language: 'python',
      content,
    });

    const classDecl = result.declarations.find(d => d.type === 'class');
    const methodDecl = result.declarations.find(d => d.type === 'method');
    const funcDecl = result.declarations.find(d => d.type === 'function');

    expect(classDecl!.startLine).toBe(1); // Should start at @decorator1
    expect(methodDecl!.startLine).toBe(4); // Should start at @property (Line 4)
    expect(funcDecl!.startLine).toBe(8); // Should start at @async_dec (Line 8)
  });
});
