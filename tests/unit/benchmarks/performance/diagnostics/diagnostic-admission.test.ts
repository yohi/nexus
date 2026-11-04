import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

type DiagnosticAdmissionSummary = Readonly<{
  schemaVersion: 1;
  diagnosticOnly: true;
  runId: string;
  jobId: 'cold_initial_index';
  admissible: boolean;
  reasonCodes: readonly string[];
  workerPid: number | null;
  profileSegments: number;
  selfSamples: number;
}>;
type DiagnosticAdmissionModule = Readonly<{
  finalizeDiagnosticRun: (
    evidence: Readonly<Record<string, unknown>>,
    supervisorFinalization?: Readonly<Record<string, unknown>>,
  ) => Promise<DiagnosticAdmissionSummary>;
}>;

function isAdmissionModule(value: unknown): value is DiagnosticAdmissionModule {
  return typeof value === 'object' && value !== null
    && 'finalizeDiagnosticRun' in value && typeof value.finalizeDiagnosticRun === 'function';
}

async function loadAdmissionModule(): Promise<DiagnosticAdmissionModule> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/diagnostic-admission.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(url);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isAdmissionModule(loaded)).toBe(true);
  if (!isAdmissionModule(loaded)) throw new Error('diagnostic_admission_module_missing');
  return loaded;
}

const runId = '00000000-0000-4000-8000-000000000001';
const sourceFingerprint = 'b'.repeat(64);
const recipeDigest = 'a'.repeat(64);
const roots: string[] = [];

function supervisorFinalization() {
  return Object.freeze({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    recipeDigest,
    sourceFingerprint,
    workerStatus: 'completed',
    workerExitCode: 0,
    cleanupStatus: 'verified',
    remainingProcessCount: 0,
    finalizedByPid: process.pid,
  });
}

