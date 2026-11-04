import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { calibrateClockMapping, parseClockPingWindow } from '../../../../benchmarks/performance/diagnostics/clock-domain.js';
import type { ClockMappingResult } from '../../../../benchmarks/performance/diagnostics/clock-domain.js';

type AdmissionCollectorModule = Readonly<{
  collectDiagnosticAdmissionEvidence: (input: Readonly<{
    runId: string;
    runDirectory: string;
    traceDirectory: string;
    sourceGate: Readonly<{ status: string; digest: string }>;
    hostGate: Readonly<{
      status: string;
      snapshotCount: number;
      reasonCodes: readonly string[];
      requiredScratchBytes: number;
      scratchFreeBytes: number;
      effectiveCpuCapacity: number;
    }>;
    cleanupStatus: 'verified' | 'unverified';
    supervisorProcessSamples?: readonly Readonly<{ pid: number; startTicks: string; ppid: number; cpuTicksDelta: number }>[];
    clockMapping?: ClockMappingResult;
  }>) => Promise<Readonly<Record<string, unknown>>>;
}>;
type AdmissionModule = Readonly<{
  finalizeDiagnosticRun: (
    evidence: Readonly<Record<string, unknown>>,
    supervisorFinalization?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<{ admissible: boolean; reasonCodes: readonly string[] }>>;
}>;
type AdmissionArtifactsModule = Readonly<{
  readPrivateDiagnosticArtifact: (
    path: string,
    ownerRoot: string,
    maxBytes: number,
  ) => Promise<Readonly<{ bytes: Buffer; size: number }> | undefined>;
}>;
type AdmissionEvidence = Readonly<{
  profile: Readonly<{
    clockAlignmentStatus: string;
    correlationStatus: string;
    reasonCodes: readonly string[];
    selfSamples: number;
    stageOverlaps: readonly Readonly<{ stageId: string; overlapNs: string }>[];
  }>;
  artifacts: readonly Readonly<{ kind: string; path: string }>[];
}>;
const admissionEvidenceSchema = z.object({
  profile: z.object({
    clockAlignmentStatus: z.string(),
    correlationStatus: z.string(),
    reasonCodes: z.array(z.string()),
    selfSamples: z.number(),
    stageOverlaps: z.array(z.object({ stageId: z.string(), overlapNs: z.string() }).strict()),
  }).passthrough(),
  artifacts: z.array(z.object({ kind: z.string(), path: z.string() }).strict()),
}).passthrough();

function isAdmissionModule(value: unknown): value is AdmissionModule {
  return typeof value === 'object' && value !== null
    && 'finalizeDiagnosticRun' in value && typeof value.finalizeDiagnosticRun === 'function';
}

function isAdmissionEvidence(value: unknown): value is AdmissionEvidence {
  return admissionEvidenceSchema.safeParse(value).success;
}

function isCollectorModule(value: unknown): value is AdmissionCollectorModule {
  return typeof value === 'object' && value !== null
    && 'collectDiagnosticAdmissionEvidence' in value
    && typeof value.collectDiagnosticAdmissionEvidence === 'function';
}

async function loadCollectorModule(): Promise<AdmissionCollectorModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/diagnostic-admission-collector.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isCollectorModule(loaded)).toBe(true);
  if (!isCollectorModule(loaded)) throw new Error('diagnostic_admission_collector_missing');
  return loaded;
}

async function loadAdmissionModule(): Promise<AdmissionModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/diagnostic-admission.mjs')).href;
  const loaded: unknown = await import(url);
  expect(isAdmissionModule(loaded)).toBe(true);
  if (!isAdmissionModule(loaded)) throw new Error('diagnostic_admission_module_missing');
  return loaded;
}

async function loadAdmissionArtifactsModule(): Promise<AdmissionArtifactsModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/diagnostic-admission-artifacts.mjs')).href;
  const loaded: unknown = await import(url);
  if (!isAdmissionArtifactsModule(loaded)) {
    expect(isAdmissionArtifactsModule(loaded)).toBe(true);
    throw new Error('diagnostic_admission_artifacts_module_missing');
  }
  expect(isAdmissionArtifactsModule(loaded)).toBe(true);
  return loaded;
}

