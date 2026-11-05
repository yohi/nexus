import type { ScenarioRequest } from './worker-contracts.js';
import { scenarioRecordSchema } from './contracts.js';
import type { ScenarioRecord } from './contracts.js';
import { expectedJobIds } from './scenario-matrix.js';

export async function invalidJobRecords(request: ScenarioRequest, code: string, elapsedMs: number,
  phase: 'setup' | 'construction' | 'initialization' | 'indexing' | 'audit' | 'probe' | 'retrieval' | 'worker' = 'setup'): Promise<readonly ScenarioRecord[]> {
  const ids = await expectedJobIds(request.job.kind, request.options.profile);
  return ids.map((id) => scenarioRecordSchema.parse({ id, status: 'invalid', revision: request.options.revision,
    boundary: request.job.kind === 'warm' || request.job.kind === 'first_call' ? 'handler-internal' :
      request.job.kind === 'l1_replay' || request.job.kind === 'incremental' ? 'indexing-operation' : 'runtime-assembly-to-ready',
    cacheState: request.job.kind === 'l2_rebuild' ? 'l2' : request.job.kind === 'warm_restart' ? 'persisted' : 'empty',
    sampleMode: request.options.sampleMode, memoryLimitMb: request.options.memoryLimitMb,
    phase, elapsedMs, failures: [{ code, count: 1, examples: [] }] }));
}