async function createEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  const runDirectory = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-admission-'));
  roots.push(runDirectory);
  const traceFile = join(runDirectory, 'trace.jsonl');
  const workerResultFile = join(runDirectory, 'diagnostic-worker-result.json');
  const profileFiles = [join(runDirectory, 'profile-a.cpuprofile'), join(runDirectory, 'profile-b.cpuprofile')];
  const workerIdentity = { pid: 3030, startTicks: '9876', parentPid: 2020 };
  const profileJson = JSON.stringify({
    nodes: [{ id: 1, callFrame: { functionName: 'worker', url: '' } }],
    samples: Array.from({ length: 50 }, () => 1),
  });
  const envelope = (seq: number, monotonicNs: number, event: string, details: Readonly<Record<string, unknown>> = {}) => ({
    schemaVersion: 1, seq, monotonicNs: String(monotonicNs), event, runId,
    jobId: 'cold_initial_index', recipeDigest: 'a'.repeat(64), sourceFingerprint,
    pid: workerIdentity.pid, processStartTicks: workerIdentity.startTicks, ppid: workerIdentity.parentPid,
    processRole: 'vitest_worker', clockDomain: 'process_local_monotonic', ...details,
  });
  const traceEvents: Readonly<Record<string, unknown>>[] = [
    envelope(1, 100, 'preload_started'),
  ];
  profileFiles.forEach((path, index) => {
    const segmentId = `segment_${index + 1}`;
    const seq = traceEvents.length + 1;
    const startNs = 100 + seq * 10;
    traceEvents.push(
      envelope(seq, startNs, 'profile_segment_started', {
        segmentId,
        sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' },
        fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
      }),
      envelope(seq + 1, startNs + 1, 'profile_segment_stop_requested', {
        segmentId,
        sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' },
        fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
      }),
      envelope(seq + 2, startNs + 2, 'profile_segment_stopped', {
        segmentId,
        sampleCount: { status: 'observed', value: 50 },
        fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
      }),
      envelope(seq + 3, startNs + 3, 'profile_write_completed', {
        segmentId,
        sampleCount: { status: 'observed', value: 50 },
        fileBytes: { status: 'observed', value: Buffer.byteLength(profileJson) },
      }),
    );
  });
  traceEvents.push(envelope(traceEvents.length + 1, 500, 'trace_status', {
    finalizationState: 'provisional', traceIncomplete: false, traceTruncated: false,
    samplingIncomplete: false, diagnosticAdmissible: false, eventsDropped: 0, bytesDropped: 0,
    profilesMissing: 0, profilesMissingExact: true, stateIntegrity: 'verified', reasonCodes: [],
  }));
  await Promise.all([
    writeFile(join(runDirectory, 'supervisor-status.json'), `${JSON.stringify({
      schemaVersion: 1,
      diagnosticOnly: true,
      runId,
      sourceFingerprint,
      recipeDigest,
      status: 'running',
      supervisorPid: process.pid,
    })}\n`, { mode: 0o600 }),
    writeFile(traceFile, `${traceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 }),
    writeFile(workerResultFile, `${JSON.stringify({
      schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64), sourceFingerprint,
      status: 'completed', exitCode: 0, diagnosticAdmissible: false,
      observerFailure: false, traceIncomplete: false, scenario: { records: [{ status: 'valid' }] },
    })}\n`, { mode: 0o600 }),
    ...profileFiles.map((path) => writeFile(path, profileJson, { mode: 0o600 })),
  ]);
  const evidence = {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    runDirectory,
    sourceGate: { status: 'PASS', digest: sourceFingerprint },
    hostGate: {
      status: 'PASS', snapshotCount: 3, reasonCodes: [], requiredScratchBytes: 5_000_000_000,
      scratchFreeBytes: 8_000_000_000, effectiveCpuCapacity: 4,
    },
    workerResult: {
      schemaVersion: 1,
      diagnosticOnly: true,
      runId, jobId: 'cold_initial_index', status: 'completed', exitCode: 0, diagnosticAdmissible: false,
      recipeDigest: 'a'.repeat(64), sourceFingerprint,
      observerFailure: false,
      traceIncomplete: false,
      scenario: { records: [{ status: 'valid' }] },
    },
    traceStatus: {
      runId,
      finalizationState: 'provisional',
      traceIncomplete: false,
      traceTruncated: false,
      samplingIncomplete: false,
      diagnosticAdmissible: false,
      eventsDropped: 0,
      bytesDropped: 0,
      profilesMissing: 0,
      profilesMissingExact: true,
      stateIntegrity: 'verified',
      reasonCodes: [],
    },
    profile: {
      clockAlignmentStatus: 'aligned',
      correlationStatus: 'cpu_active_fork_profile_captured',
      reasonCodes: [],
      workerIdentity,
      cpuDeltaUs: 1_500_000,
      preloadMarker: { runId, ...workerIdentity, processRole: 'vitest_worker' },
      selfSamples: 100,
      profilesMissing: 0,
      stageOverlaps: [{ stageId: 'S08_storage_write', overlapNs: '5' }],
      segments: profileFiles.map((path, index) => ({
        segmentId: `segment_${index + 1}`, path, profileValid: true, sampleCount: 50, fileBytes: Buffer.byteLength(profileJson),
      })),
    },
    storageIntegrity: { status: 'verified' },
    cleanup: { status: 'verified', remainingProcessCount: 0 },
    artifacts: [
      { kind: 'trace', path: traceFile },
      { kind: 'worker_result', path: workerResultFile },
      ...profileFiles.map((path) => ({ kind: 'profile', path })),
    ],
    ...overrides,
  };
  return { evidence, runDirectory, traceFile, profileFiles, workerResultFile };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('admits_only_complete_verified_profile_evidence_and_writes_a_private_summary', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, runDirectory, profileFiles } = await createEvidence();

  const summary = await admission.finalizeDiagnosticRun(evidence, supervisorFinalization());

  expect(summary).toMatchObject({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    admissible: true,
    reasonCodes: [],
    workerPid: 3030,
    profileSegments: 2,
    selfSamples: 100,
  });
  const summaryPath = join(runDirectory, 'diagnostic-summary.json');
  expect(JSON.parse(await readFile(summaryPath, 'utf8'))).toEqual(summary);
  expect((await stat(summaryPath)).mode & 0o777).toBe(0o600);
  await expect(stat(join(runDirectory, 'report.json'))).rejects.toThrow();
  expect(profileFiles).toHaveLength(2);
});

it('rejects_complete_worker_evidence_until_the_supervisor_provides_finalization_proof', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence();

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('supervisor_finalization_unverified');
});

it('rejects_a_host_pass_claim_with_gate_reason_codes', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({
    hostGate: { status: 'PASS', snapshotCount: 3, reasonCodes: ['snapshot_set_incomplete'] },
  });

  const summary = await admission.finalizeDiagnosticRun(evidence, supervisorFinalization());

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('host_gate_not_pass');
});

it('rejects_a_host_pass_without_complete_resource_evidence', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({
    hostGate: { status: 'PASS', snapshotCount: 3, reasonCodes: [] },
  });

  const summary = await admission.finalizeDiagnosticRun(evidence, supervisorFinalization());

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('host_gate_not_pass');
});

it('admits_a_provisional_worker_terminal_only_after_supervisor_finalization_verifies_delivery_and_cleanup', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, traceFile } = await createEvidence();
  const traceLines = (await readFile(traceFile, 'utf8')).trimEnd().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const last = traceLines.pop();
  if (last === undefined) throw new Error('trace_terminal_missing');
  const baseSeq = traceLines.length + 1;
  const stageIdentity = {
    spanId: 'span_supervisor_verified_storage',
    operationId: `op_${'c'.repeat(16)}`,
    attemptId: 'attempt_1',
    stageId: 'S08_storage_write',
  };
  traceLines.push(
    {
      ...last,
      seq: baseSeq,
      monotonicNs: '480',
      event: 'span_started',
      ...stageIdentity,
    },
    {
      ...last,
      seq: baseSeq + 1,
      monotonicNs: '490',
      event: 'span_finished',
      ...stageIdentity,
      status: 'completed',
      endMonotonicNs: '490',
      elapsedNs: '10',
      stateIntegrity: 'verified',
    },
    {
      ...last,
      seq: baseSeq + 2,
      monotonicNs: '500',
      event: 'trace_status',
      finalizationState: 'provisional',
      traceIncomplete: true,
      traceTruncated: false,
      samplingIncomplete: true,
      diagnosticAdmissible: false,
      eventsDropped: 0,
      bytesDropped: 0,
      profilesMissing: 0,
      profilesMissingExact: true,
      stateIntegrity: 'unknown',
      reasonCode: 'finalization_unverified',
      reasonCodes: ['finalization_unverified'],
    },
  );
  await writeFile(traceFile, `${traceLines.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 });
  const finalizationEvidence = {
    ...evidence,
    traceStatus: traceLines.at(-1),
    storageIntegrity: { status: 'verified' },
  };

  const summary = await admission.finalizeDiagnosticRun(finalizationEvidence, supervisorFinalization());

  expect(summary).toMatchObject({ admissible: true, reasonCodes: [] });
});

