import { describe, expect, it } from 'vitest';

import { CSharpLanguagePlugin } from '../../../../src/plugins/languages/csharp.js';

describe('CSharpLanguagePlugin', () => {
  it('supports csharp file extensions', () => {
    const plugin = new CSharpLanguagePlugin();

    expect(plugin.supports('src/Program.cs')).toBe(true);
    expect(plugin.supports('src/Program.ts')).toBe(false);
  });
});
