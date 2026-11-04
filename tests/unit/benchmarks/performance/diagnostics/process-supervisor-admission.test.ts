import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { prepareDiagnosticRun } from '../../../../../scripts/run-performance-diagnostic.mjs';

type ProcessSupervisorModule = Readonly<{
  executeDiagnosticRun: (preparedRun: unknown, dependencies: unknown) => Promise<unknown>;
}>;

function isProcessSupervisorModule(value: unknown): value is ProcessSupervisorModule {
  return typeof value === 'object' && value !== null
    && 'executeDiagnosticRun' in value && typeof value.executeDiagnosticRun === 'function';
}

async function loadProcessSupervisorModule(): Promise<ProcessSupervisorModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/process-supervisor.mjs')).href;
  const value: unknown = await import(url);
  expect(isProcessSupervisorModule(value)).toBe(true);
  if (!isProcessSupervisorModule(value)) throw new Error('process_supervisor_module_invalid');
  return value;
}

const runId = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];

async function createPreparedRun() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-supervisor-admission-'));
  roots.push(root);
  return await prepareDiagnosticRun({ diagnosticsRoot: join(root, 'diagnostics') }, {
    repository: process.cwd(),
    runId,
    sourceMetadata: () => Promise.resolve({
      revision: { commit: 'a'.repeat(40), dirty: false },
      environment: { sourceFingerprint: 'b'.repeat(64) },
    }),
  });
}

function validHostGateResult() {
  return Object.freeze({
    status: 'PASS',
    snapshotCount: 3,
    reasonCodes: Object.freeze([]),
    requiredScratchBytes: 5_000_000_000,
    scratchFreeBytes: 8_000_000_000,
    effectiveCpuCapacity: 4,
  });
}

function clockProbe(phase: 'start' | 'end') {
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

async function writeCompletedWorkerArtifacts(preparedRun: Awaited<ReturnType<typeof createPreparedRun>>): Promise<void> {
  await Promise.all([
    writeFile(join(preparedRun.runDirectory, 'diagnostic-status.json'), `${JSON.stringify({
      schemaVersion: 1,
      diagnosticOnly: true,
      runId,
      jobId: 'cold_initial_index',
      status: 'completed',
      exitCode: 0,
      diagnosticAdmissible: false,
    })}\n`, { mode: 0o600 }),
    writeFile(join(preparedRun.traceDirectory, 'diagnostic-worker-result.json'), `${JSON.stringify({
      schemaVersion: 1,
      diagnosticOnly: true,
      runId,
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('blocks_worker_start_when_pass_host_gate_omits_resource_evidence', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: { status: 'PASS', snapshotCount: 3, reasonCodes: [] },
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'host_gate_not_pass' });

  expect(starts).toBe(0);
});

it('blocks_worker_start_when_pass_host_gate_claims_insufficient_scratch_headroom', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: {
      ...validHostGateResult(),
      requiredScratchBytes: 8_000_000_000,
      scratchFreeBytes: 5_000_000_000,
    },
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'host_gate_not_pass' });

  expect(starts).toBe(0);
});

it('blocks_admission_when_source_changes_during_evidence_collection', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  const expectedFingerprint = preparedRun.workerDiagnosticRequest.sourceFingerprint;
  let fingerprintReads = 0;
  let evidenceCollections = 0;
  let admissions = 0;

  const result = await module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: expectedFingerprint },
    hostGateResult: validHostGateResult(),
    currentSourceFingerprint: () => {
      fingerprintReads += 1;
      return Promise.resolve(fingerprintReads < 4 ? expectedFingerprint : 'c'.repeat(64));
    },
    clockProbe: (phase: 'start' | 'end') => Promise.resolve(clockProbe(phase)),
    superviseProcess: async () => {
      await writeCompletedWorkerArtifacts(preparedRun);
      return { status: 'completed', exitCode: 0 };
    },
    collectAdmissionEvidence: () => {
      evidenceCollections += 1;
      return Promise.resolve({ evidence: true });
    },
    finalizeAdmission: () => {
      admissions += 1;
      return Promise.resolve({ admissible: true, reasonCodes: [] });
    },
  });

  expect(result).toMatchObject({ status: 'failed', reasonCode: 'source_fingerprint_mismatch' });
  expect(fingerprintReads).toBe(4);
  expect(evidenceCollections).toBe(1);
  expect(admissions).toBe(0);
  await expect(readFile(join(preparedRun.runDirectory, 'supervisor-final-status.json'), 'utf8'))
    .resolves.toMatch(/source_changed/);
});

it('does_not_report_completion_when_admission_rejects_the_collected_evidence', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  const expectedFingerprint = preparedRun.workerDiagnosticRequest.sourceFingerprint;
  const rejectedSummary = {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: preparedRun.runId,
    jobId: 'cold_initial_index',
    admissible: false,
    reasonCodes: ['storage_integrity_unverified'],
    storageIntegrityStatus: 'unknown',
    workerPid: null,
    profileSegments: 0,
    selfSamples: 0,
  };

  const result = await module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: expectedFingerprint },
    hostGateResult: validHostGateResult(),
    currentSourceFingerprint: () => Promise.resolve(expectedFingerprint),
    clockProbe: (phase: 'start' | 'end') => Promise.resolve(clockProbe(phase)),
    superviseProcess: async () => {
      await writeCompletedWorkerArtifacts(preparedRun);
      return { status: 'completed', exitCode: 0 };
    },
    collectAdmissionEvidence: () => Promise.resolve({ evidence: true }),
    finalizeAdmission: () => Promise.resolve(rejectedSummary),
  });

  expect(result).toMatchObject({ status: 'failed', reasonCode: 'storage_integrity_unverified' });
  expect(result).toMatchObject({ diagnosticSummary: { admissible: false } });
  const finalStatus: unknown = JSON.parse(await readFile(join(preparedRun.runDirectory, 'supervisor-final-status.json'), 'utf8'));
  expect(finalStatus).toMatchObject({
    status: 'failed',
    workerStatus: 'completed',
    cleanupStatus: 'verified',
    remainingProcessCount: 0,
    diagnosticAdmissible: false,
    reasonCodes: ['storage_integrity_unverified'],
  });
});
