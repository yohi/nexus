import { describe, expect, it } from 'vitest';
import { TypeScriptLanguagePlugin } from '../../../../src/plugins/languages/typescript.js';

describe('TypeScriptLanguagePlugin Regression', () => {
  it('extracts JSDoc, export, and const for variable statements', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    const content = `/**
 * This is a JSDoc comment.
 */
export const foo = () => {};`;

    const result = await parser.parse({
      filePath: 'test.ts',
      language: 'typescript',
      content,
    });

    const foo = result.declarations.find(d => d.name === 'foo');
    expect(foo).toBeDefined();
    // 現状では declaration.getFullStart() を使っているため、JSDocが含まれないか、
    // declarationがどこから始まるかによって export const が欠落する可能性がある。
    expect(foo?.content).toContain('/**');
    expect(foo?.content).toContain('export const foo');
    expect(foo?.startLine).toBe(1);
  });

  it('aligns startLine with trimmed content (ignoring leading blank lines and JSDoc)', async () => {
    const plugin = new TypeScriptLanguagePlugin();
    const parser = await plugin.createParser();
    // 前方に空行があるケース
    const content = `

/**
 * Doc
 */
export const bar = 1;`;

    const result = await parser.parse({
      filePath: 'test.ts',
      language: 'typescript',
      content,
    });

    const bar = result.declarations.find(d => d.name === 'bar');
    expect(bar).toBeDefined();
    // 期待値: /** の行 (3行目)
    expect(bar?.startLine).toBe(3);
  });
});
