import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { correlateDiagnosticProfileEvidence } from './diagnostic-admission-correlation.mjs';
import {
  diagnosticRequestSchema,
  profilerRequestSchema,
  readPrivateJson,
  verifyOwnedDirectory,
} from './diagnostic-vitest-bootstrap-control.mjs';
import { diagnosticWorkerResultSchema } from './diagnostic-worker-result-contract.mjs';
import {
  parseCpuProfileArtifact,
  parseTraceArtifact,
  readPrivateDiagnosticArtifact,
} from './diagnostic-admission-artifacts.mjs';

const clockOffsetSchema = z.object({
  lowerNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
  upperNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict();
const clockMappingSchema = z.object({
  status: z.literal('aligned'),
  clockDomain: z.literal('linux_clock_monotonic_ns'),
  offsetConvention: z.literal('parent_minus_child'),
  bootId: z.string().min(1),
  parentClockSource: z.literal('time.clock_gettime_ns:CLOCK_MONOTONIC'),
  parentResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  childClockSource: z.literal('process.hrtime.bigint'),
  childResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  startOffset: clockOffsetSchema,
  endOffset: clockOffsetSchema,
  combinedUncertaintyNs: z.string().regex(/^[0-9]+$/),
  startParentResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  endParentResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  startChildResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  endChildResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
}).passthrough();

function fallbackTraceStatus(runId) {
  return Object.freeze({
    runId,
    finalizationState: 'provisional',
    traceIncomplete: true,
    traceTruncated: true,
    samplingIncomplete: true,
    diagnosticAdmissible: false,
    eventsDropped: 0,
    bytesDropped: 0,
    profilesMissing: 0,
    profilesMissingExact: false,
    stateIntegrity: 'unknown',
    reasonCode: 'finalization_unverified',
    reasonCodes: ['finalization_unverified'],
  });
}

async function readWorkerResult(traceDirectory, runId) {
  const path = join(traceDirectory, 'diagnostic-worker-result.json');
  const contents = await readPrivateDiagnosticArtifact(path, traceDirectory, 4 * 1024 * 1024);
  if (contents === undefined) return { path, result: undefined };
  try {
    const parsed = diagnosticWorkerResultSchema.safeParse(JSON.parse(contents.bytes.toString('utf8')));
    return { path, result: parsed.success && parsed.data.runId === runId ? parsed.data : undefined };
  } catch {
    return { path, result: undefined };
  }
}

async function readTraceArtifacts(traceDirectory, runId) {
  const names = await readdir(traceDirectory);
  const traces = [];
  const artifacts = [];
  for (const name of names) {
    const kind = name.startsWith('trace-') && name.endsWith('.jsonl') ? 'trace'
      : name.startsWith('profile-events-') && name.endsWith('.jsonl') ? 'profile_events'
        : undefined;
    if (kind === undefined) continue;
    const path = join(traceDirectory, name);
    const contents = await readPrivateDiagnosticArtifact(path, traceDirectory, 8 * 1024 * 1024);
    artifacts.push(Object.freeze({ kind, path }));
    if (contents === undefined) continue;
    traces.push(Object.freeze({ kind, ...parseTraceArtifact(contents.bytes, runId) }));
  }
  return { traces, artifacts };
}

async function readProfiles(traceDirectory, runId, events) {
  const directory = join(traceDirectory, 'profiles');
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return [];
  }

  const completedWrites = events.filter((event) => event.event === 'profile_write_completed' && event.runId === runId);
  const profiles = [];
  for (const name of names) {
    if (!name.endsWith('.cpuprofile')) continue;
    const path = join(directory, name);
    const contents = await readPrivateDiagnosticArtifact(path, traceDirectory, 64 * 1024 * 1024);
    if (contents === undefined) {
      profiles.push(Object.freeze({ kind: 'profile', path, profileValid: false, sampleCount: 0, fileBytes: 0 }));
      continue;
    }
    const summary = parseCpuProfileArtifact(contents.bytes);
    const match = /^profile-([1-9][0-9]*)-([1-9][0-9]*)-(segment_[1-9][0-9]*|seg_[0-9]{6})\.cpuprofile$/.exec(name);
    const writeEvent = match === null ? undefined : completedWrites.find((event) =>
      event.pid === Number(match[1]) && event.processStartTicks === match[2] && event.segmentId === match[3]);
    const sampleCount = summary?.sampleCount ?? 0;
    const fileBytes = contents.size;
    const profileValid = summary !== undefined && writeEvent?.sampleCount?.value === sampleCount
      && writeEvent?.fileBytes?.value === fileBytes;
    const kind = writeEvent?.processRole === 'vitest_worker' ? 'profile' : 'profile_support';
    profiles.push(Object.freeze({
      kind, path, profileValid, sampleCount, fileBytes,
      ...(kind === 'profile' && writeEvent !== undefined ? { segmentId: writeEvent.segmentId } : {}),
    }));
  }
  return profiles;
}

export async function collectDiagnosticAdmissionEvidence(input) {
  await verifyOwnedDirectory(input.runDirectory);
  await verifyOwnedDirectory(input.traceDirectory);
  if (resolve(input.traceDirectory) !== resolve(input.runDirectory, 'trace')) {
    throw new Error('diagnostic_trace_directory_invalid');
  }
  const diagnosticRequest = diagnosticRequestSchema.parse(await readPrivateJson(
    join(input.runDirectory, 'worker-diagnostic-request.json'), input.runDirectory,
  ));
  const profilerRequest = profilerRequestSchema.parse(await readPrivateJson(
    join(input.traceDirectory, 'profile-request.json'), input.traceDirectory,
  ));
  if (diagnosticRequest.runId !== input.runId || profilerRequest.runId !== input.runId
    || profilerRequest.recipeDigest !== diagnosticRequest.recipeDigest
    || profilerRequest.sourceFingerprint !== diagnosticRequest.sourceFingerprint
    || profilerRequest.runDirectory !== input.traceDirectory) {
    throw new Error('diagnostic_admission_request_mismatch');
  }
  const { path: workerResultPath, result: workerResult } = await readWorkerResult(input.traceDirectory, input.runId);
  const { traces, artifacts: traceArtifacts } = await readTraceArtifacts(input.traceDirectory, input.runId);
  const events = traces.flatMap((trace) => trace.events);
  const workerMarkers = events.filter((event) => event.event === 'preload_started'
    && event.processRole === 'vitest_worker' && event.ppid === profilerRequest.parentPid
    && event.pid !== profilerRequest.parentPid
    && event.runId === input.runId && event.sourceFingerprint === diagnosticRequest.sourceFingerprint
    && event.recipeDigest === diagnosticRequest.recipeDigest);
  const marker = workerMarkers.find((candidate) => events.some((event) => event.pid === candidate.pid
    && event.processStartTicks === candidate.processStartTicks && event.event === 'resource_sample')) ?? workerMarkers[0];
  const workerIdentity = Object.freeze({
    pid: marker?.pid ?? 1,
    startTicks: marker?.processStartTicks ?? '1',
    parentPid: marker?.ppid ?? profilerRequest.parentPid,
  });
  const workerEvents = events.filter((event) => event.pid === workerIdentity.pid
    && event.processStartTicks === workerIdentity.startTicks && event.runId === input.runId);
  const stateIntegrityEvents = workerEvents.filter((event) => event.event === 'span_finished'
    && event.stageId === 'S08_storage_write' && event.stateIntegrity !== undefined);
  const storageIntegrity = stateIntegrityEvents.length > 0
    && stateIntegrityEvents.every((event) => event.stateIntegrity === 'verified')
    ? 'verified'
    : 'unknown';
  const profiles = await readProfiles(input.traceDirectory, input.runId, events);
  const segments = profiles.filter((profile) => profile.segmentId !== undefined).map((profile) => Object.freeze({
    segmentId: profile.segmentId,
    path: profile.path,
    profileValid: profile.profileValid,
    sampleCount: profile.sampleCount,
    fileBytes: profile.fileBytes,
  }));
  const clockMapping = clockMappingSchema.safeParse(input.clockMapping);
  const clockAligned = clockMapping.success
    && BigInt(clockMapping.data.combinedUncertaintyNs) <= 10_000_000n
    && BigInt(clockMapping.data.startOffset.lowerNs) <= BigInt(clockMapping.data.startOffset.upperNs)
    && BigInt(clockMapping.data.endOffset.lowerNs) <= BigInt(clockMapping.data.endOffset.upperNs)
    && workerEvents.length > 0 && workerEvents.every((event) => event.clockDomain === 'process_local_monotonic');
  const { cpuDeltaUs, correlation } = await correlateDiagnosticProfileEvidence({
    runId: input.runId,
    parentPid: profilerRequest.parentPid,
    workerIdentity,
    workerMarkers,
    workerEvents,
    events,
    segments,
    supervisorProcessSamples: input.supervisorProcessSamples ?? [],
    clockMapping: clockMapping.success
      ? clockMapping.data
      : { status: 'not_correlatable', reasonCode: 'invalid_clock_metadata' },
  });

  const matchingTrace = traces.find((trace) => trace.kind === 'trace'
    && trace.terminal?.pid === workerIdentity.pid && trace.terminal?.processStartTicks === workerIdentity.startTicks);
  const traceStatus = matchingTrace?.terminal ?? fallbackTraceStatus(input.runId);
  const profilesMissing = Math.max(correlation.profilesMissing,
    ...traces.map((trace) => trace.terminal?.profilesMissing ?? Number.MAX_SAFE_INTEGER));
  const profile = Object.freeze({
    clockAlignmentStatus: clockAligned ? 'aligned' : 'not_correlatable',
    correlationStatus: correlation.status,
    reasonCodes: correlation.reasonCodes,
    workerIdentity,
    cpuDeltaUs,
    preloadMarker: Object.freeze({
      runId: input.runId,
      pid: marker?.pid ?? 1,
      startTicks: marker?.processStartTicks ?? '1',
      parentPid: marker?.ppid ?? profilerRequest.parentPid,
      processRole: marker?.processRole ?? 'unknown_node',
    }),
    selfSamples: correlation.selfSamples,
    profilesMissing,
    segments: Object.freeze(segments),
    stageOverlaps: correlation.stageOverlaps,
  });
  return Object.freeze({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: input.runId,
    jobId: 'cold_initial_index',
    runDirectory: input.runDirectory,
    sourceGate: input.sourceGate,
    hostGate: input.hostGate,
    workerResult: workerResult ?? Object.freeze({
      runId: input.runId, jobId: 'cold_initial_index', recipeDigest: diagnosticRequest.recipeDigest,
      sourceFingerprint: diagnosticRequest.sourceFingerprint, status: 'failed', exitCode: 1, diagnosticAdmissible: false,
    }),
    traceStatus,
    profile,
    storageIntegrity: Object.freeze({ status: storageIntegrity }),
    cleanup: Object.freeze({ status: input.cleanupStatus, remainingProcessCount: input.cleanupStatus === 'verified' ? 0 : 1 }),
    artifacts: Object.freeze([
      ...traceArtifacts,
      { kind: 'worker_result', path: workerResultPath },
      ...profiles.map((profile) => Object.freeze({ kind: profile.kind, path: profile.path })),
    ]),
  });
}
