import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { runQualitySuite } from '../../benchmarks/quality/report.js';

describe('runQualitySuite integration', () => {
  it('runs the quality-issue320-v1 suite and writes JSON/Markdown/SHA256SUMS', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'nexus-quality-suite-'));
    const controller = new AbortController();

    try {
      const result = await runQualitySuite({
        suiteId: 'quality-issue320-v1',
        outputRoot,
        rgExecutable: 'rg',
        signal: controller.signal,
      });

      expect(result.suiteId).toBe('quality-issue320-v1');
      expect(result.expectedTaskIds).toHaveLength(17);
      expect(Object.keys(result.reports)).toEqual(
        expect.arrayContaining(['quality-core-v1', 'quality-worktree-v1', 'quality-lsp-v1']),
      );

      const resolvedOutput = await realpath(outputRoot);
      expect(result.outputPaths.json.startsWith(resolvedOutput)).toBe(true);
      expect(result.outputPaths.markdown.startsWith(resolvedOutput)).toBe(true);
      expect(result.outputPaths.sha256sums.startsWith(resolvedOutput)).toBe(true);

      expect(['SAFETY_PASS', 'SAFETY_FAIL', 'INCOMPLETE']).toContain(result.aggregateStatus);

      for (const report of Object.values(result.reports)) {
        expect(report.schemaVersion).toBe(1);
        expect(report.metadata.profile).toBe(report.profile);
        expect(report.metadata.fixtureDigest).toBe(report.fixtureDigest);
        expect(report.metadata.policyVersion).toBe(report.policyVersion);
        expect(report.metadata.recallK).toBe(10);
        expect(report.metadata.rgSearchScope).toBe('.');
        expect(report.metadata.rgReadMaxBytesPerCall).toBe(4096);
        expect(report.metadata.rgExclusions).toHaveLength(6);
        expect(report.pairs.length).toBeGreaterThanOrEqual(0);
      }
    } finally {
      controller.abort();
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