it('rejects_unverified_cleanup_without_admitting_the_run', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({ cleanup: { status: 'unverified', remainingProcessCount: 1 } });

  const summary = await admission.finalizeDiagnosticRun(evidence, supervisorFinalization());

  expect(summary).toMatchObject({ admissible: false, reasonCodes: ['cleanup_unverified'], workerPid: 3030 });
});

it('rejects_cpu_inactive_worker_and_mismatched_preload_identity', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({
    profile: {
      clockAlignmentStatus: 'aligned',
      correlationStatus: 'cpu_active_fork_profile_captured',
      reasonCodes: [],
      workerIdentity: { pid: 3030, startTicks: '9876', parentPid: 2020 },
      cpuDeltaUs: 10,
      preloadMarker: { runId, pid: 3030, startTicks: '9877', parentPid: 2020, processRole: 'vitest_worker' },
      selfSamples: 100,
      profilesMissing: 0,
      segments: [
        { segmentId: 'segment_1', path: '/tmp/profile-a', profileValid: true, sampleCount: 50, fileBytes: 128 },
        { segmentId: 'segment_2', path: '/tmp/profile-b', profileValid: true, sampleCount: 50, fileBytes: 128 },
      ],
    },
  });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toEqual(expect.arrayContaining(['cpu_inactive', 'preload_identity_mismatch']));
});

it('rejects_trace_loss_unknown_storage_state_and_unaligned_clocks_independently', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({
    traceStatus: {
      runId, finalizationState: 'provisional', traceIncomplete: true, traceTruncated: false,
      samplingIncomplete: false, diagnosticAdmissible: false, eventsDropped: 1, bytesDropped: 0,
      profilesMissing: 0, profilesMissingExact: true, stateIntegrity: 'unknown', reasonCodes: ['write_error'],
    },
    profile: {
      clockAlignmentStatus: 'not_correlatable', correlationStatus: 'cpu_active_fork_profile_captured',
      reasonCodes: [], workerIdentity: { pid: 3030, startTicks: '9876', parentPid: 2020 }, cpuDeltaUs: 1_500_000,
      preloadMarker: { runId, pid: 3030, startTicks: '9876', parentPid: 2020, processRole: 'vitest_worker' },
      selfSamples: 100, profilesMissing: 0,
      segments: [
        { segmentId: 'segment_1', path: '/tmp/profile-a', profileValid: true, sampleCount: 50, fileBytes: 128 },
        { segmentId: 'segment_2', path: '/tmp/profile-b', profileValid: true, sampleCount: 50, fileBytes: 128 },
      ],
    },
    storageIntegrity: { status: 'unknown' },
  });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toEqual(expect.arrayContaining([
    'trace_incomplete', 'trace_events_dropped', 'clock_unaligned', 'storage_integrity_unverified',
  ]));
});

