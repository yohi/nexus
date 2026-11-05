import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { traceStatusSchema, validateDiagnosticArtifacts } from './diagnostic-admission-artifacts.mjs';
import { diagnosticWorkerResultSchema } from './diagnostic-worker-result-contract.mjs';
import {
  readPrivateJson,
  verifyOwnedDirectory,
  writePrivateJson,
} from './diagnostic-vitest-bootstrap-control.mjs';
import { passedHostGateResultSchema } from './host-gate-inputs.mjs';
import { compareStrings } from './diagnostic-string-order.mjs';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const runIdSchema = z.string().uuid();
const supervisorFinalizationSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: runIdSchema,
  sourceFingerprint: digestSchema,
  recipeDigest: digestSchema,
  workerStatus: z.literal('completed'),
  workerExitCode: z.literal(0),
  cleanupStatus: z.literal('verified'),
  remainingProcessCount: z.literal(0),
  finalizedByPid: z.number().int().positive(),
}).strict();
const supervisorRunStatusSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: runIdSchema,
  sourceFingerprint: digestSchema,
  recipeDigest: digestSchema,
  status: z.literal('running'),
  supervisorPid: z.number().int().positive(),
}).strict();
const failureReasonSchema = z.enum([
  'clock_probe_start_failed',
  'cleanup_unverified',
  'diagnostic_deadline_expired',
  'diagnostic_worker_failed',
  'diagnostic_worker_result_invalid',
  'diagnostic_worker_timeout',
  'source_fingerprint_mismatch',
]);
const identitySchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^[1-9][0-9]*$/),
  parentPid: z.number().int().positive(),
}).strict();
const profileSchema = z.object({
  clockAlignmentStatus: z.enum(['aligned', 'not_correlatable']),
  correlationStatus: z.enum(['cpu_active_fork_profile_captured', 'worker_profile_NOT_PROVEN']),
  reasonCodes: z.array(z.string()),
  workerIdentity: identitySchema,
  cpuDeltaUs: z.number().finite().nonnegative(),
  preloadMarker: z.object({
    runId: runIdSchema,
    pid: z.number().int().positive(),
    startTicks: z.string().regex(/^[1-9][0-9]*$/),
    parentPid: z.number().int().positive(),
    processRole: z.enum(['vitest_parent', 'vitest_worker', 'unknown_node']),
  }).strict(),
  selfSamples: z.number().int().nonnegative(),
  profilesMissing: z.number().int().nonnegative(),
  segments: z.array(z.object({
    segmentId: z.string().regex(/^(?:segment_[1-9][0-9]*|seg_[0-9]{6})$/),
    path: z.string().refine(isAbsolute),
    profileValid: z.boolean(),
    sampleCount: z.number().int().nonnegative(),
    fileBytes: z.number().int().nonnegative(),
  }).strict()),
  stageOverlaps: z.array(z.object({
    stageId: z.string().min(1),
    overlapNs: z.string().regex(/^[1-9][0-9]*$/),
  }).strict()).optional(),
}).strict();
const baseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: runIdSchema,
  jobId: z.literal('cold_initial_index'),
  runDirectory: z.string().refine(isAbsolute),
}).passthrough();

function validProcessProfile(profile, runId) {
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success) return { profile: undefined, reason: 'profile_evidence_invalid' };
  const value = parsed.data;
  const reasons = new Set();
  const worker = value.workerIdentity;
  const marker = value.preloadMarker;
  if (worker.pid === worker.parentPid) reasons.add('worker_pid_not_fork');
  if (value.clockAlignmentStatus !== 'aligned') reasons.add('clock_unaligned');
  if (value.correlationStatus !== 'cpu_active_fork_profile_captured' || value.reasonCodes.length > 0) {
    reasons.add('profile_correlation_failed');
  }
  if (value.cpuDeltaUs <= 1_000_000) reasons.add('cpu_inactive');
  if (marker.runId !== runId || marker.pid !== worker.pid || marker.startTicks !== worker.startTicks
    || marker.parentPid !== worker.parentPid || marker.processRole !== 'vitest_worker') {
    reasons.add('preload_identity_mismatch');
  }
  const validSegments = value.segments.filter((segment) => segment.profileValid && segment.sampleCount > 0 && segment.fileBytes > 0);
  if (validSegments.length < 2) reasons.add('insufficient_profile_segments');
  if (value.selfSamples < 100 || validSegments.reduce((sum, segment) => sum + segment.sampleCount, 0) < 100) {
    reasons.add('insufficient_profile_samples');
  }
  if (value.stageOverlaps === undefined || value.stageOverlaps.length === 0) reasons.add('stage_overlap_missing');
  if (value.profilesMissing !== 0) reasons.add('profiles_missing');
  return { profile: value, reasons };
}

