import { readFile } from 'node:fs/promises';
import { diagnosticRequestMatchesWorker, type ScenarioRequest, type WorkerDiagnosticRequest } from '../worker-contracts.js';
import { createTraceRecorder } from './trace-recorder.js';
import { createTraceFileWriter } from './trace-writer.js';
import { verifyOwnedDiagnosticDirectory } from './owned-diagnostic-directory.js';
import { createRuntimeDiagnosticContext, type WorkerStageContext } from './worker-stage-context.js';
import { WorkerResourceSampler } from './resource-sampler.js';
import type { RuntimeDiagnosticContext } from '../../../../src/observability/diagnostic-stage-trace.js';

export type WorkerDiagnosticContextResult =
  | Readonly<{ status: 'ready'; context: WorkerStageContext; runtimeContext: RuntimeDiagnosticContext; writer: ReturnType<typeof createTraceFileWriter>; resourceSampler: WorkerResourceSampler }>
  | Readonly<{ status: 'invalid'; reason: 'request_mismatch' | 'unverified' | 'process_identity_unavailable' }>;

export async function createWorkerDiagnosticContext(
  request: ScenarioRequest,
  diagnostic: WorkerDiagnosticRequest,
  options: Readonly<{ bootstrapStartNs?: bigint }> = {},
): Promise<WorkerDiagnosticContextResult> {
  if (!diagnosticRequestMatchesWorker(request, diagnostic)) return { status: 'invalid', reason: 'request_mismatch' };
  const directory = await verifyOwnedDiagnosticDirectory(request.ownerRoot, diagnostic.runDirectory);
  if (directory.status !== 'valid') return { status: 'invalid', reason: 'unverified' };
  try {
    const stat = await readFile('/proc/self/stat', 'utf8');
    const delimiter = stat.lastIndexOf(') ');
    if (delimiter < 0) return { status: 'invalid', reason: 'process_identity_unavailable' };
    const ticks = stat.slice(delimiter + 2).split(' ')[19];
    if (ticks === undefined || !/^[1-9][0-9]*$/.test(ticks)) return { status: 'invalid', reason: 'process_identity_unavailable' };
    const identity = {
      runId: diagnostic.runId,
      jobId: diagnostic.jobId,
      recipeDigest: diagnostic.recipeDigest,
      sourceFingerprint: diagnostic.sourceFingerprint,
      pid: process.pid,
      processStartTicks: ticks,
      ppid: process.ppid,
      processRole: /^\d+$/.test(process.env.VITEST_WORKER_ID ?? '') ? 'vitest_worker' as const : 'unknown_node' as const,
      clockDomain: 'process_local_monotonic' as const,
    };
    let firstSample = options.bootstrapStartNs;
    const clock = { nowNs: () => {
      const sample = firstSample ?? process.hrtime.bigint();
      firstSample = undefined;
      return sample;
    } };
    const recorder = createTraceRecorder(identity, clock);
    const resourceSampler = new WorkerResourceSampler(recorder);
    const context: WorkerStageContext = {
      recorder,
      operationId: diagnostic.operationId,
      attemptId: diagnostic.attemptId,
      resourceSampler,
    };
    return {
      status: 'ready',
      context,
      runtimeContext: createRuntimeDiagnosticContext(context),
      writer: createTraceFileWriter(directory.directory, identity),
      resourceSampler,
    };
  } catch {
    return { status: 'invalid', reason: 'process_identity_unavailable' };
  }
}
