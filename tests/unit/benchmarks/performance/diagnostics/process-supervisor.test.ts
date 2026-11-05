import { readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  createPreparedSupervisorRun,
  supervisorClockProbe,
  supervisorRunId as runId,
  validSupervisorHostGateResult as passHostGateResult,
  writeCompletedSupervisorWorkerArtifacts,
} from './supervisor-admission-fixtures.js';

type DiagnosticRunStatus = 'preflight_only' | 'gate_blocked' | 'completed' | 'cleanup_unverified';
type SupervisedWorkerInput = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  startGateRequired?: boolean;
  runId?: string;
}>;
type ProcessSupervisorModule = Readonly<{
  executeDiagnosticRun: (
    preparedRun: Readonly<{ runId: string; runDirectory: string; workerRequestFile: string; workerDiagnosticRequestFile: string }>,
    dependencies?: Readonly<{
      executionMode?: boolean;
      sourceGateResult?: Readonly<{ status: string; digest?: string }>;
      hostGateResult?: Readonly<{
        status: string;
        snapshotCount?: number;
        reasonCodes?: readonly string[];
        requiredScratchBytes?: number;
        scratchFreeBytes?: number;
        effectiveCpuCapacity?: number;
        monotonicNs?: string;
      }>;
      currentSourceFingerprint?: () => Promise<string>;
      startWorker?: () => Promise<DiagnosticRunStatus>;
      superviseProcess?: (input: SupervisedWorkerInput) => Promise<Readonly<{ status: 'completed' | 'failed' | 'cleanup_unverified'; exitCode?: number | null }>>;
      clockProbe?: (phase: 'start' | 'end') => Promise<unknown>;
      collectAdmissionEvidence?: (input: unknown) => Promise<unknown>;
      finalizeAdmission?: (
        evidence: unknown,
        finalization?: unknown,
      ) => Promise<Readonly<{ admissible: boolean; reasonCodes: readonly string[] }>>;
    }>,
  ) => Promise<Readonly<{ status: DiagnosticRunStatus; reasonCode?: string }>>;
}>;

function isProcessSupervisorModule(value: unknown): value is ProcessSupervisorModule {
  return typeof value === 'object' && value !== null
    && 'executeDiagnosticRun' in value && typeof value.executeDiagnosticRun === 'function'
    && 'defaultStartWorker' in value && typeof value.defaultStartWorker === 'function';
}

async function loadProcessSupervisorModule(): Promise<ProcessSupervisorModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/process-supervisor.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isProcessSupervisorModule(loaded)).toBe(true);
  if (!isProcessSupervisorModule(loaded)) throw new Error('process_supervisor_module_missing');
  return loaded;
}

const roots: string[] = [];
const createPreparedRun = () => createPreparedSupervisorRun(roots, 'nexus-supervisor-preflight-');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('defaults_to_preflight_without_starting_a_worker', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toEqual({ status: 'preflight_only' });

  expect(starts).toBe(0);
});

it('blocks_execution_when_either_source_or_host_gate_is_not_pass', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: { status: 'HOST_BUSY_STOP' },
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'host_gate_not_pass' });

  expect(starts).toBe(0);
});

it('starts_only_after_explicit_mode_and_both_gates_pass', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: passHostGateResult(),
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toEqual({ status: 'completed' });

  expect(starts).toBe(1);
});

it('blocks_worker_start_when_host_snapshot_is_stale_before_spawn', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: { ...passHostGateResult(), monotonicNs: '0' },
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    clockProbe: (phase) => Promise.resolve(supervisorClockProbe(phase)),
    superviseProcess: () => { starts += 1; return Promise.resolve({ status: 'completed', exitCode: 0 }); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'host_snapshots_stale' });

  expect(starts).toBe(0);
});

it('blocks_worker_start_when_host_gate_pass_lacks_three_clean_snapshots', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: { status: 'PASS' },
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'host_gate_not_pass' });

  expect(starts).toBe(0);
});

it('blocks_worker_start_when_current_source_changed_after_the_source_gate', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: passHostGateResult(),
    currentSourceFingerprint: () => Promise.resolve('c'.repeat(64)),
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'source_fingerprint_mismatch' });

  expect(starts).toBe(0);
});

it('rechecks_source_fingerprint_after_worker_preparation_and_before_process_spawn', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  const expectedFingerprint = preparedRun.workerDiagnosticRequest.sourceFingerprint;
  let fingerprintReads = 0;
  let supervisorStarts = 0;

  const result = await module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: expectedFingerprint },
    hostGateResult: passHostGateResult(),
    currentSourceFingerprint: () => {
      fingerprintReads += 1;
      return Promise.resolve(fingerprintReads === 1 ? expectedFingerprint : 'c'.repeat(64));
    },
    clockProbe: (phase) => Promise.resolve({
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
    }),
    superviseProcess: () => {
      supervisorStarts += 1;
      return Promise.resolve({ status: 'failed' });
    },
  });

  expect(result).toMatchObject({ status: 'gate_blocked', reasonCode: 'source_fingerprint_mismatch' });
  expect(fingerprintReads).toBe(2);
  expect(supervisorStarts).toBe(0);
});

