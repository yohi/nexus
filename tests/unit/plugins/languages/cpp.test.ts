import { describe, expect, it } from 'vitest';

import { CppLanguagePlugin } from '../../../../src/plugins/languages/cpp.js';

describe('CppLanguagePlugin', () => {
  it('supports cpp file extensions', () => {
    const plugin = new CppLanguagePlugin();

    expect(plugin.supports('src/main.cpp')).toBe(true);
    expect(plugin.supports('src/main.cc')).toBe(true);
    expect(plugin.supports('src/main.cxx')).toBe(true);
    expect(plugin.supports('src/header.h')).toBe(true);
    expect(plugin.supports('src/header.hh')).toBe(true);
    expect(plugin.supports('src/header.hpp')).toBe(true);
    expect(plugin.supports('src/header.hxx')).toBe(true);
    expect(plugin.supports('src/main.c')).toBe(false);
    expect(plugin.supports('src/main.ts')).toBe(false);
  });
});
