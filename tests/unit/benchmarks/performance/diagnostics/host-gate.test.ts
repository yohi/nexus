import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { loadHostGate, mediumFixtureSize, resultSchema, smallReport, snapshot, validSnapshots } from './host-gate-fixtures.js';

it('evaluateHostGate_passes_at_the_exact_approved_scratch_and_resource_thresholds', async () => {
  const hostGate = await loadHostGate();
  const result = resultSchema.parse(hostGate.evaluateHostGate(validSnapshots(), smallReport, mediumFixtureSize));

  expect(result).toMatchObject({ status: 'PASS', requiredScratchBytes: 1_298_600_344, scratchFreeBytes: 1_298_600_344 });
});

it('evaluateHostGate_returns_indeterminate_when_snapshot_count_or_spacing_is_insufficient', async () => {
  const hostGate = await loadHostGate();
  const tooFew = hostGate.evaluateHostGate(validSnapshots().slice(0, 2), smallReport, mediumFixtureSize);
  const tooClose = hostGate.evaluateHostGate([
    snapshot('0'), snapshot('20000000000'), snapshot('50000000000'),
  ], smallReport, mediumFixtureSize);

  expect(tooFew.status).toBe('HOST_GATE_INDETERMINATE');
  expect(tooClose.status).toBe('HOST_GATE_INDETERMINATE');
});

it('evaluateHostGate_returns_indeterminate_for_missing_required_data_and_incompatible_small_artifact', async () => {
  const hostGate = await loadHostGate();
  const missingMemoryPressure = validSnapshots().map((sample, index) => index === 1
    ? { ...sample, memoryPressure: undefined }
    : sample);
  const incompleteProcessScan = validSnapshots().map((sample, index) => index === 1
    ? { ...sample, processEnumerationComplete: false }
    : sample);
  const incompatibleSmallReport = { ...smallReport, workload: { ...smallReport.workload, recipeVersion: 'other' } };
  expect(hostGate.evaluateHostGate(missingMemoryPressure, smallReport, mediumFixtureSize).status)
    .toBe('HOST_GATE_INDETERMINATE');
  expect(hostGate.evaluateHostGate(incompleteProcessScan, smallReport, mediumFixtureSize).status)
    .toBe('HOST_GATE_INDETERMINATE');
  expect(hostGate.evaluateHostGate(validSnapshots(), incompatibleSmallReport, mediumFixtureSize).status)
    .toBe('HOST_GATE_INDETERMINATE');
});

it('evaluateHostGate_uses_the_largest_compatible_cold_artifact_for_a_conservative_scratch_estimate', async () => {
  const hostGate = await loadHostGate();
  const smallReportWithRepeatedRuns = {
    ...smallReport,
    scenarios: [11_134_462, 11_134_463, 11_134_464].map((totalBytes) => ({
      id: 'cold_initial_index',
      status: 'valid',
      fixtureDigest: smallReport.workload.digest,
      artifactBytes: { totalBytes, measurement: 'apparent_bytes', phase: 'settled' },
    })),
  };

  const snapshots = validSnapshots().map((sample) => ({ ...sample, scratchFreeBytes: 1_298_600_384 }));
  const result = hostGate.evaluateHostGate(snapshots, smallReportWithRepeatedRuns, mediumFixtureSize);

  expect(result).toMatchObject({ status: 'PASS', requiredScratchBytes: 1_298_600_384 });
});

it('evaluateHostGate_accepts_the_committed_small_report_with_multiple_matching_cold_runs', async () => {
  const hostGate = await loadHostGate();
  const committedSmallReport: unknown = JSON.parse(await readFile(
    resolve(process.cwd(), 'docs/observability/benchmarks/small.json'), 'utf8',
  ));

  const result = hostGate.evaluateHostGate(validSnapshots(), committedSmallReport, mediumFixtureSize);

  expect(result.status).not.toBe('HOST_GATE_INDETERMINATE');
  expect(result.reasonCodes).not.toContain('small_artifact_incompatible');
});

it('evaluateHostGate_returns_indeterminate_when_the_latest_snapshot_is_stale', async () => {
  const hostGate = await loadHostGate();

  const result = hostGate.evaluateHostGate(validSnapshots(), smallReport, mediumFixtureSize, '180000000001');

  expect(result.status).toBe('HOST_GATE_INDETERMINATE');
  expect(result.reasonCodes).toContain('host_snapshots_stale');
});
