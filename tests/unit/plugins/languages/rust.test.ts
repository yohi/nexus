import { describe, expect, it } from 'vitest';

import { RustLanguagePlugin } from '../../../../src/plugins/languages/rust.js';

describe('RustLanguagePlugin', () => {
  it('supports rust file extensions', () => {
    const plugin = new RustLanguagePlugin();

    expect(plugin.supports('src/main.rs')).toBe(true);
    expect(plugin.supports('src/main.ts')).toBe(false);
  });
});
