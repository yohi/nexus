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
      content: 'import (\n    "context"\n)',
    }));
    expect(imports[1]).toEqual(expect.objectContaining({
      type: 'import',
      name: 'imports',
      startLine: 6,
      endLine: 6,
      content: 'import ctx "context"',
    }));
    expect(imports[2]).toEqual(expect.objectContaining({
      type: 'import',
      name: 'imports',
      startLine: 7,
      endLine: 7,
      content: 'import "fmt"',
    }));
    expect(imports[3]).toEqual(expect.objectContaining({
      type: 'import',
      name: 'imports',
      startLine: 8,
      endLine: 8,
      content: 'import . "math"',
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
    expect(functions[1]!.startLine).toBe(18);
    expect(functions[1]!.endLine).toBe(18);
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

    const functions = result.declarations.filter(d => d.type === 'function');
    const methods = result.declarations.filter(d => d.type === 'method');

    expect(functions).toHaveLength(1);
    expect(functions[0]!.name).toBe('GenericFunc');
    
    expect(methods).toHaveLength(2);
    expect(methods[0]!.name).toBe('Get');
    expect(methods[1]!.name).toBe('Set');
  });
});
