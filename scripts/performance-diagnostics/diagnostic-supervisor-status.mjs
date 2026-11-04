import { join } from 'node:path';
import { writePrivateJson } from './diagnostic-vitest-bootstrap-control.mjs';

export async function writeSupervisorRunStatus(prepared, diagnosticRequest) {
  await writePrivateJson(join(prepared.runDirectory, 'supervisor-status.json'), prepared.runDirectory, {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: prepared.runId,
    sourceFingerprint: diagnosticRequest.sourceFingerprint,
    recipeDigest: diagnosticRequest.recipeDigest,
    status: 'running',
    supervisorPid: process.pid,
  });
}

export async function writeSupervisorFinalStatus(prepared, diagnosticRequest, outcome) {
  await writePrivateJson(join(prepared.runDirectory, 'supervisor-final-status.json'), prepared.runDirectory, {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: prepared.runId,
    sourceFingerprint: diagnosticRequest.sourceFingerprint,
    recipeDigest: diagnosticRequest.recipeDigest,
    status: outcome.status,
    workerStatus: outcome.workerStatus,
    workerExitCode: outcome.workerExitCode,
    cleanupStatus: outcome.cleanupStatus,
    remainingProcessCount: outcome.remainingProcessCount,
    diagnosticAdmissible: outcome.diagnosticSummary.admissible,
    storageIntegrityStatus: outcome.diagnosticSummary.storageIntegrityStatus ?? 'unknown',
    reasonCodes: outcome.diagnosticSummary.reasonCodes,
    finalizedByPid: process.pid,
  });
}
