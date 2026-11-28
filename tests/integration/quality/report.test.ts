import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildQualityReport, renderQualityMarkdown } from '../../benchmarks/quality/report.js';
import { createQualityFixture, createPrimaryLinkedQualityFixture } from '../../benchmarks/quality/fixtures.js';
import type { OwnedQualityFixture } from '../../benchmarks/quality/fixtures.js';
import { collectQualityRouteCoverage, runQualityPair } from '../../benchmarks/quality/runner.js';
import { QUALITY_CASES_V1 } from '../../benchmarks/quality/manifest.js';
import { sanitizedRgArgv, rgExclusions } from '../../benchmarks/quality/adapters.js';
import type { QualityReportMetadata } from '../../benchmarks/quality/report.js';

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

describe('buildQualityReport integration', () => {
  let outputRoot: string;
  let signal: AbortSignal;
  const controller = new AbortController();

  beforeAll(async () => {
    outputRoot = await mkdtemp(join(tmpdir(), 'nexus-quality-report-'));
    signal = controller.signal;
  });

  afterAll(async () => {
    controller.abort();
    await rm(outputRoot, { recursive: true, force: true });
  });

  it('produces a full report for a core task pair with route coverage', async () => {
    const coreTaskIds = [
      'Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q14',
    ];
    const expectedIds = [
      ...coreTaskIds,
      'Q12-primary', 'Q12-linked',
      'Q13-definition', 'Q13-references', 'Q13-implementations',
    ];

    const ownedFixtures: OwnedQualityFixture[] = [];
    const pairs = [];
    const coverage = [];
    try {
      const coreFixture = await createQualityFixture(coreTaskIds.map((id) => `${id}@quality-v1`), signal);
      ownedFixtures.push(coreFixture);
      const linkedFixture = await createPrimaryLinkedQualityFixture(signal);
      ownedFixtures.push(linkedFixture);
      const lspFixture = await createQualityFixture(['Q13@quality-v1'], signal);
      ownedFixtures.push(lspFixture);

      const taskMap = new Map(QUALITY_CASES_V1.map((t) => [t.taskId, t]));
      for (const taskId of expectedIds) {
        const task = taskMap.get(taskId);
        if (task === undefined) continue;
        const fixture = taskId.startsWith('Q12') ? linkedFixture : taskId.startsWith('Q13') ? lspFixture : coreFixture;
        pairs.push(await runQualityPair(task, fixture, { signal }));
        coverage.push(...(await collectQualityRouteCoverage(task, fixture, { signal })));
      }
    } finally {
      await Promise.all(ownedFixtures.map((fixture) => fixture.dispose()));
    }

    const resolvedOutput = await realpath(outputRoot);
    const metadata: QualityReportMetadata = {
      rgVersion: '13.0.0',
      rgExecutableIdentity: sha256('rg:13.0.0'),
      rgFlags: Object.freeze([...sanitizedRgArgv()]),
      rgExclusions: Object.freeze([...rgExclusions]),
      rgSearchScope: '.',
      rgReadMaxBytesPerCall: 4096,
      rgExecutionContractDigest: sha256(JSON.stringify({ flags: sanitizedRgArgv(), exclusions: rgExclusions })),
      recallK: 10,
      nexusCommit: null,
      nexusConfigDigest: sha256('config'),
      nexusToolRegistryDigest: sha256('registry'),
      profile: 'quality-core-v1',
      fixtureVersion: 'quality-v1',
      fixtureDigest: pairs[0]?.fixtureDigest ?? sha256('fixture'),
      oracleVersion: 'quality-v1',
      oracleDigest: sha256('oracle'),
      manifestDigest: sha256('manifest'),
      policyVersion: 'quality-policy-v1',
      nodeVersion: process.version,
      platform: process.platform,
      tokenizerName: 'cl100k_base',
      tokenizerLibrary: 'js-tiktoken',
      tokenizerVersion: '1.0.21',
      embeddingEvidenceClass: 'FUNCTIONAL_ONLY',
      lspStubVersion: 'quality-lsp-stub-v1',
      runStartedAt: new Date().toISOString(),
      runFinishedAt: new Date().toISOString(),
      semanticEvidence: 'NOT_ESTABLISHED',
      lspEvidence: 'STUB_ONLY',
    };

    const report = buildQualityReport(expectedIds, pairs, coverage, metadata);

    expect(report.schemaVersion).toBe(2);
    expect(report.expectedTaskIds).toEqual(expectedIds);
    expect(report.missingTaskIds).toEqual([]);
    expect(report.pairs.length).toBe(expectedIds.length);
    expect(report.routeCoverage.length).toBeGreaterThan(0);
    expect(report.gate1.status).toBe('SAFETY_FAIL');
    expect(report.gate1.outcomeCounts.WRONG_SOURCE).toBe(0);
    expect(report.gate1.outcomeCounts.FALSE_FRESH).toBe(0);
    expect(report.gate1.expected).toBe(expectedIds.length);
    const typedReport = report as unknown as { gate2: { R: { status: string }; N: { status: string } } };
    const gate2 = typedReport.gate2;
    expect(gate2.R.status).not.toBe('INCOMPLETE');
    expect(gate2.N.status).not.toBe('INCOMPLETE');
    expect(report.gate3.status).toBe('MEASURED');
    expect(report.gate3.byArm.R.expectedTasks).toBe(expectedIds.length);
    expect(report.gate3.byArm.N.expectedTasks).toBe(expectedIds.length);

    const markdown = renderQualityMarkdown(report);
    expect(markdown).toContain('Gate 1');
    expect(markdown).toContain('Gate 2');
    expect(markdown).toContain('Gate 3');
    expect(markdown).not.toContain('/home/');
    expect(markdown).not.toContain(resolvedOutput);

    const serialized = JSON.stringify(report, null, 2);
    expect(serialized).not.toContain('content');
    const parsedReport = JSON.parse(serialized) as { gate2: { R: { recallK: number } } };
    expect(parsedReport.gate2.R.recallK).toBe(10);
  }, 120000);
});
