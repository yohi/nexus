import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDiagnosticRun } from '../../../../../scripts/run-performance-diagnostic.mjs';

export const supervisorRunId = '00000000-0000-4000-8000-000000000001';

export async function createPreparedSupervisorRun(roots: string[], prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return prepareDiagnosticRun({ diagnosticsRoot: join(root, 'diagnostics') }, {
    repository: process.cwd(),
    runId: supervisorRunId,
    sourceMetadata: () => Promise.resolve({
      revision: { commit: 'a'.repeat(40), dirty: false },
      environment: { sourceFingerprint: 'b'.repeat(64) },
    }),
  });
}

export function validSupervisorHostGateResult() {
  return Object.freeze({
    status: 'PASS',
    snapshotCount: 3,
    reasonCodes: Object.freeze([]),
    requiredScratchBytes: 5_000_000_000,
    scratchFreeBytes: 8_000_000_000,
    effectiveCpuCapacity: 4,
    monotonicNs: process.hrtime.bigint().toString(),
  });
}

export function supervisorClockProbe(phase: 'start' | 'end') {
  return {
    phase,
    probePid: phase === 'start' ? 4040 : 5050,
    probeStartTicks: phase === 'start' ? '1111' : '2222',
    clockWindow: {
      bootId: 'boot-test',
      parentClockSource: 'time.clock_gettime_ns:CLOCK_MONOTONIC',
      parentResolutionNs: '1',
      childClockSource: 'process.hrtime.bigint',
      childResolutionNs: '1',
      pings: [1, 2, 3].map((value) => ({
        parentSendNs: String(value * 1_000 + 10_000),
        childMonotonicNs: String(value * 1_000),
        parentReceiveNs: String(value * 1_000 + 11_000),
      })),
    },
  };
}

export async function writeCompletedSupervisorWorkerArtifacts(preparedRun: Awaited<ReturnType<typeof createPreparedSupervisorRun>>): Promise<void> {
  await Promise.all([
    writeFile(join(preparedRun.runDirectory, 'diagnostic-status.json'), `${JSON.stringify({
      schemaVersion: 1,
      diagnosticOnly: true,
      runId: supervisorRunId,
      jobId: 'cold_initial_index',
      status: 'completed',
      exitCode: 0,
      diagnosticAdmissible: false,
    })}\n`, { mode: 0o600 }),
    writeFile(join(preparedRun.traceDirectory, 'diagnostic-worker-result.json'), `${JSON.stringify({
      schemaVersion: 1,
      diagnosticOnly: true,
      runId: supervisorRunId,
      jobId: 'cold_initial_index',
      recipeDigest: preparedRun.workerDiagnosticRequest.recipeDigest,
      sourceFingerprint: preparedRun.workerDiagnosticRequest.sourceFingerprint,
      status: 'completed',
      exitCode: 0,
      diagnosticAdmissible: false,
      observerFailure: false,
      traceIncomplete: false,
      scenario: { records: [{ status: 'valid' }] },
    })}\n`, { mode: 0o600 }),
  ]);
}
