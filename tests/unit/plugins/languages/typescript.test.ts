import { describe, expect, it } from 'vitest';
import { TypeScriptLanguagePlugin } from '../../../../src/plugins/languages/typescript.js';

describe('TypeScriptLanguagePlugin', () => {
  it('extracts exported variables and arrow functions', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
      import { something } from './else';

      export const myVar = 'value';
      export let myLet = 123;
      export const myArrow = () => { return 1; };
      export const myFuncExpr = function() { return 2; };
      const internal = 'secret';

      export function regularFunction() {}
      
      export const { a, b } = { a: 1, b: 2 }; // Destructuring (should skip or handle gracefully)
    `;

    const result = await parser.parse({
      filePath: 'test.ts',
      language: 'typescript',
      content,
    });

    const symbols = result.declarations.map(d => ({ type: d.type, name: d.name }));

    expect(symbols).toContainEqual({ type: 'variable', name: 'myVar' });
    expect(symbols).toContainEqual({ type: 'variable', name: 'myLet' });
    expect(symbols).toContainEqual({ type: 'function', name: 'myArrow' });
    expect(symbols).toContainEqual({ type: 'function', name: 'myFuncExpr' });
    expect(symbols).toContainEqual({ type: 'function', name: 'regularFunction' });
    
    // Check that internal (non-exported) is not included
    expect(symbols).not.toContainEqual({ type: 'variable', name: 'internal' });
  });

  it('identifies call expressions returning functions as functions', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
      export const myHOC = withLogging(() => {
        return 'wrapped';
      });
    `;

    const result = await parser.parse({
      filePath: 'test.ts',
      language: 'typescript',
      content,
    });

    const symbols = result.declarations.map(d => ({ type: d.type, name: d.name }));
    expect(symbols).toContainEqual({ type: 'function', name: 'myHOC' });
  });
});
