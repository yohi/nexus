import { describe, expect, it } from 'vitest';

import { CLanguagePlugin } from '../../../../src/plugins/languages/c.js';

describe('CLanguagePlugin', () => {
  it('supports c file extensions', () => {
    const plugin = new CLanguagePlugin();

    expect(plugin.supports('src/main.c')).toBe(true);
    expect(plugin.supports('src/main.cpp')).toBe(false);
    expect(plugin.supports('src/main.ts')).toBe(false);
  });
});
