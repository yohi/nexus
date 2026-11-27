import { describe, it, expect } from 'vitest';
import { classifyCapabilityEvidence } from '../../../benchmarks/quality/runner.js';

const cases = [
  { route: 'synthetic', executed: true, ownerApproved: true, expected: 'FUNCTIONAL_ONLY' },
  { route: 'synthetic', executed: true, ownerApproved: false, expected: 'FUNCTIONAL_ONLY' },
  { route: 'synthetic', executed: false, ownerApproved: true, expected: 'NOT_RUN' },
  { route: 'pinned_embedding', executed: true, ownerApproved: true, expected: 'RELEVANCE_ELIGIBLE' },
  { route: 'pinned_embedding', executed: true, ownerApproved: false, expected: 'FUNCTIONAL_ONLY' },
  { route: 'pinned_embedding', executed: false, ownerApproved: true, expected: 'NOT_RUN' },
  { route: 'lsp_stub', executed: true, ownerApproved: true, expected: 'CONTRACT_ONLY' },
  { route: 'lsp_stub', executed: true, ownerApproved: false, expected: 'CONTRACT_ONLY' },
  { route: 'lsp_stub', executed: false, ownerApproved: true, expected: 'NOT_RUN' },
  { route: 'lsp_real', executed: true, ownerApproved: true, expected: 'REAL_LSP_ELIGIBLE' },
  { route: 'lsp_real', executed: true, ownerApproved: false, expected: 'NOT_RUN' },
  { route: 'lsp_real', executed: false, ownerApproved: true, expected: 'NOT_RUN' },
] as const;

describe('classifyCapabilityEvidence', () => {
  it.each(cases)(
    '$route: executed=$executed, ownerApproved=$ownerApproved -> $expected',
    ({ route, executed, ownerApproved, expected }) => {
      expect(classifyCapabilityEvidence({ route, executed, ownerApproved })).toBe(expected);
    },
  );
});