it('rejects_a_trace_status_with_nonempty_reason_codes_even_if_boolean_flags_are_clear', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({
    traceStatus: {
      runId, finalizationState: 'provisional', traceIncomplete: false, traceTruncated: false,
      samplingIncomplete: false, diagnosticAdmissible: false, eventsDropped: 0, bytesDropped: 0,
      profilesMissing: 0, profilesMissingExact: true, stateIntegrity: 'verified', reasonCodes: ['write_error'],
    },
  });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toEqual(expect.arrayContaining(['trace_reason_codes_present', 'trace_status_mismatch']));
});

it('rejects_a_worker_result_file_that_does_not_match_the_admission_evidence', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, workerResultFile } = await createEvidence();
  await writeFile(workerResultFile, '{"status":"failed"}\n', { mode: 0o600 });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('worker_result_invalid');
});

it('rejects_a_completed_worker_result_containing_an_invalid_scenario_record', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, workerResultFile } = await createEvidence();
  await writeFile(workerResultFile, `${JSON.stringify({
    schemaVersion: 1, diagnosticOnly: true, runId, jobId: 'cold_initial_index',
    recipeDigest: 'a'.repeat(64), sourceFingerprint,
    status: 'completed', exitCode: 0, diagnosticAdmissible: false,
    observerFailure: false, traceIncomplete: false, scenario: { records: [{ status: 'invalid' }] },
  })}\n`, { mode: 0o600 });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('worker_scenario_invalid');
});

it('rejects_a_profile_identity_that_uses_the_bootstrap_pid_as_the_worker_pid', async () => {
  const admission = await loadAdmissionModule();
  const { evidence: baseEvidence } = await createEvidence();
  const evidence = {
    ...baseEvidence,
    profile: {
      ...baseEvidence.profile,
      workerIdentity: { pid: 2020, startTicks: '9876', parentPid: 2020 },
      preloadMarker: { runId, pid: 2020, startTicks: '9876', parentPid: 2020, processRole: 'vitest_worker' },
    },
  };

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('worker_pid_not_fork');
});

it('rejects_a_pass_source_gate_when_its_digest_differs_from_the_worker_source', async () => {
  const admission = await loadAdmissionModule();
  const { evidence } = await createEvidence({
    sourceGate: { status: 'PASS', digest: 'c'.repeat(64) },
  });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('source_fingerprint_mismatch');
});

it('rejects_a_trace_file_without_a_terminal_trace_status_event', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, traceFile } = await createEvidence();
  await writeFile(traceFile, '{"event":"preload_started"}\n', { mode: 0o600 });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('trace_terminal_missing');
});

it('rejects_trace_events_whose_source_or_recipe_identity_differs_from_the_worker_result', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, traceFile } = await createEvidence();
  const traceEvents = (await readFile(traceFile, 'utf8')).trimEnd().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const index = traceEvents.findIndex((event) => event.event === 'profile_segment_started');
  const event = traceEvents[index];
  if (event === undefined) throw new Error('profile_segment_start_missing');
  traceEvents[index] = { ...event, sourceFingerprint: 'c'.repeat(64) };
  await writeFile(traceFile, `${traceEvents.map((value) => JSON.stringify(value)).join('\n')}\n`, { mode: 0o600 });

  const summary = await admission.finalizeDiagnosticRun(evidence, supervisorFinalization());

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('trace_identity_mismatch');
});

it('rejects_a_profile_file_with_sample_ids_not_present_in_its_nodes', async () => {
  const admission = await loadAdmissionModule();
  const { evidence, profileFiles } = await createEvidence();
  await writeFile(profileFiles[0] ?? '', JSON.stringify({
    nodes: [{ id: 1, callFrame: { functionName: 'worker', url: '' } }],
    samples: [2],
  }), { mode: 0o600 });

  const summary = await admission.finalizeDiagnosticRun(evidence);

  expect(summary.admissible).toBe(false);
  expect(summary.reasonCodes).toContain('profile_artifact_invalid');
});
