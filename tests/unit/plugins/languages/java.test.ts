import { describe, expect, it } from 'vitest';

import { JavaLanguagePlugin } from '../../../../src/plugins/languages/java.js';

describe('JavaLanguagePlugin', () => {
  it('supports java file extensions', () => {
    const plugin = new JavaLanguagePlugin();

    expect(plugin.supports('src/Main.java')).toBe(true);
    expect(plugin.supports('src/Main.ts')).toBe(false);
  });
});
