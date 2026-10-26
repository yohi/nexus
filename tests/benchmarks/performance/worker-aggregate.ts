import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { buildReport } from './report.js';
import type { AggregateRequest, JobTransport, ScenarioRequest } from './worker-contracts.js';
import { phaseSchema, workerResultSchema } from './worker-contracts.js';
import type { ScenarioRecord } from './contracts.js';
import { scenarioRecordSchema } from './contracts.js';
import { expectedJobIds } from './scenario-matrix.js';
import { invalidJobRecords } from './worker-records.js';
import type { WorkloadSummary } from './workload.js';

async function failedTransport(request: AggregateRequest, transport: JobTransport, code: string) {
  if (request.options === null) return [];
  let phase: z.infer<typeof phaseSchema> = 'setup';
  try { phase = z.object({ phase: phaseSchema }).parse(JSON.parse(await readFile(transport.phaseFile, 'utf8'))).phase; }
  catch { phase = 'setup'; }
  const scenario: ScenarioRequest = { ...request, mode: 'scenario', options: request.options,
    job: { id: transport.jobId, kind: transport.kind, repeat: transport.repeat } };
  return invalidJobRecords(scenario, code, transport.elapsedMs, phase);
}

export async function aggregateWorkers(request: AggregateRequest) {
  const records: ScenarioRecord[] = [];
  const expectedIds: string[] = [];
  let workload: WorkloadSummary | null = null;
  for (const transport of request.transports) {
    if (request.options === null) break;
    expectedIds.push(...await expectedJobIds(transport.kind, request.options.profile));
    let failure: string | undefined;
    if (transport.oom) failure = 'worker_oom';
    else if (transport.timedOut) failure = 'worker_timeout';
    else if (transport.cleanupFailed) failure = 'worker_cleanup_failed';
    else if (transport.spawnFailed) failure = 'worker_spawn_failed';
    else if (transport.signal !== null || transport.aborted) failure = 'worker_killed';
    else if (transport.exitCode !== 0) failure = 'worker_exit_failed';
    if (failure !== undefined) { records.push(...await failedTransport(request, transport, failure)); continue; }
    try {
      const result = workerResultSchema.parse(JSON.parse(await readFile(transport.resultFile, 'utf8')));
      if (result.jobId !== transport.jobId || !isDeepStrictEqual(result.options, request.options)) throw new Error('worker_metadata_mismatch');
      if (result.limits.requestedMemoryLimitMb !== request.memoryLimitMb || result.limits.receivedMemoryLimitMb !== request.memoryLimitMb) {
        records.push(...await failedTransport(request, transport, 'heap_flag_mismatch')); continue;
      }
      if (result.limits.peakHeapUsedBytes > request.memoryLimitMb * 1024 * 1024 || result.records.some((record) =>
        record.status === 'valid' && record.resources.node_worker.heapUsedBytes > request.memoryLimitMb * 1024 * 1024)) {
        records.push(...await failedTransport(request, transport, 'heap_limit_exceeded')); continue;
      }
      const ids = await expectedJobIds(transport.kind, request.options.profile);
      if (result.records.length !== ids.length || ids.some((id) => result.records.filter((record) => record.id === id).length !== 1)) {
        records.push(...await failedTransport(request, transport, 'worker_case_coverage')); continue;
      }
      if (result.workload !== null) {
        if (workload !== null && !isDeepStrictEqual(workload, result.workload)) throw new Error('worker_workload_mismatch');
        workload = result.workload;
      }
      records.push(...result.records.map((record) => scenarioRecordSchema.parse({ ...record, worker: { ...result.limits,
        jobId: transport.jobId, timeoutMs: request.timeoutMs, auditPageSize: request.options?.auditPageSize,
        cacheSeedBatchSize: 512, heapCeiling: 'node_old_space_mib', setupCovered: true } })));
    } catch { records.push(...await failedTransport(request, transport, 'invalid_worker_result')); }
  }
  return buildReport(records, { runId: request.runId, options: request.options, environment: request.environment,
    fixtureDigest: workload?.digest ?? null, workload, expectedScenarioIds: expectedIds, diagnostics: request.diagnostics });
}
