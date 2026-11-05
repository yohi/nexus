import { join } from 'node:path';
import { z } from 'zod';
import {
  DiagnosticBootstrapError,
  diagnosticRequestSchema,
  ensurePathAbsent,
  inside,
  readPrivateJson,
  scenarioRequestSchema,
  verifyOwnedDirectory,
} from './diagnostic-vitest-bootstrap-control.mjs';

const preparedRunSchema = z.object({
  runId: z.string().uuid(),
  diagnosticOnly: z.literal(true),
  runDirectory: z.string().min(1),
  traceDirectory: z.string().min(1),
  workerRequestFile: z.string().min(1),
  workerDiagnosticRequestFile: z.string().min(1),
}).passthrough();

export async function verifyPreparedDiagnosticRun(value) {
  const prepared = preparedRunSchema.parse(value);
  await verifyOwnedDirectory(prepared.runDirectory);
  await verifyOwnedDirectory(prepared.traceDirectory);
  if (!inside(prepared.runDirectory, prepared.traceDirectory)
    || !inside(prepared.runDirectory, prepared.workerRequestFile)
    || !inside(prepared.runDirectory, prepared.workerDiagnosticRequestFile)) {
    throw new DiagnosticBootstrapError('prepared_run_paths_invalid');
  }
  const [scenarioRequest, diagnosticRequest] = await Promise.all([
    readPrivateJson(prepared.workerRequestFile, prepared.runDirectory).then((request) => scenarioRequestSchema.parse(request)),
    readPrivateJson(prepared.workerDiagnosticRequestFile, prepared.runDirectory).then((request) => diagnosticRequestSchema.parse(request)),
  ]);
  if (prepared.runId !== scenarioRequest.runId || scenarioRequest.runId !== diagnosticRequest.runId
    || scenarioRequest.ownerRoot !== prepared.runDirectory || diagnosticRequest.runDirectory !== prepared.traceDirectory
    || scenarioRequest.job.kind !== diagnosticRequest.jobId) {
    throw new DiagnosticBootstrapError('prepared_run_identity_mismatch');
  }
  await Promise.all([
    scenarioRequest.resultFile,
    scenarioRequest.phaseFile,
    join(prepared.runDirectory, 'diagnostic-status.json'),
    join(prepared.runDirectory, 'diagnostic-summary.json'),
    join(prepared.runDirectory, 'supervisor-status.json'),
    join(prepared.runDirectory, 'supervisor-final-status.json'),
    join(prepared.runDirectory, 'clock-start.json'),
    join(prepared.runDirectory, 'clock-end.json'),
    join(prepared.traceDirectory, 'profile-request.json'),
    join(prepared.traceDirectory, 'diagnostic-worker-result.json'),
  ].map((path) => ensurePathAbsent(path)));
  return Object.freeze({ prepared, scenarioRequest, diagnosticRequest });
}
