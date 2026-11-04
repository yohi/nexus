import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { inside } from './diagnostic-vitest-bootstrap-control.mjs';
import { diagnosticWorkerResultSchema as workerArtifactSchema } from './diagnostic-worker-result-contract.mjs';

const runIdSchema = z.string().uuid();
const traceStatusSchema = z.object({
  runId: runIdSchema,
  finalizationState: z.literal('provisional'),
  traceIncomplete: z.boolean(),
  traceTruncated: z.boolean(),
  samplingIncomplete: z.boolean(),
  diagnosticAdmissible: z.literal(false),
  eventsDropped: z.number().int().nonnegative(),
  bytesDropped: z.number().int().nonnegative(),
  profilesMissing: z.number().int().nonnegative(),
  profilesMissingExact: z.boolean(),
  stateIntegrity: z.enum(['unknown', 'verified', 'rollback_incomplete', 'backup_cleanup_failed']),
  reasonCode: z.string().optional(),
  reasonCodes: z.array(z.string()),
}).passthrough();
const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  seq: z.number().int().positive(),
  monotonicNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
  event: z.string().min(1),
  runId: runIdSchema,
  jobId: z.literal('cold_initial_index'),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
  processStartTicks: z.string().regex(/^[1-9][0-9]*$/),
  ppid: z.number().int().nonnegative(),
  processRole: z.enum(['vitest_parent', 'vitest_worker', 'unknown_node']),
  clockDomain: z.enum(['linux_clock_monotonic_ns', 'process_local_monotonic']),
}).passthrough();
const artifactSchema = z.object({
  kind: z.enum(['trace', 'profile_events', 'worker_result', 'profile', 'profile_support']),
  path: z.string().refine(isAbsolute),
}).strict();
export async function readPrivateDiagnosticArtifact(path, ownerRoot, maxBytes) {
  if (!inside(ownerRoot, resolve(path))) return undefined;
  let descriptor;
  try {
    if (await realpath(path) !== resolve(path)) return undefined;
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [info, canonical] = await Promise.all([
      descriptor.stat(),
      realpath(`/proc/self/fd/${descriptor.fd}`),
    ]);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || info.nlink !== 1 || canonical !== resolve(path) || info.size > maxBytes) return undefined;
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let total = 0;
    while (total < bytes.length) {
      const result = await descriptor.read(bytes, total, bytes.length - total, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    const finalInfo = await descriptor.stat();
    if (total > maxBytes || total !== finalInfo.size || finalInfo.size > maxBytes) return undefined;
    return { bytes: bytes.subarray(0, total), size: total };
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  } finally {
    await descriptor?.close();
  }
}

export function parseTraceArtifact(contents, runId) {
  const reasons = new Set();
  const events = [];
  const lines = contents.toString('utf8').split('\n').filter((line) => line.length > 0);
  let previousMonotonic = -1n;
  let terminal;
  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = eventEnvelopeSchema.safeParse(JSON.parse(line));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success || parsed.data.runId !== runId || parsed.data.seq !== index + 1) {
      reasons.add('trace_event_invalid');
      continue;
    }
    const event = parsed.data;
    const monotonic = BigInt(event.monotonicNs);
    if (monotonic < previousMonotonic) reasons.add('trace_sequence_invalid');
    previousMonotonic = monotonic;
    events.push(event);
    if (event.event === 'trace_status') {
      if (terminal !== undefined || index !== lines.length - 1) reasons.add('trace_sequence_invalid');
      const status = traceStatusSchema.safeParse(event);
      if (!status.success) reasons.add('trace_status_invalid');
      else terminal = status.data;
    }
  }
  if (terminal === undefined) reasons.add('trace_terminal_missing');
  return { events, terminal, reasons };
}

export function parseCpuProfileArtifact(contents) {
  let value;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !Array.isArray(value.nodes) || !Array.isArray(value.samples)) {
    return undefined;
  }
  const nodeIds = new Set();
  for (const node of value.nodes) {
    if (typeof node !== 'object' || node === null || !Number.isSafeInteger(node.id) || node.id < 1
      || nodeIds.has(node.id) || typeof node.callFrame !== 'object' || node.callFrame === null
      || typeof node.callFrame.functionName !== 'string' || typeof node.callFrame.url !== 'string') return undefined;
    nodeIds.add(node.id);
  }
  if (!value.samples.every((sample) => Number.isSafeInteger(sample) && nodeIds.has(sample))) return undefined;
  return Object.freeze({ sampleCount: value.samples.length });
}

