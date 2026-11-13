import { describe, expect, it } from 'vitest';
import type { PhysicalVectorRow } from '../../../src/storage/interfaces/vector-audit.js';
import { assessPhysicalRows } from '../../../src/indexer/integrity-preflight-rows.js';

const legacyRow = (id: string, vector: readonly number[] = [0.25, 0.75]): PhysicalVectorRow => ({
  view: 'legacy', id, filePath: `${id}.ts`, name: '', kind: 'function', contentHash: `hash-${id}`,
  startLine: 1, endLine: 1, vector,
});

describe('physical integrity preflight', () => {
  it('matches exact row multiplicity and persisted Float32 vector values', () => {
    const expected = [legacyRow('chunk', [0.25000001, 0.75])];
    const actual = [legacyRow('chunk', [0.25, 0.75])];

    expect(assessPhysicalRows(expected, actual, 2)).toEqual({ kind: 'MATCH' });
  });

  it('confirms a duplicate physical row even when the expected identity is present', () => {
    const expected = [legacyRow('chunk')];

    expect(assessPhysicalRows(expected, [...expected, ...expected], 2)).toEqual({
      kind: 'CORRUPTION_CONFIRMED', reason: 'row_multiset_mismatch',
    });
  });

  it('confirms a same-count identity mismatch rather than matching by row count', () => {
    expect(assessPhysicalRows([legacyRow('expected')], [legacyRow('actual')], 2)).toEqual({
      kind: 'CORRUPTION_CONFIRMED', reason: 'row_multiset_mismatch',
    });
  });

  it('confirms vector value and dimension mismatches', () => {
    expect(assessPhysicalRows([legacyRow('chunk')], [legacyRow('chunk', [0.5, 0.5])], 2)).toEqual({
      kind: 'CORRUPTION_CONFIRMED', reason: 'row_multiset_mismatch',
    });
    expect(assessPhysicalRows([legacyRow('chunk')], [legacyRow('chunk', [0.25])], 2)).toEqual({
      kind: 'CORRUPTION_CONFIRMED', reason: 'invalid_vector',
    });
  });

  it('returns unknown rather than matching when expected vectors cannot be proven', () => {
    expect(assessPhysicalRows(undefined, [legacyRow('chunk')], 2)).toEqual({
      kind: 'INTEGRITY_UNKNOWN', reason: 'expected_rows_unavailable',
    });
  });
});