function isAdmissionArtifactsModule(value: unknown): value is AdmissionArtifactsModule {
  return typeof value === 'object' && value !== null
    && 'readPrivateDiagnosticArtifact' in value
    && typeof value.readPrivateDiagnosticArtifact === 'function';
}

const runId = '00000000-0000-4000-8000-000000000001';
const recipeDigest = 'a'.repeat(64);
const sourceFingerprint = 'b'.repeat(64);
const workerIdentity = { pid: 3030, processStartTicks: '9876', ppid: 2020, processRole: 'vitest_worker' } as const;
const hostGateResult = Object.freeze({
  status: 'PASS', snapshotCount: 3, reasonCodes: Object.freeze([]), requiredScratchBytes: 5_000_000_000,
  scratchFreeBytes: 8_000_000_000, effectiveCpuCapacity: 4,
});
const supervisorProcessSamples = [{ pid: workerIdentity.pid, startTicks: workerIdentity.processStartTicks,
  ppid: workerIdentity.ppid, cpuTicksDelta: 120 }] as const;
const roots: string[] = [];

function alignedClockMapping() {
  const window = parseClockPingWindow({
    bootId: 'boot-fixture',
    parentClockSource: 'time.clock_gettime_ns:CLOCK_MONOTONIC',
    parentResolutionNs: '1',
    childClockSource: 'process.hrtime.bigint',
    childResolutionNs: '1',
    pings: [1_000, 2_000, 3_000].map((child) => ({
      parentSendNs: String(child + 10_000),
      childMonotonicNs: String(child),
      parentReceiveNs: String(child + 11_000),
    })),
  });
  return calibrateClockMapping({
    start: window,
    end: window,
    parentClockDomain: 'linux_clock_monotonic_ns',
    childClockDomain: 'process_local_monotonic',
  });
}

function envelope(seq: number, monotonicNs: number, event: string, details: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1, seq, monotonicNs: String(monotonicNs), event, runId, jobId: 'cold_initial_index',
    recipeDigest, sourceFingerprint, pid: workerIdentity.pid, processStartTicks: workerIdentity.processStartTicks,
    ppid: workerIdentity.ppid, processRole: workerIdentity.processRole, clockDomain: 'process_local_monotonic',
    ...details,
  };
}

function profileEvents(segmentId: string, firstSeq: number, startNs: number, fileBytes: number) {
  return [
    envelope(firstSeq, startNs, 'profile_segment_started', {
      segmentId,
      sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' },
      fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
    }),
    envelope(firstSeq + 1, startNs + 1, 'profile_segment_stop_requested', {
      segmentId,
      sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' },
      fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
    }),
    envelope(firstSeq + 2, startNs + 2, 'profile_segment_stopped', {
      segmentId,
      sampleCount: { status: 'observed', value: 50 },
      fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
    }),
    envelope(firstSeq + 3, startNs + 3, 'profile_write_completed', {
      segmentId,
      sampleCount: { status: 'observed', value: 50 },
      fileBytes: { status: 'observed', value: fileBytes },
    }),
  ];
}