function traceStatusMatches(actual, expected) {
  if (actual === undefined || expected === undefined) return false;
  const fieldsMatch = ['runId', 'finalizationState', 'traceIncomplete', 'traceTruncated', 'samplingIncomplete',
    'diagnosticAdmissible', 'eventsDropped', 'bytesDropped', 'profilesMissing', 'profilesMissingExact', 'stateIntegrity', 'reasonCode']
    .every((key) => actual[key] === expected[key]);
  return fieldsMatch && JSON.stringify(actual.reasonCodes) === JSON.stringify(expected.reasonCodes);
}

function validateSegmentEvents(events, segment, identity, runId) {
  const sequence = ['profile_segment_started', 'profile_segment_stop_requested', 'profile_segment_stopped', 'profile_write_completed'];
  const matched = events.filter((event) => event.segmentId === segment.segmentId && event.runId === runId
    && event.pid === identity.pid && event.processStartTicks === identity.startTicks);
  if (matched.length !== sequence.length || matched.some((event, index) => event.event !== sequence[index])) return false;
  if (matched.some((event) => event.pid !== identity.pid || event.processStartTicks !== identity.startTicks
    || event.ppid !== identity.parentPid || event.runId !== runId)) return false;
  const stopped = matched[2];
  const written = matched[3];
  return stopped?.sampleCount?.status === 'observed' && written?.sampleCount?.status === 'observed'
    && stopped.sampleCount.value === segment.sampleCount && written.sampleCount.value === segment.sampleCount
    && written.fileBytes?.status === 'observed' && written.fileBytes.value === segment.fileBytes;
}

