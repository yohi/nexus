import { describe, expect, it } from 'vitest';
import type { SymbolKind } from '../../../src/types/index.js';

describe('SymbolKind', () => {
  it('includes new language kinds', () => {
    const kinds: SymbolKind[] = ['struct', 'trait', 'impl', 'record', 'field'];
    expect(kinds).toHaveLength(5);
  });
});