export async function finalizeDiagnosticRun(evidenceValue, supervisorFinalizationValue) {
  const base = baseEvidenceSchema.parse(evidenceValue);
  await verifyOwnedDirectory(base.runDirectory);
  const reasons = new Set();

  const source = z.object({ status: z.string(), digest: digestSchema }).safeParse(evidenceValue.sourceGate);
  if (!source.success || source.data.status !== 'PASS') reasons.add('source_gate_not_pass');
  if (!passedHostGateResultSchema.safeParse(evidenceValue.hostGate).success) reasons.add('host_gate_not_pass');
  const supervisorRunStatus = supervisorRunStatusSchema.safeParse(await readPrivateJson(
    join(base.runDirectory, 'supervisor-status.json'), base.runDirectory,
  ));
  const worker = diagnosticWorkerResultSchema.safeParse(evidenceValue.workerResult);
  if (!worker.success || worker.data.runId !== base.runId || worker.data.status !== 'completed' || worker.data.exitCode !== 0) {
    reasons.add('worker_result_invalid');
  }
  const supervisorFinalization = supervisorFinalizationSchema.safeParse(supervisorFinalizationValue);
  const supervisorFinalizationValid = supervisorFinalization.success
    && supervisorFinalization.data.runId === base.runId
    && supervisorRunStatus.success
    && supervisorRunStatus.data.runId === base.runId
    && supervisorRunStatus.data.sourceFingerprint === supervisorFinalization.data.sourceFingerprint
    && supervisorRunStatus.data.recipeDigest === supervisorFinalization.data.recipeDigest
    && supervisorRunStatus.data.supervisorPid === supervisorFinalization.data.finalizedByPid
    && supervisorFinalization.data.finalizedByPid === process.pid
    && worker.success
    && supervisorFinalization.data.sourceFingerprint === worker.data.sourceFingerprint
    && supervisorFinalization.data.recipeDigest === worker.data.recipeDigest;
  if (!supervisorFinalizationValid) reasons.add('supervisor_finalization_unverified');
  if (worker.success && worker.data.scenario.records.some((record) => record.status !== 'valid')) {
    reasons.add('worker_scenario_invalid');
  }
  if (source.success && worker.success && source.data.digest !== worker.data.sourceFingerprint) {
    reasons.add('source_fingerprint_mismatch');
  }
  const trace = traceStatusSchema.safeParse(evidenceValue.traceStatus);
  if (!trace.success || trace.data.runId !== base.runId) {
    reasons.add('trace_status_invalid');
  } else {
    const provisionalFinalizationOnly = supervisorFinalizationValid
      && trace.data.finalizationState === 'provisional'
      && trace.data.traceIncomplete
      && trace.data.samplingIncomplete
      && !trace.data.traceTruncated
      && trace.data.reasonCode === 'finalization_unverified'
      && trace.data.reasonCodes.length === 1
      && trace.data.reasonCodes[0] === 'finalization_unverified'
      && trace.data.eventsDropped === 0
      && trace.data.bytesDropped === 0
      && trace.data.profilesMissing === 0
      && trace.data.profilesMissingExact
      && trace.data.stateIntegrity === 'unknown'
      && evidenceValue.storageIntegrity?.status === 'verified';
    if ((trace.data.traceIncomplete || trace.data.traceTruncated || trace.data.samplingIncomplete)
      && !provisionalFinalizationOnly) reasons.add('trace_incomplete');
    if (trace.data.eventsDropped > 0 || trace.data.bytesDropped > 0) reasons.add('trace_events_dropped');
    if (trace.data.profilesMissing > 0 || !trace.data.profilesMissingExact) reasons.add('profiles_missing');
    if ((trace.data.reasonCode !== undefined || trace.data.reasonCodes.length > 0) && !provisionalFinalizationOnly) {
      reasons.add('trace_reason_codes_present');
    }
    if (trace.data.stateIntegrity !== 'verified' && !provisionalFinalizationOnly) reasons.add('storage_integrity_unverified');
  }
  const profileResult = validProcessProfile(evidenceValue.profile, base.runId);
  if (profileResult.reason !== undefined) reasons.add(profileResult.reason);
  for (const reason of profileResult.reasons ?? []) reasons.add(reason);

  const storage = z.object({ status: z.literal('verified') }).safeParse(evidenceValue.storageIntegrity);
  if (!storage.success) reasons.add('storage_integrity_unverified');
  const cleanup = z.object({ status: z.literal('verified'), remainingProcessCount: z.literal(0) }).safeParse(evidenceValue.cleanup);
  if (!cleanup.success) reasons.add('cleanup_unverified');
  for (const reason of await validateDiagnosticArtifacts(
    evidenceValue.artifacts,
    base.runDirectory,
    profileResult.profile,
    worker.success ? worker.data : undefined,
    trace.success ? trace.data : undefined,
    base.runId,
    supervisorFinalizationValid,
  )) reasons.add(reason);

  const reasonCodes = Object.freeze([...reasons].sort(compareStrings));
  const summary = Object.freeze({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: base.runId,
    jobId: base.jobId,
    admissible: reasonCodes.length === 0,
    reasonCodes,
    storageIntegrityStatus: evidenceValue.storageIntegrity?.status === 'verified' ? 'verified' : 'unknown',
    workerPid: profileResult.profile?.workerIdentity.pid ?? null,
    profileSegments: profileResult.profile?.segments.length ?? 0,
    selfSamples: profileResult.profile?.selfSamples ?? 0,
  });
  await writePrivateJson(join(base.runDirectory, 'diagnostic-summary.json'), base.runDirectory, summary);
  return summary;
}

export async function writeDiagnosticFailureSummary(runDirectory, runId, reasonValue) {
  const safeRunDirectory = z.string().refine(isAbsolute).parse(runDirectory);
  const safeRunId = runIdSchema.parse(runId);
  const reasonCode = failureReasonSchema.parse(reasonValue);
  await verifyOwnedDirectory(safeRunDirectory);
  const summary = Object.freeze({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: safeRunId,
    jobId: 'cold_initial_index',
    admissible: false,
    reasonCodes: Object.freeze([reasonCode]),
    storageIntegrityStatus: 'unknown',
    workerPid: null,
    profileSegments: 0,
    selfSamples: 0,
  });
  await writePrivateJson(join(safeRunDirectory, 'diagnostic-summary.json'), safeRunDirectory, summary);
  return summary;
}