it('rejects_a_completed_worker_when_source_changes_during_the_run', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let fingerprintReads = 0;
  let evidenceCollections = 0;
  const expectedFingerprint = preparedRun.workerDiagnosticRequest.sourceFingerprint;

  const result = await module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: expectedFingerprint },
    hostGateResult: passHostGateResult(),
    currentSourceFingerprint: () => {
      fingerprintReads += 1;
      return Promise.resolve(fingerprintReads <= 2 ? expectedFingerprint : 'c'.repeat(64));
    },
    clockProbe: (phase) => Promise.resolve({
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
    }),
    superviseProcess: () => Promise.resolve({ status: 'completed', exitCode: 0 }),
    collectAdmissionEvidence: () => { evidenceCollections += 1; return Promise.resolve({}); },
    finalizeAdmission: () => Promise.resolve({ admissible: false, reasonCodes: ['unexpected_finalization'] }),
  });

  expect(result).toMatchObject({ status: 'failed', reasonCode: 'source_fingerprint_mismatch' });
  expect(fingerprintReads).toBe(3);
  expect(evidenceCollections).toBe(0);
});

it('blocks_execution_when_source_gate_digest_does_not_match_the_prepared_request', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  let starts = 0;

  await expect(module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: 'c'.repeat(64) },
    hostGateResult: passHostGateResult(),
    startWorker: () => { starts += 1; return Promise.resolve('completed'); },
  })).resolves.toMatchObject({ status: 'gate_blocked', reasonCode: 'source_fingerprint_mismatch' });

  expect(starts).toBe(0);
});

it('finalizes_admission_after_a_successful_supervised_worker_without_running_a_worker_in_the_test', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  const expectedEvidence = Object.freeze({ diagnosticOnly: true, runId });
  const expectedSummary = Object.freeze({ admissible: true, reasonCodes: Object.freeze([]) });
  const order: string[] = [];

  const result = await module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: passHostGateResult(),
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    clockProbe: (phase) => {
      order.push(`clock-${phase}`);
      return Promise.resolve(supervisorClockProbe(phase));
    },
    superviseProcess: async (input) => {
      order.push('supervisor');
      expect(JSON.parse(await readFile(join(preparedRun.runDirectory, 'supervisor-status.json'), 'utf8')))
        .toMatchObject({ status: 'running', runId, supervisorPid: process.pid });
      expect(input.environment.NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE)
        .toBe(join(preparedRun.traceDirectory, 'profile-request.json'));
      expect(input.environment.NEXUS_PERF_SUPERVISOR_START_REQUIRED).toBe('1');
      expect(input).toMatchObject({ startGateRequired: true, runId });
      await writeCompletedSupervisorWorkerArtifacts(preparedRun);
      return { status: 'completed', exitCode: 0 };
    },
    collectAdmissionEvidence: (input) => {
      order.push('collect');
      if (typeof input !== 'object' || input === null || !('clockMapping' in input)) {
        throw new Error('clock_mapping_not_forwarded_to_admission');
      }
      expect(input.clockMapping).toMatchObject({ status: 'aligned', clockDomain: 'linux_clock_monotonic_ns' });
      return Promise.resolve(expectedEvidence);
    },
    finalizeAdmission: (evidence, finalization) => {
      order.push('finalize');
      expect(evidence).toBe(expectedEvidence);
      expect(finalization).toMatchObject({
        schemaVersion: 1,
        diagnosticOnly: true,
        runId,
        sourceFingerprint: preparedRun.workerDiagnosticRequest.sourceFingerprint,
        recipeDigest: preparedRun.workerDiagnosticRequest.recipeDigest,
        workerStatus: 'completed',
        workerExitCode: 0,
        cleanupStatus: 'verified',
        remainingProcessCount: 0,
        finalizedByPid: process.pid,
      });
      return Promise.resolve(expectedSummary);
    },
  });

  expect(result).toMatchObject({ status: 'completed', diagnosticSummary: expectedSummary });
  expect(order).toEqual(['clock-start', 'supervisor', 'clock-end', 'collect', 'finalize']);
  const finalStatusPath = join(preparedRun.runDirectory, 'supervisor-final-status.json');
  expect(JSON.parse(await readFile(finalStatusPath, 'utf8'))).toMatchObject({
    status: 'finalized',
    diagnosticAdmissible: true,
    reasonCodes: [],
    finalizedByPid: process.pid,
  });
  expect((await stat(finalStatusPath)).mode & 0o777).toBe(0o600);
});

it('writes_a_private_non_admissible_summary_when_supervisor_cleanup_is_unverified', async () => {
  const module = await loadProcessSupervisorModule();
  const preparedRun = await createPreparedRun();
  const clockProbe = (phase: 'start' | 'end') => Promise.resolve(supervisorClockProbe(phase));

  const result = await module.executeDiagnosticRun(preparedRun, {
    executionMode: true,
    sourceGateResult: { status: 'PASS', digest: preparedRun.workerDiagnosticRequest.sourceFingerprint },
    hostGateResult: passHostGateResult(),
    currentSourceFingerprint: () => Promise.resolve(preparedRun.workerDiagnosticRequest.sourceFingerprint),
    clockProbe,
    superviseProcess: () => Promise.resolve({ status: 'cleanup_unverified', reasonCode: 'cleanup_unverified' }),
  });

  expect(result).toMatchObject({
    status: 'cleanup_unverified',
    diagnosticSummary: { admissible: false, reasonCodes: ['cleanup_unverified'] },
  });
  const summaryPath = join(preparedRun.runDirectory, 'diagnostic-summary.json');
  expect(JSON.parse(await readFile(summaryPath, 'utf8'))).toMatchObject({
    admissible: false, reasonCodes: ['cleanup_unverified'],
  });
  expect((await stat(summaryPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(preparedRun.runDirectory, 'supervisor-final-status.json'), 'utf8')))
    .toMatchObject({ status: 'cleanup_unverified', diagnosticAdmissible: false, finalizedByPid: process.pid });
});
