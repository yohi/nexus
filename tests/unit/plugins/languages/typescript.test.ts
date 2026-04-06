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

  it('handles ExportAssignment with function expressions and arrow functions', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    
    const content = `
      export default () => { return 2; };
    `;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    expect(result.declarations).toContainEqual(expect.objectContaining({ type: 'function', name: '<anonymous>' }));

    const content2 = `
      export default function() { return 3; };
    `;
    const result2 = await parser.parse({ filePath: 'test.ts', language: 'typescript', content: content2 });
    expect(result2.declarations).toContainEqual(expect.objectContaining({ type: 'function', name: '<anonymous>' }));
  });

  it('aggregates imports into a single declaration safely', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    
    const content = `
      import { a } from 'a';
      import { b } from 'b';
      
      export const x = 1;
      
      import { c } from 'c';
    `;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    const importSymbol = result.declarations.find(d => d.type === 'import');
    expect(importSymbol).toBeDefined();
    expect(importSymbol?.name).toBe('imports');
    expect(importSymbol?.content).toContain("import { a } from 'a';");
    expect(importSymbol?.content).toContain("import { c } from 'c';");
  });

  it('correctly ignores abstract members and declaration files', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    
    // Abstract class and members
    const abstractContent = `
      export abstract class MyAbstractClass {
        abstract myAbstractMethod(): void;
        myImplementedMethod() { return 1; }
        
        abstract get myAbstractAccessor(): string;
        get myImplementedAccessor() { return 'a'; }
      }
    `;
    
    const abstractResult = await parser.parse({
      filePath: 'abstract.ts',
      language: 'typescript',
      content: abstractContent,
    });
    
    const abstractSymbols = abstractResult.declarations.map(d => d.name);
    expect(abstractSymbols).toContain('MyAbstractClass');
    expect(abstractSymbols).toContain('myImplementedMethod');
    expect(abstractSymbols).toContain('get myImplementedAccessor');
    
    expect(abstractSymbols).not.toContain('myAbstractMethod');
    expect(abstractSymbols).not.toContain('get myAbstractAccessor');

    // Declaration file
    const dtsContent = `
      export function declaredFunction(): void;
      export class DeclaredClass {
        method(): void;
      }
    `;
    
    const dtsResult = await parser.parse({
      filePath: 'test.d.ts',
      language: 'typescript',
      content: dtsContent,
    });
    
    const dtsSymbols = dtsResult.declarations.map(d => d.name);
    // Classes are still included
    expect(dtsSymbols).toContain('DeclaredClass');
    
    // Functions and methods in .d.ts should be ignored
    expect(dtsSymbols).not.toContain('declaredFunction');
    expect(dtsSymbols).not.toContain('method');
  });
});
