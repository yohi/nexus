import { describe, expect, it } from 'vitest';
import { GoLanguagePlugin } from '../../../../src/plugins/languages/go.js';

describe('GoLanguagePlugin bugs', () => {
  it('detects alias imports and single-line imports', async () => {
    const plugin = new GoLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
package sample

import (
    "context"
)
import ctx "context"
import "fmt"
import . "math"

func main() {}
`.trim();

    const result = await parser.parse({
      filePath: 'src/main.go',
      language: 'go',
      content,
    });

    const imports = result.declarations.filter(d => d.type === 'import');
    expect(imports).toHaveLength(4);

    expect(imports[0]).toEqual(expect.objectContaining({
      type: 'import',
      name: 'imports',
      startLine: 3,
      endLine: 5,
    }));
  });

  it('correctly handles braces in comments and strings', async () => {
    const plugin = new GoLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
package sample

func ComplexFunc() {
    // This is a comment with a brace {
    /* Multi-line comment { */
    /*
     * Multi-line block comment
     * with brace { here
     */
    s := "string with brace {"
    r := \`raw string with brace {\`
    c := '{'
    if true {
        fmt.Println("nested")
    }
}

func AnotherFunc() {}
`.trim();

    const result = await parser.parse({
      filePath: 'src/complex.go',
      language: 'go',
      content,
    });

    const functions = result.declarations.filter(d => d.type === 'function');
    expect(functions).toHaveLength(2);
    
    expect(functions[0]!.name).toBe('ComplexFunc');
    expect(functions[0]!.startLine).toBe(3);
    expect(functions[0]!.endLine).toBe(16);
    
    expect(functions[1]!.name).toBe('AnotherFunc');
  });

  it('detects functions and methods with generics', async () => {
    const plugin = new GoLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
package sample

func GenericFunc[T any](x T) T {
    return x
}

type Container[T any] struct {
    value T
}

func (c *Container[T]) Get() T {
    return c.value
}

func (c *Container[T]) Set[V any](x V) {}
`.trim();

    const result = await parser.parse({
      filePath: 'src/generics.go',
      language: 'go',
      content,
    });

    const structs = result.declarations.filter(d => d.type === 'class');
    const functions = result.declarations.filter(d => d.type === 'function');
    const methods = result.declarations.filter(d => d.type === 'method');

    expect(structs).toHaveLength(1);
    expect(structs[0]!.name).toBe('Container');

    expect(functions).toHaveLength(1);
    expect(functions[0]!.name).toBe('GenericFunc');
    
    expect(methods).toHaveLength(2);
    expect(methods[0]!.name).toBe('Get');
    expect(methods[1]!.name).toBe('Set');
  });

  it('detects grouped type declarations', async () => {
    const plugin = new GoLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
package sample

type (
    A struct {
        X int
    }
    B interface {
        Foo()
    }
    C int
)

func main() {}
`.trim();

    const result = await parser.parse({
      filePath: 'src/grouped.go',
      language: 'go',
      content,
    });

    const classes = result.declarations.filter(d => d.type === 'class');
    expect(classes).toHaveLength(3); // A, B, and C
    
    const names = classes.map(c => c.name);
    expect(names).toContain('A');
    expect(names).toContain('B');
    expect(names).toContain('C');
    
    const a = classes.find(c => c.name === 'A');
    expect(a!.startLine).toBe(4);
    expect(a!.endLine).toBe(6);

    const cDecl = classes.find(c => c.name === 'C');
    expect(cDecl).toBeDefined();
    expect(cDecl!.startLine).toBe(10);
    expect(cDecl!.endLine).toBe(10); // C int should be a single line
  });
});
