import { describe, expect, it } from 'vitest';
import {
  logicalPathSchema, reportSchema, grepMultisetProofSchema, scenarioRecordSchema,
  retrievalValidationSchema,
} from '../../../benchmarks/performance/contracts.js';

describe('performance report contracts', () => {
  it.each(['', '/tmp/source.ts', '../source.ts', 'a/../b.ts', './b.ts', 'a//b.ts',
    'C:source.ts', 'C:\\source.ts', '\\\\host\\share.ts', 'a\\b.ts', 'a\0b.ts'])(
  'rejects unsafe logical identity %j', (path) => {
    // Given / When
    const result = logicalPathSchema.safeParse(path);
    // Then
    expect(result.success).toBe(false);
  });

  it.each(['packages/a/src/file.ts', 'packages/Case/日本語.ts'])(
  'preserves valid logical identity %j', (path) => {
    // Given / When
    const result = logicalPathSchema.parse(path);
    // Then
    expect(result).toBe(path);
  });

  it.each([{}, { schemaVersion: 2 }, { schemaVersion: 1, scenarios: [] }])(
  'rejects malformed reports %j', (value) => {
    // Given / When
    const result = reportSchema.safeParse(value);
    // Then
    expect(result.success).toBe(false);
  });

  it('rejects successful proof without counts and digest', () => {
    // Given / When
    const result = grepMultisetProofSchema.safeParse({ status: 'valid', algorithm: 'sha256-multiset-v1' });
    // Then
    expect(result.success).toBe(false);
  });

  it('rejects raw content and absolute paths even on invalid proof', () => {
    // Given / When
    const result = grepMultisetProofSchema.safeParse({
      status: 'invalid', algorithm: 'sha256-multiset-v1', reason: 'missing_evidence',
      rawMatches: [{ path: '/tmp/unsafe.ts', lineText: 'secret source' }],
    });
    // Then
    expect(result.success).toBe(false);
  });

  it('rejects a nominally valid scenario without admission evidence', () => {
    // Given / When
    const result = scenarioRecordSchema.safeParse({ status: 'valid', rawSamples: [1] });
    // Then
    expect(result.success).toBe(false);
  });

  it('rejects a successful validation that embeds an invalid grep proof', () => {
    const result = retrievalValidationSchema.safeParse({ status: 'valid', resultCount: 0, identities: [],
      grepProof: { status: 'invalid', algorithm: 'sha256-multiset-v1', reason: 'missing_evidence' } });
    expect(result.success).toBe(false);
  });
});
