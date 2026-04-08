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

  it('correctly handles multi-line docstrings with nested brackets', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
def func_with_complex_doc():
    """
    This docstring contains unbalanced brackets: { ( [
    to test if the parser correctly ignores them.
    """
    return 1

class MyClass:
    '''
    Another docstring with } ) ]
    spanning multiple lines.
    '''
    def method(self):
        pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/docstrings.py',
      language: 'python',
      content,
    });

    const funcDecl = result.declarations.find(d => d.name === 'func_with_complex_doc');
    const classDecl = result.declarations.find(d => d.name === 'MyClass');
    const methodDecl = result.declarations.find(d => d.name === 'method');

    expect(funcDecl!.endLine).toBe(6);
    expect(classDecl!.endLine).toBe(14);
    expect(methodDecl!.startLine).toBe(13);
  });

  it('supports Python 3.12 generics in functions', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
def generic_func[T](x: T) -> T:
    return x

async def async_generic[T, U](x: T, y: U):
    pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/generics.py',
      language: 'python',
      content,
    });

    const func1 = result.declarations.find(d => d.name === 'generic_func');
    const func2 = result.declarations.find(d => d.name === 'async_generic');

    expect(func1).toBeDefined();
    expect(func2).toBeDefined();
  });

  it('collects only top-level classes but extracts their methods', async () => {
    const plugin = new PythonLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
class TopLevel:
    class Nested:
        def nested_method(self):
            pass
    def top_method(self):
        pass
`.trim();

    const result = await parser.parse({
      filePath: 'src/nested.py',
      language: 'python',
      content,
    });

    const classDecls = result.declarations.filter(d => d.type === 'class');
    const methodDecls = result.declarations.filter(d => d.type === 'method');

    expect(classDecls).toHaveLength(1);
    expect(classDecls[0]!.name).toBe('TopLevel');
    
    // nested_method should be extracted, top_method should be extracted
    expect(methodDecls.map(m => m.name)).toContain('nested_method');
    expect(methodDecls.map(m => m.name)).toContain('top_method');
  });
});
