import { describe, expect, it } from 'vitest';
import { TypeScriptLanguagePlugin } from '../../../../src/plugins/languages/typescript.js';

describe('TypeScriptLanguagePlugin Regression Tests', () => {
  it('correctly calculates line range for nodes with leading comments', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `
// First line is a comment
/**
 * Leading comment
 */
export function commentedFunction() {
  return 1;
}
    `; // No .trim() here, so it starts with a newline

    const result = await parser.parse({
      filePath: 'test.ts',
      language: 'typescript',
      content,
    });

    const decl = result.declarations.find(d => d.name === 'commentedFunction');
    expect(decl).toBeDefined();
    // result.declarations.sort is by startLine.
    // Line 1: empty
    // Line 2: // First line...
    // Line 3: /**
    // Line 4:  * Leading comment
    // Line 5:  */
    // Line 6: export function...
    // getFullStart() should return the position at the start of the trivia (Line 2 or 3 depending on trivia)
    // Actually, getFullStart() on the function declaration node will include the leading comments.
    // If we use node.getFullStart(), it should be line 2 (the first comment).
    // If we use node.getStart(sourceFile, true), it would be line 6.
    expect(decl!.startLine).toBeLessThanOrEqual(3); 
    expect(decl!.content).toContain('// First line');
  });

  it('detects anonymous default function export', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `export default function() { return "anon function"; }`;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    expect(result.declarations).toContainEqual(expect.objectContaining({ type: 'function', name: '<anonymous>' }));
  });

  it('detects anonymous default class export', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `export default class { method() {} }`;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    expect(result.declarations).toContainEqual(expect.objectContaining({ type: 'class', name: '<anonymous>' }));
  });

  it('detects anonymous default arrow function export', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `export default () => "arrow";`;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    expect(result.declarations).toContainEqual(expect.objectContaining({ type: 'function', name: '<anonymous>' }));
  });

  it('detects default identifier export', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `const myVar = 1; export default myVar;`;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    expect(result.declarations).toContainEqual(expect.objectContaining({ type: 'unknown', name: 'myVar' }));
  });

  it('detects default expression export', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `export default "expression";`;
    const result = await parser.parse({ filePath: 'test.ts', language: 'typescript', content });
    expect(result.declarations).toContainEqual(expect.objectContaining({ type: 'unknown', name: '<anonymous>' }));
  });
});
