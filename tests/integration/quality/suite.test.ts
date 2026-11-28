import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runQualitySuite } from '../../benchmarks/quality/report.js';

describe('runQualitySuite integration', () => {
  it('runs the quality-issue320-v1 suite and writes JSON/Markdown/SHA256SUMS', async () => {
    const configuredSuite = process.env.NEXUS_QUALITY_SUITE ?? 'quality-issue320-v1';
    if (configuredSuite !== 'quality-issue320-v1') throw new Error('unsupported_suite_id');
    const configuredOutputRoot = process.env.NEXUS_QUALITY_OUTPUT_ROOT;
    const ownsOutputRoot = configuredOutputRoot === undefined;
    const outputRoot = configuredOutputRoot ?? await mkdtemp(join(tmpdir(), 'nexus-quality-suite-'));
    const controller = new AbortController();

    try {
      const result = await runQualitySuite({
        suiteId: configuredSuite,
        outputRoot,
        rgExecutable: 'rg',
        signal: controller.signal,
      });

      expect(result.suiteId).toBe('quality-issue320-v1');
      expect(result.expectedTaskIds).toHaveLength(17);
      expect(Object.keys(result.reports)).toEqual(
        expect.arrayContaining(['quality-core-v1', 'quality-worktree-v1', 'quality-lsp-v1']),
      );
      expect(result.reports['quality-core-v1'].expectedTaskIds).toEqual([
        'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q14',
      ]);
      expect(result.reports['quality-worktree-v1'].expectedTaskIds).toEqual(['Q12-primary', 'Q12-linked']);
      expect(result.reports['quality-lsp-v1'].expectedTaskIds).toEqual([
        'Q13-definition', 'Q13-references', 'Q13-implementations',
      ]);
      expect(result.reports['quality-core-v1'].missingTaskIds).not.toContain('Q12-primary');
      expect(result.reports['quality-core-v1'].missingTaskIds).not.toContain('Q13-definition');
      expect(result.reports['quality-worktree-v1'].missingTaskIds).not.toContain('Q01');
      expect(result.reports['quality-lsp-v1'].missingTaskIds).not.toContain('Q01');

      const resolvedOutput = await realpath(outputRoot);
      expect(result.outputPaths.json.startsWith(resolvedOutput)).toBe(true);
      expect(result.outputPaths.markdown.startsWith(resolvedOutput)).toBe(true);
      expect(result.outputPaths.sha256sums.startsWith(resolvedOutput)).toBe(true);

      const stored = JSON.parse(await readFile(result.outputPaths.json, 'utf8')) as {
        outputPaths: { json: string; markdown: string; sha256sums: string };
        reports: Record<string, { rgVersion: string; pairs: Array<{ armFixtureDigests: { R: string; N: string } }> }>;
      };
      expect(stored.outputPaths).toEqual({
        json: basename(result.outputPaths.json),
        markdown: basename(result.outputPaths.markdown),
        sha256sums: basename(result.outputPaths.sha256sums),
      });
      expect(JSON.stringify(stored)).not.toContain(resolvedOutput);
      for (const report of Object.values(stored.reports)) {
        expect(report.rgVersion).toMatch(/^ripgrep \d/);
      }
      for (const pair of stored.reports['quality-worktree-v1']?.pairs ?? []) {
        expect(pair.armFixtureDigests.R).toBeTruthy();
        expect(pair.armFixtureDigests.N).toBeTruthy();
      }

      expect(['SAFETY_PASS', 'SAFETY_FAIL', 'INCOMPLETE']).toContain(result.aggregateStatus);

      for (const report of Object.values(result.reports)) {
        expect(report.schemaVersion).toBe(2);
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
      if (ownsOutputRoot) await rm(outputRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
