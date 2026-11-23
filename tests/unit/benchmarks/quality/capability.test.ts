import { describe, it, expect } from 'vitest';
import { classifyCapabilityEvidence } from '../../../benchmarks/quality/runner.js';

describe('classifyCapabilityEvidence', () => {
  it('treats synthetic executed routes as FUNCTIONAL_ONLY', () => {
    expect(classifyCapabilityEvidence({ route: 'synthetic', executed: true, ownerApproved: true })).toBe('FUNCTIONAL_ONLY');
    expect(classifyCapabilityEvidence({ route: 'synthetic', executed: true, ownerApproved: false })).toBe('FUNCTIONAL_ONLY');
  });

  it('treats synthetic routes that did not run as NOT_RUN', () => {
    expect(classifyCapabilityEvidence({ route: 'synthetic', executed: false, ownerApproved: true })).toBe('NOT_RUN');
  });

  it('grants RELEVANCE_ELIGIBLE only to executed, owner-approved pinned embeddings', () => {
    expect(classifyCapabilityEvidence({ route: 'pinned_embedding', executed: true, ownerApproved: true })).toBe('RELEVANCE_ELIGIBLE');
    expect(classifyCapabilityEvidence({ route: 'pinned_embedding', executed: true, ownerApproved: false })).toBe('FUNCTIONAL_ONLY');
    expect(classifyCapabilityEvidence({ route: 'pinned_embedding', executed: false, ownerApproved: true })).toBe('NOT_RUN');
  });

  it('treats executed LSP stubs as CONTRACT_ONLY, never REAL_LSP_ELIGIBLE', () => {
    expect(classifyCapabilityEvidence({ route: 'lsp_stub', executed: true, ownerApproved: true })).toBe('CONTRACT_ONLY');
    expect(classifyCapabilityEvidence({ route: 'lsp_stub', executed: true, ownerApproved: false })).toBe('CONTRACT_ONLY');
    expect(classifyCapabilityEvidence({ route: 'lsp_stub', executed: false, ownerApproved: true })).toBe('NOT_RUN');
  });

  it('grants REAL_LSP_ELIGIBLE only to executed, owner-approved real LSP', () => {
    expect(classifyCapabilityEvidence({ route: 'lsp_real', executed: true, ownerApproved: true })).toBe('REAL_LSP_ELIGIBLE');
    expect(classifyCapabilityEvidence({ route: 'lsp_real', executed: true, ownerApproved: false })).toBe('NOT_RUN');
    expect(classifyCapabilityEvidence({ route: 'lsp_real', executed: false, ownerApproved: true })).toBe('NOT_RUN');
  });
});
