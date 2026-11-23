import { describe, it, expect } from 'vitest';
import { createQualityFixture } from '../../benchmarks/quality/fixtures.js';
import {
  collectQualityRouteCoverage,
  createLspStubAdapter,
  classifyCapabilityEvidence,
} from '../../benchmarks/quality/runner.js';
import type { PublicSourceLocation } from '../../benchmarks/quality/adapters.js';
import type { QualityCaseManifest } from '../../benchmarks/quality/contracts.js';

const signal = new AbortController().signal;

function taskFor(fixture: Awaited<ReturnType<typeof createQualityFixture>>, taskId: string): QualityCaseManifest {
  const task = fixture.oracleCases.find((item) => item.taskId === taskId);
  if (task === undefined) throw new Error(`missing_task:${taskId}`);
  return task;
}

function stubLocationsFor(task: QualityCaseManifest): { definition: PublicSourceLocation[]; references: PublicSourceLocation[]; implementations: PublicSourceLocation[] } {
  const [first] = task.expectedLocations.map((location) => ({
    filePath: location.filePath,
    startLine: location.line,
    startCharacter: location.character,
    endLine: location.line,
    endCharacter: location.character + 6,
  }));
  const definition: PublicSourceLocation[] = first !== undefined ? [first] : [];
  const references: PublicSourceLocation[] = first !== undefined ? [first] : [];
  const implementations: PublicSourceLocation[] = first !== undefined ? [first] : [];
  return { definition, references, implementations };
}

describe('Q13 LSP boundary coverage', () => {
  it('stubs can cover definition, references and implementations independently', async () => {
    const fixture = await createQualityFixture(['Q13@quality-v1'], signal);
    try {
      for (const taskId of ['Q13-definition', 'Q13-references', 'Q13-implementations']) {
        const task = taskFor(fixture, taskId);
        const adapter = createLspStubAdapter(stubLocationsFor(task));
        const [coverage] = await collectQualityRouteCoverage(task, fixture, { signal, adapter });
        if (coverage === undefined) throw new Error('missing_route_coverage');
        const relevant = coverage.probes.find((probe) => probe.probeId.endsWith(taskId.split('-')[1] ?? ''));
        expect(relevant?.status).toBe('COVERED');
        expect(relevant?.observedStatus).toBe('ok');
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('classifies executed LSP stub evidence as CONTRACT_ONLY, never REAL_LSP_ELIGIBLE', () => {
    expect(classifyCapabilityEvidence({ route: 'lsp_stub', executed: true, ownerApproved: false })).toBe('CONTRACT_ONLY');
    expect(classifyCapabilityEvidence({ route: 'lsp_stub', executed: true, ownerApproved: true })).toBe('CONTRACT_ONLY');
  });

  it('keeps real-server LSP as NOT_RUN without explicit owner approval and executable', () => {
    expect(classifyCapabilityEvidence({ route: 'lsp_real', executed: false, ownerApproved: false })).toBe('NOT_RUN');
    expect(classifyCapabilityEvidence({ route: 'lsp_real', executed: true, ownerApproved: false })).toBe('NOT_RUN');
  });

  it('does not treat truncated or incomplete stub observations as a complete verified set', async () => {
    const fixture = await createQualityFixture(['Q13@quality-v1'], signal);
    try {
      const task = taskFor(fixture, 'Q13-references');
      const adapter = createLspStubAdapter(stubLocationsFor(task), { truncated: true });
      const [coverage] = await collectQualityRouteCoverage(task, fixture, { signal, adapter });
      if (coverage === undefined) throw new Error('missing_route_coverage');
      const referencesProbe = coverage.probes.find((probe) => probe.tool === 'get_references');
      expect(referencesProbe?.status).toBe('COVERED');
      expect(referencesProbe?.observedStatus).toBe('ok');
      const directObservation = await adapter.invoke('get_references', {}, signal, { traceSequence: 1 });
      expect(directObservation.navigation?.truncated).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