export async function validateDiagnosticArtifacts(
  value, runDirectory, profileEvidence, expectedWorkerResult, expectedTraceStatus, runId, allowProvisionalFinalization = false,
) {
  const parsedArtifacts = z.array(artifactSchema).safeParse(value);
  if (!parsedArtifacts.success) return ['artifact_ownership_unverified'];
  const reasons = new Set();
  const artifacts = parsedArtifacts.data;
  const traceArtifacts = artifacts.filter((artifact) => artifact.kind === 'trace');
  const workerResultArtifacts = artifacts.filter((artifact) => artifact.kind === 'worker_result');
  const profileArtifacts = artifacts.filter((artifact) => artifact.kind === 'profile');
  if (traceArtifacts.length !== 1 || workerResultArtifacts.length !== 1
    || profileArtifacts.length !== profileEvidence?.segments.length || profileArtifacts.length < 2) {
    reasons.add('artifact_inventory_invalid');
  }

  let workerArtifact;
  const parsedTraces = [];
  let verifiedProfiles = 0;
  for (const artifact of artifacts) {
    const path = resolve(artifact.path);
    if (!inside(runDirectory, path)) {
      reasons.add('artifact_ownership_unverified');
      continue;
    }
    const maxBytes = artifact.kind === 'profile' || artifact.kind === 'profile_support' ? 64 * 1024 * 1024
      : artifact.kind === 'trace' || artifact.kind === 'profile_events' ? 8 * 1024 * 1024
        : 4 * 1024 * 1024;
    const contents = await readPrivateDiagnosticArtifact(path, runDirectory, maxBytes);
    if (contents === undefined) {
      reasons.add(artifact.kind === 'worker_result' ? 'worker_result_invalid'
        : artifact.kind === 'profile' ? 'profile_artifact_invalid' : 'artifact_ownership_unverified');
      continue;
    }
    if (artifact.kind === 'worker_result') {
      try {
        const parsed = workerArtifactSchema.safeParse(JSON.parse(contents.bytes.toString('utf8')));
        if (!parsed.success || parsed.data.runId !== expectedWorkerResult?.runId
          || parsed.data.recipeDigest !== expectedWorkerResult?.recipeDigest
          || parsed.data.sourceFingerprint !== expectedWorkerResult?.sourceFingerprint
          || parsed.data.status !== expectedWorkerResult?.status || parsed.data.exitCode !== expectedWorkerResult?.exitCode) {
          reasons.add('worker_result_invalid');
        } else {
          workerArtifact = parsed.data;
          if (parsed.data.scenario.records.some((record) => record.status !== 'valid')) {
            reasons.add('worker_scenario_invalid');
          }
        }
      } catch {
        reasons.add('worker_result_invalid');
      }
    } else if (artifact.kind === 'trace' || artifact.kind === 'profile_events') {
      const parsed = parseTraceArtifact(contents.bytes, runId);
      for (const reason of parsed.reasons) reasons.add(reason);
      if (expectedWorkerResult !== undefined && parsed.events.some((event) =>
        event.jobId !== expectedWorkerResult.jobId
        || event.recipeDigest !== expectedWorkerResult.recipeDigest
        || event.sourceFingerprint !== expectedWorkerResult.sourceFingerprint)) {
        reasons.add('trace_identity_mismatch');
      }
      if (artifact.kind === 'trace') {
        if (!traceStatusMatches(parsed.terminal, expectedTraceStatus)) reasons.add('trace_status_mismatch');
        const finalizationOnly = allowProvisionalFinalization
          && parsed.terminal?.finalizationState === 'provisional'
          && parsed.terminal.traceIncomplete
          && parsed.terminal.samplingIncomplete
          && !parsed.terminal.traceTruncated
          && parsed.terminal.reasonCode === 'finalization_unverified'
          && parsed.terminal.reasonCodes.length === 1
          && parsed.terminal.reasonCodes[0] === 'finalization_unverified'
          && parsed.terminal.eventsDropped === 0
          && parsed.terminal.bytesDropped === 0
          && parsed.terminal.profilesMissing === 0
          && parsed.terminal.profilesMissingExact
          && parsed.terminal.stateIntegrity === 'unknown';
        if (parsed.terminal === undefined || (!finalizationOnly && (parsed.terminal.traceIncomplete || parsed.terminal.traceTruncated
          || parsed.terminal.samplingIncomplete || parsed.terminal.eventsDropped > 0 || parsed.terminal.bytesDropped > 0
          || parsed.terminal.profilesMissing > 0 || !parsed.terminal.profilesMissingExact))) reasons.add('trace_incomplete');
        if (finalizationOnly) {
          const integrityEvents = parsed.events.filter((event) => event.event === 'span_finished'
            && event.stageId === 'S08_storage_write' && event.stateIntegrity !== undefined);
          if (integrityEvents.length === 0 || integrityEvents.some((event) => event.stateIntegrity !== 'verified')) {
            reasons.add('storage_integrity_unverified');
          }
        } else if (parsed.terminal?.stateIntegrity !== 'verified') {
          reasons.add('storage_integrity_unverified');
        }
      } else if (artifact.kind === 'profile_events' && parsed.terminal?.processRole === 'vitest_worker'
        && parsed.terminal.pid === profileEvidence?.workerIdentity.pid
        && parsed.terminal.processStartTicks === profileEvidence?.workerIdentity.startTicks
        && (parsed.terminal.traceTruncated || parsed.terminal.eventsDropped > 0 || parsed.terminal.bytesDropped > 0
          || parsed.terminal.profilesMissing > 0 || !parsed.terminal.profilesMissingExact)) {
        reasons.add('profile_events_incomplete');
      }
      parsedTraces.push(parsed);
    } else if (artifact.kind === 'profile') {
      const parsed = parseCpuProfileArtifact(contents.bytes);
      const expected = profileEvidence?.segments.find((segment) => resolve(segment.path) === path);
      if (parsed === undefined || expected === undefined || parsed.sampleCount !== expected.sampleCount
        || contents.size !== expected.fileBytes || !expected.profileValid) {
        reasons.add('profile_artifact_invalid');
      } else {
        verifiedProfiles += 1;
      }
    } else if (artifact.kind === 'profile_support') {
      if (parseCpuProfileArtifact(contents.bytes) === undefined) reasons.add('profile_support_artifact_invalid');
    }
  }
  if (workerArtifact === undefined) reasons.add('worker_result_invalid');
  if (workerArtifact?.observerFailure === true) reasons.add('observer_failure');
  if (workerArtifact?.traceIncomplete === true) reasons.add('trace_incomplete');

  const traceEvents = parsedTraces.flatMap((trace) => trace.events);
  const preloads = traceEvents.filter((event) => event.event === 'preload_started');
  const workerIdentity = profileEvidence?.workerIdentity;
  const markerFound = preloads.some((event) => event.runId === runId && event.pid === workerIdentity?.pid
    && event.processStartTicks === workerIdentity?.startTicks && event.ppid === workerIdentity?.parentPid
    && event.processRole === 'vitest_worker');
  if (!markerFound) reasons.add('preload_identity_mismatch');
  for (const segment of profileEvidence?.segments ?? []) {
    if (!validateSegmentEvents(traceEvents, segment, workerIdentity, runId)) reasons.add('profile_segment_evidence_invalid');
  }
  if (verifiedProfiles !== profileEvidence?.segments.length) reasons.add('profile_artifact_invalid');
  return [...reasons];
}
