import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../../tests/benchmarks/quality/canonical-json.js';
import { canonicalJson as policyCanonicalJson } from '../../../../tests/benchmarks/quality/policy.js';

describe('canonicalJson', () => {
  it('sorts nested object keys independently using locale-independent order', () => {
    const value = {
      z: { beta: 2, alpha: 1 },
      a: [{ y: true, x: false }],
    };

    expect(canonicalJson(value)).toBe('{"a":[{"x":false,"y":true}],"z":{"alpha":1,"beta":2}}');
  });

  it('does not depend on the insertion order of nested object keys', () => {
    const left = { outer: { z: 1, a: 2 }, other: 'value' };
    const right = { other: 'value', outer: { a: 2, z: 1 } };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('omits undefined object fields like JSON serialization does', () => {
    expect(canonicalJson({ present: 1, omitted: undefined })).toBe('{"present":1}');
  });

  it('omits undefined object fields when policy arguments are canonicalized', () => {
    expect(policyCanonicalJson({ present: 1, omitted: undefined })).toBe('{"present":1}');
  });
});
