import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { collectDiagnosticAdmissionEvidence } from './diagnostic-admission-collector.mjs';
import { finalizeDiagnosticRun, writeDiagnosticFailureSummary } from './diagnostic-admission.mjs';
import { diagnosticWorkerResultSchema } from './diagnostic-worker-result-contract.mjs';
import { verifyPreparedDiagnosticRun } from './prepared-diagnostic-run.mjs';
import { writeSupervisorFinalStatus, writeSupervisorRunStatus } from './diagnostic-supervisor-status.mjs';
import {
  calibrateClockProbeResults,
  clockProbeResultSchema,
  runClockConformanceProbe,
} from './clock-conformance-probe.mjs';
import { superviseDiagnosticProcess } from './process-supervisor-process.mjs';
import { diagnosticSourceFingerprint } from './source-fingerprint.mjs';
import { passedHostGateResultSchema } from './host-gate-inputs.mjs';
import {
  bootstrapStatusSchema,
  DiagnosticBootstrapError,
  readPrivateJson,
  writePrivateJson,
} from './diagnostic-vitest-bootstrap-control.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bootstrapPath = join(dirname(fileURLToPath(import.meta.url)), 'diagnostic-vitest-bootstrap.mjs');
const MAX_HOST_SNAPSHOT_AGE_NS = 120_000_000_000n;
const sourceGateResultSchema = z.object({
  status: z.literal('PASS'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
async function readCurrentSourceFingerprint(dependencies) {
  const readFingerprint = dependencies.currentSourceFingerprint
    ?? (async () => (await diagnosticSourceFingerprint(dependencies.repository ?? repository)).digest);
  try {
    return await readFingerprint();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return undefined;
  }
}

async function persistFailure({ prepared, diagnosticRequest, reasonCode, status, workerStatus,
  workerExitCode, cleanupStatus, remainingProcessCount }) {
  const diagnosticSummary = await writeDiagnosticFailureSummary(prepared.runDirectory, prepared.runId, reasonCode);
  await writeSupervisorFinalStatus(prepared, diagnosticRequest, {
    status, workerStatus, workerExitCode, cleanupStatus, remainingProcessCount, diagnosticSummary,
  });
  return diagnosticSummary;
}

async function captureStartClock(prepared, clockProbe) {
  try {
    const clockStart = clockProbeResultSchema.parse(await clockProbe('start'));
    if (clockStart.phase !== 'start') throw new DiagnosticBootstrapError('clock_probe_start_phase_invalid');
    await writePrivateJson(join(prepared.runDirectory, 'clock-start.json'), prepared.runDirectory, clockStart);
    return { clockStart };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { failed: true };
  }
}

function createWorkerEnvironment(prepared, diagnosticRequest) {
  return {
    ...process.env,
    NEXUS_PERF_REQUEST_FILE: prepared.workerRequestFile,
    NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE: prepared.workerDiagnosticRequestFile,
    NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE: join(diagnosticRequest.runDirectory, 'profile-request.json'),
    NEXUS_PERF_SUPERVISOR_START_REQUIRED: '1',
  };
}

function isWorkerResultValid(status, result, prepared, diagnosticRequest) {
  return status.status === 'completed' && status.exitCode === 0 && status.runId === prepared.runId
    && result.runId === prepared.runId && result.recipeDigest === diagnosticRequest.recipeDigest
    && result.sourceFingerprint === diagnosticRequest.sourceFingerprint && result.diagnosticAdmissible === false
    && result.status === 'completed' && result.exitCode === 0 && !result.observerFailure && !result.traceIncomplete
    && result.scenario.records.every((record) => record.status === 'valid');
}

async function finishCompletedWorker(validated, dependencies, clockStart, processResult) {
  const { prepared, diagnosticRequest } = validated;
  const { sourceGateResult, hostGateResult } = dependencies;
  const clockProbe = dependencies.clockProbe ?? runClockConformanceProbe;
  try {
    let clockMapping;
    try {
      const clockEnd = clockProbeResultSchema.parse(await clockProbe('end'));
      if (clockEnd.phase !== 'end') throw new DiagnosticBootstrapError('clock_probe_end_phase_invalid');
      await writePrivateJson(join(prepared.runDirectory, 'clock-end.json'), prepared.runDirectory, clockEnd);
      clockMapping = await calibrateClockProbeResults(clockStart, clockEnd);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      clockMapping = Object.freeze({ status: 'not_correlatable', reasonCode: 'clock_probe_end_failed' });
    }
    const statusFile = join(prepared.runDirectory, 'diagnostic-status.json');
    const resultFile = join(diagnosticRequest.runDirectory, 'diagnostic-worker-result.json');
    const [statusValue, resultValue] = await Promise.all([
      readPrivateJson(statusFile, prepared.runDirectory),
      readPrivateJson(resultFile, diagnosticRequest.runDirectory),
    ]);
    const status = bootstrapStatusSchema.parse(statusValue);
    const result = diagnosticWorkerResultSchema.parse(resultValue);
    if (!isWorkerResultValid(status, result, prepared, diagnosticRequest)) {
      const reasonCode = 'diagnostic_worker_result_invalid';
      const diagnosticSummary = await persistFailure({
        prepared, diagnosticRequest, reasonCode, status: 'failed', workerStatus: 'invalid',
        workerExitCode: status.exitCode, cleanupStatus: 'verified', remainingProcessCount: 0,
      });
      return Object.freeze({ status: 'failed', reasonCode, diagnosticSummary });
    }
    const collectEvidence = dependencies.collectAdmissionEvidence ?? collectDiagnosticAdmissionEvidence;
    const finalize = dependencies.finalizeAdmission ?? finalizeDiagnosticRun;
    const evidence = await collectEvidence({
      runId: prepared.runId,
      runDirectory: prepared.runDirectory,
      traceDirectory: diagnosticRequest.runDirectory,
      sourceGate: sourceGateResult,
      hostGate: hostGateResult,
      clockMapping,
      cleanupStatus: processResult.status === 'completed' ? 'verified' : 'unverified',
      supervisorProcessSamples: processResult.processCpuSamples ?? [],
    });
    const sourceFingerprintBeforeAdmission = await readCurrentSourceFingerprint(dependencies);
    if (sourceFingerprintBeforeAdmission === undefined
      || sourceFingerprintBeforeAdmission !== sourceGateResult.digest
      || sourceFingerprintBeforeAdmission !== diagnosticRequest.sourceFingerprint) {
      const reasonCode = 'source_fingerprint_mismatch';
      const diagnosticSummary = await persistFailure({
        prepared, diagnosticRequest, reasonCode, status: 'failed', workerStatus: 'source_changed',
        workerExitCode: processResult.exitCode ?? null, cleanupStatus: 'verified', remainingProcessCount: 0,
      });
      return Object.freeze({ status: 'failed', reasonCode, diagnosticSummary });
    }
    const finalization = Object.freeze({
      schemaVersion: 1,
      diagnosticOnly: true,
      runId: prepared.runId,
      sourceFingerprint: diagnosticRequest.sourceFingerprint,
      recipeDigest: diagnosticRequest.recipeDigest,
      workerStatus: 'completed',
      workerExitCode: 0,
      cleanupStatus: 'verified',
      remainingProcessCount: 0,
      finalizedByPid: process.pid,
    });
    const diagnosticSummary = await finalize(evidence, finalization);
    if (diagnosticSummary.admissible !== true) {
      const reasonCode = diagnosticSummary.reasonCodes[0] ?? 'diagnostic_worker_result_invalid';
      await writeSupervisorFinalStatus(prepared, diagnosticRequest, {
        status: 'failed', workerStatus: 'completed', workerExitCode: processResult.exitCode ?? null,
        cleanupStatus: 'verified', remainingProcessCount: 0, diagnosticSummary,
      });
      return Object.freeze({ status: 'failed', reasonCode, diagnosticSummary });
    }
    await writeSupervisorFinalStatus(prepared, diagnosticRequest, {
      status: 'finalized', workerStatus: 'completed', workerExitCode: 0,
      cleanupStatus: 'verified', remainingProcessCount: 0, diagnosticSummary,
    });
    return Object.freeze({ status: 'completed', diagnosticSummary });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const reasonCode = error instanceof DiagnosticBootstrapError || error instanceof z.ZodError
      ? 'diagnostic_worker_result_invalid'
      : 'diagnostic_evidence_error';
    const diagnosticSummary = await persistFailure({
      prepared, diagnosticRequest, reasonCode, status: 'failed', workerStatus: 'invalid',
      workerExitCode: 1, cleanupStatus: 'verified', remainingProcessCount: 0,
    });
    return Object.freeze({ status: 'failed', reasonCode, diagnosticSummary });
  }
}

export async function executeDiagnosticRun(preparedRun, dependencies = {}) {
  if (dependencies.executionMode !== true) return Object.freeze({ status: 'preflight_only' });
  const parsedSourceGate = sourceGateResultSchema.safeParse(dependencies.sourceGateResult);
  if (!parsedSourceGate.success) {
    return Object.freeze({ status: 'gate_blocked', reasonCode: 'source_gate_not_pass' });
  }
  const sourceGateResult = Object.freeze(parsedSourceGate.data);
  const parsedHostGate = passedHostGateResultSchema.safeParse(dependencies.hostGateResult);
  if (!parsedHostGate.success) {
    return Object.freeze({ status: 'gate_blocked', reasonCode: 'host_gate_not_pass' });
  }
  const hostGateResult = Object.freeze({
    ...parsedHostGate.data,
    reasonCodes: Object.freeze([...parsedHostGate.data.reasonCodes]),
  });

  let validated;
  try {
    validated = await verifyPreparedDiagnosticRun(preparedRun);
  } catch (error) {
    if (error instanceof DiagnosticBootstrapError) {
      return Object.freeze({ status: 'gate_blocked', reasonCode: error.code });
    }
    if (error instanceof z.ZodError) {
      return Object.freeze({ status: 'gate_blocked', reasonCode: 'prepared_run_invalid' });
    }
    throw error;
  }

  if (sourceGateResult.digest !== validated.diagnosticRequest.sourceFingerprint) {
    return Object.freeze({ status: 'gate_blocked', reasonCode: 'source_fingerprint_mismatch' });
  }
  const currentFingerprint = await readCurrentSourceFingerprint(dependencies);
  if (currentFingerprint === undefined || currentFingerprint !== sourceGateResult.digest) {
    return Object.freeze({ status: 'gate_blocked', reasonCode: 'source_fingerprint_mismatch' });
  }

  const startWorker = dependencies.startWorker ?? defaultStartWorker;
  const executionDependencies = Object.freeze({ ...dependencies, sourceGateResult, hostGateResult });
  const result = await startWorker(validated, executionDependencies);
  return typeof result === 'string' ? Object.freeze({ status: result }) : result;
}

export async function defaultStartWorker(validated, dependencies = {}) {
  const { prepared, scenarioRequest, diagnosticRequest } = validated;
  const { sourceGateResult } = dependencies;
  const remainingMs = scenarioRequest.timeoutMs;
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
    return Object.freeze({ status: 'gate_blocked', reasonCode: 'diagnostic_deadline_expired' });
  }
  await writeSupervisorRunStatus(prepared, diagnosticRequest);
  const clockProbe = dependencies.clockProbe ?? runClockConformanceProbe;
  const clockStartResult = await captureStartClock(prepared, clockProbe);
  if (clockStartResult.failed === true) {
    const reasonCode = 'clock_probe_start_failed';
    const diagnosticSummary = await persistFailure({
      prepared, diagnosticRequest, reasonCode,
      status: 'failed', workerStatus: 'not_started', workerExitCode: null,
      cleanupStatus: 'verified', remainingProcessCount: 0,
    });
    return Object.freeze({ status: 'gate_blocked', reasonCode, diagnosticSummary });
  }
  const { clockStart } = clockStartResult;
  const workerEnvironment = createWorkerEnvironment(prepared, diagnosticRequest);
  const superviseProcess = dependencies.superviseProcess ?? superviseDiagnosticProcess;
  const sourceFingerprintBeforeSpawn = await readCurrentSourceFingerprint(dependencies);
  if (sourceFingerprintBeforeSpawn === undefined
    || sourceFingerprintBeforeSpawn !== sourceGateResult.digest) {
    const reasonCode = 'source_fingerprint_mismatch';
    const diagnosticSummary = await persistFailure({
      prepared, diagnosticRequest, reasonCode, status: 'failed', workerStatus: 'not_started',
      workerExitCode: null, cleanupStatus: 'verified', remainingProcessCount: 0,
    });
    return Object.freeze({ status: 'gate_blocked', reasonCode, diagnosticSummary });
  }
  const snapshotAgeNs = process.hrtime.bigint() - BigInt(dependencies.hostGateResult.monotonicNs);
  if (snapshotAgeNs < 0n || snapshotAgeNs > MAX_HOST_SNAPSHOT_AGE_NS) {
    return Object.freeze({ status: 'gate_blocked', reasonCode: 'host_snapshots_stale' });
  }
  const processResult = await superviseProcess({
    command: process.execPath,
    args: [bootstrapPath],
    cwd: dependencies.repository ?? repository,
    environment: workerEnvironment,
    timeoutMs: remainingMs,
    termGraceMs: dependencies.termGraceMs ?? 5_000,
    startGateRequired: true,
    runId: prepared.runId,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  }, dependencies.processServices);
  if (processResult.status === 'cleanup_unverified') {
    const diagnosticSummary = await persistFailure({
      prepared, diagnosticRequest, reasonCode: 'cleanup_unverified', status: 'cleanup_unverified',
      workerStatus: 'unknown', workerExitCode: processResult.exitCode ?? null,
      cleanupStatus: 'unverified', remainingProcessCount: 1,
    });
    return Object.freeze({ ...processResult, diagnosticSummary });
  }
  if (processResult.status !== 'completed') {
    const reasonCode = processResult.reasonCode === 'timeout' ? 'diagnostic_worker_timeout' : 'diagnostic_worker_failed';
    const diagnosticSummary = await persistFailure({
      prepared, diagnosticRequest, reasonCode, status: 'failed', workerStatus: 'failed',
      workerExitCode: processResult.exitCode ?? null, cleanupStatus: 'verified', remainingProcessCount: 0,
    });
    return Object.freeze({ status: 'failed', reasonCode, diagnosticSummary });
  }

  const sourceFingerprintAfterRun = await readCurrentSourceFingerprint(dependencies);
  if (sourceFingerprintAfterRun === undefined || sourceFingerprintAfterRun !== sourceGateResult.digest) {
    const reasonCode = 'source_fingerprint_mismatch';
    const diagnosticSummary = await persistFailure({
      prepared, diagnosticRequest, reasonCode, status: 'failed', workerStatus: 'source_changed',
      workerExitCode: processResult.exitCode ?? null, cleanupStatus: 'verified', remainingProcessCount: 0,
    });
    return Object.freeze({ status: 'failed', reasonCode, diagnosticSummary });
  }

  return finishCompletedWorker(validated, dependencies, clockStart, processResult);
}