async function createRunArtifacts() {
  const runDirectory = await mkdtemp(join(tmpdir(), 'nexus-admission-collect-'));
  roots.push(runDirectory);
  const traceDirectory = join(runDirectory, 'trace');
  const profilesDirectory = join(traceDirectory, 'profiles');
  await mkdir(traceDirectory, { mode: 0o700 });
  await mkdir(profilesDirectory, { mode: 0o700 });
  await writeFile(join(runDirectory, 'supervisor-status.json'), `${JSON.stringify({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    sourceFingerprint,
    recipeDigest,
    status: 'running',
    supervisorPid: process.pid,
  })}\n`, { mode: 0o600 });
  await writeFile(join(runDirectory, 'worker-diagnostic-request.json'), `${JSON.stringify({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    recipeDigest,
    sourceFingerprint,
    runDirectory: traceDirectory,
    operationId: `op_${'c'.repeat(16)}`,
    attemptId: 'attempt_1',
  })}\n`, { mode: 0o600 });
  const profileRequest = {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    recipeDigest,
    sourceFingerprint,
    runDirectory: traceDirectory,
    parentPid: workerIdentity.ppid,
  };
  await writeFile(join(traceDirectory, 'profile-request.json'), `${JSON.stringify(profileRequest)}\n`, { mode: 0o600 });

  const rawProfile = JSON.stringify({
    nodes: [{ id: 1, callFrame: { functionName: 'worker', url: 'file:///workspace/src/indexer/pipeline.ts' } }],
    samples: Array.from({ length: 50 }, () => 1),
  });
  const profilePaths = ['seg_000001', 'seg_000002'].map((segmentId) =>
    join(profilesDirectory, `profile-${workerIdentity.pid}-${workerIdentity.processStartTicks}-${segmentId}.cpuprofile`));
  await Promise.all(profilePaths.map((path) => writeFile(path, rawProfile, { mode: 0o600 })));
  const profileBytes = Buffer.byteLength(rawProfile);

  const traceEvents = [
    envelope(1, 100, 'preload_started'),
    envelope(2, 105, 'span_started', {
      spanId: 'span_storage_verified',
      operationId: `op_${'c'.repeat(16)}`,
      attemptId: 'attempt_1',
      stageId: 'S08_storage_write',
    }),
    envelope(3, 110, 'resource_sample', {
      sampleScope: 'worker_process',
      cpuUserUs: { status: 'observed', value: 0 },
      cpuSystemUs: { status: 'observed', value: 0 },
    }),
    envelope(4, 120, 'resource_sample', {
      sampleScope: 'worker_process',
      cpuUserUs: { status: 'observed', value: 1_150_000 },
      cpuSystemUs: { status: 'observed', value: 0 },
    }),
    envelope(5, 200, 'span_finished', {
      spanId: 'span_storage_verified',
      operationId: `op_${'c'.repeat(16)}`,
      attemptId: 'attempt_1',
      stageId: 'S08_storage_write',
      status: 'completed',
      endMonotonicNs: '200',
      elapsedNs: '95',
      stateIntegrity: 'verified',
    }),
    envelope(6, 210, 'trace_status', {
      finalizationState: 'provisional', traceIncomplete: true, traceTruncated: false,
      samplingIncomplete: true, diagnosticAdmissible: false, eventsDropped: 0, bytesDropped: 0,
      profilesMissing: 0, profilesMissingExact: true, stateIntegrity: 'unknown',
      reasonCode: 'finalization_unverified', reasonCodes: ['finalization_unverified'],
    }),
  ];
  const profilerEvents = [
    envelope(1, 100, 'preload_started'),
    ...profileEvents('seg_000001', 2, 110, profileBytes),
    ...profileEvents('seg_000002', 6, 120, profileBytes),
    envelope(10, 130, 'trace_status', {
      finalizationState: 'provisional', traceIncomplete: false, traceTruncated: false,
      samplingIncomplete: false, diagnosticAdmissible: false, eventsDropped: 0, bytesDropped: 0,
      profilesMissing: 0, profilesMissingExact: true, stateIntegrity: 'unknown', reasonCodes: [],
    }),
  ];
  await Promise.all([
    writeFile(join(traceDirectory, `trace-${workerIdentity.pid}-${workerIdentity.processStartTicks}.jsonl`),
      `${traceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 }),
    writeFile(join(traceDirectory, `profile-events-${workerIdentity.pid}-${workerIdentity.processStartTicks}.jsonl`),
      `${profilerEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 }),
    writeFile(join(traceDirectory, 'diagnostic-worker-result.json'), `${JSON.stringify({
      schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
      recipeDigest, sourceFingerprint, status: 'completed', exitCode: 0,
      diagnosticAdmissible: false, observerFailure: false, traceIncomplete: false,
      scenario: { records: [{ status: 'valid' }] },
    })}\n`, { mode: 0o600 }),
  ]);
  return { runDirectory, traceDirectory, traceFile: join(traceDirectory, `trace-${workerIdentity.pid}-${workerIdentity.processStartTicks}.jsonl`), profilePaths };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('returns_missing_for_a_private_artifact_removed_before_its_open', async () => {
  const artifacts = await loadAdmissionArtifactsModule();
  const runDirectory = await mkdtemp(join(tmpdir(), 'nexus-admission-missing-artifact-'));
  roots.push(runDirectory);

  await expect(artifacts.readPrivateDiagnosticArtifact(
    join(runDirectory, 'removed.json'), runDirectory, 1024,
  )).resolves.toBeUndefined();
});

it('collects source-free supervisor evidence from private worker artifacts', async () => {
  const collector = await loadCollectorModule();
  const run = await createRunArtifacts();

  const evidence = await collector.collectDiagnosticAdmissionEvidence({
    runId,
    ...run,
    sourceGate: { status: 'PASS', digest: sourceFingerprint },
    hostGate: hostGateResult,
    cleanupStatus: 'verified',
    supervisorProcessSamples,
    clockMapping: alignedClockMapping(),
  });

  expect(evidence).toMatchObject({
    runId,
    sourceGate: { status: 'PASS', digest: sourceFingerprint },
    hostGate: hostGateResult,
    workerResult: { status: 'completed', sourceFingerprint, recipeDigest },
    profile: {
      clockAlignmentStatus: 'aligned',
      correlationStatus: 'cpu_active_fork_profile_captured',
      workerIdentity: { pid: workerIdentity.pid, startTicks: workerIdentity.processStartTicks, parentPid: workerIdentity.ppid },
      cpuDeltaUs: 1_150_000,
      selfSamples: 100,
      profilesMissing: 0,
      segments: [{ segmentId: 'seg_000001' }, { segmentId: 'seg_000002' }],
    },
    storageIntegrity: { status: 'verified' },
    cleanup: { status: 'verified', remainingProcessCount: 0 },
  });
  expect(Array.isArray(evidence.artifacts)).toBe(true);
  for (const profilePath of run.profilePaths) expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
});

it('excludes_parent_preload_profiles_from_worker_admission_evidence', async () => {
  const collector = await loadCollectorModule();
  const run = await createRunArtifacts();
  const parentIdentity = { pid: 2020, processStartTicks: '4444', ppid: 1, processRole: 'vitest_parent' } as const;
  const parentEnvelope = (seq: number, monotonicNs: number, event: string, details: Readonly<Record<string, unknown>> = {}) => ({
    ...envelope(seq, monotonicNs, event, details),
    pid: parentIdentity.pid,
    processStartTicks: parentIdentity.processStartTicks,
    ppid: parentIdentity.ppid,
    processRole: parentIdentity.processRole,
  });
  const parentProfile = JSON.stringify({
    nodes: [{ id: 1, callFrame: { functionName: 'bootstrap', url: '' } }],
    samples: [1, 1],
    metadata: 'x'.repeat(5 * 1024 * 1024),
  });
  const parentProfilePath = join(run.traceDirectory, 'profiles',
    `profile-${parentIdentity.pid}-${parentIdentity.processStartTicks}-seg_000001.cpuprofile`);
  const parentProfileBytes = Buffer.byteLength(parentProfile);
  const parentEvents = [
    parentEnvelope(1, 100, 'preload_started'),
    ...profileEvents('seg_000001', 2, 110, parentProfileBytes).map((event) => ({
      ...event,
      pid: parentIdentity.pid,
      processStartTicks: parentIdentity.processStartTicks,
      ppid: parentIdentity.ppid,
      processRole: parentIdentity.processRole,
    })),
    parentEnvelope(6, 130, 'trace_status', {
      finalizationState: 'provisional', traceIncomplete: true, traceTruncated: false,
      samplingIncomplete: true, diagnosticAdmissible: false, eventsDropped: 0, bytesDropped: 0,
      profilesMissing: 0, profilesMissingExact: true, stateIntegrity: 'unknown',
      reasonCode: 'finalization_unverified', reasonCodes: [],
    }),
  ];
  await Promise.all([
    writeFile(parentProfilePath, parentProfile, { mode: 0o600 }),
    writeFile(join(run.traceDirectory, `profile-events-${parentIdentity.pid}-${parentIdentity.processStartTicks}.jsonl`),
      `${parentEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 }),
  ]);

  const evidence = await collector.collectDiagnosticAdmissionEvidence({
    runId,
    ...run,
    sourceGate: { status: 'PASS', digest: sourceFingerprint },
    hostGate: hostGateResult,
    cleanupStatus: 'verified',
    supervisorProcessSamples,
    clockMapping: alignedClockMapping(),
  });

  expect(isAdmissionEvidence(evidence)).toBe(true);
  if (!isAdmissionEvidence(evidence)) throw new Error('admission_evidence_profile_missing');
  expect(evidence.profile.correlationStatus).toBe('cpu_active_fork_profile_captured');
  expect(evidence.profile.selfSamples).toBe(100);
  expect(evidence.profile.stageOverlaps.some((overlap) => overlap.stageId === 'S08_storage_write')).toBe(true);
  expect(evidence.artifacts).toContainEqual({ kind: 'profile_support', path: parentProfilePath });
  const admission = await loadAdmissionModule();
  await expect(admission.finalizeDiagnosticRun(evidence, {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    sourceFingerprint,
    recipeDigest,
    workerStatus: 'completed',
    workerExitCode: 0,
    cleanupStatus: 'verified',
    remainingProcessCount: 0,
    finalizedByPid: process.pid,
  })).resolves.toMatchObject({
    admissible: true,
    reasonCodes: [],
  });
});

it('does_not_claim_a_fork_profile_without_overlap_with_a_worker_stage', async () => {
  const collector = await loadCollectorModule();
  const run = await createRunArtifacts();
  const traceEvents = (await readFile(run.traceFile, 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
    .filter((event) => event.event !== 'span_started' && event.event !== 'span_finished')
    .map((event, index) => ({ ...event, seq: index + 1 }));
  await writeFile(run.traceFile, `${traceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 });

  const evidence = await collector.collectDiagnosticAdmissionEvidence({
    runId,
    ...run,
    sourceGate: { status: 'PASS', digest: sourceFingerprint },
    hostGate: hostGateResult,
    cleanupStatus: 'verified',
    supervisorProcessSamples,
    clockMapping: alignedClockMapping(),
  });

  expect(isAdmissionEvidence(evidence)).toBe(true);
  if (!isAdmissionEvidence(evidence)) throw new Error('admission_evidence_profile_missing');
  expect(evidence.profile.correlationStatus).toBe('worker_profile_NOT_PROVEN');
  expect(evidence.profile.reasonCodes).toContain('stage_clock_mismatch');
});

it('does_not_claim_process_local_clocks_are_cross_process_aligned_without_a_mapping', async () => {
  const collector = await loadCollectorModule();
  const run = await createRunArtifacts();

  const evidence = await collector.collectDiagnosticAdmissionEvidence({
    runId,
    ...run,
    sourceGate: { status: 'PASS', digest: sourceFingerprint },
    hostGate: hostGateResult,
    cleanupStatus: 'verified',
    supervisorProcessSamples,
  });

  expect(isAdmissionEvidence(evidence)).toBe(true);
  if (!isAdmissionEvidence(evidence)) throw new Error('admission_evidence_profile_missing');
  expect(evidence.profile.clockAlignmentStatus).toBe('not_correlatable');
  expect(evidence.profile.correlationStatus).toBe('worker_profile_NOT_PROVEN');
  expect(evidence.profile.reasonCodes).toContain('clock_unaligned');
});
