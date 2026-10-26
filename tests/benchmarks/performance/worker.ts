import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { reportSchema } from './contracts.js';
import { workerRequestSchema, workerResultSchema } from './worker-contracts.js';
import { WorkerBudget, WorkerBudgetError } from './worker-budget.js';
import { runScenarioWorker } from './worker-scenario.js';
import { aggregateWorkers } from './worker-aggregate.js';
import { invalidJobRecords } from './worker-records.js';

function contained(root: string, path: string): void {
  const value = relative(root, resolve(path));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error('invalid_worker_control_path');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
}

export async function executePerformanceWorker(requestFile: string): Promise<void> {
  const request = workerRequestSchema.parse(JSON.parse(await readFile(requestFile, 'utf8')));
  const owner = await realpath(request.ownerRoot);
  for (const path of [requestFile, request.resultFile, request.phaseFile]) {
    contained(owner, path);
    contained(owner, await realpath(dirname(path)) === owner ? path : resolve(await realpath(dirname(path)), path.split(sep).at(-1) ?? ''));
  }
  const budget = new WorkerBudget(request);
  try {
    if (request.mode === 'aggregate') {
      budget.signal.throwIfAborted();
      const report = await aggregateWorkers(request);
      budget.refresh(); budget.signal.throwIfAborted();
      await atomicJson(request.resultFile, reportSchema.parse({ ...report, environment: { ...report.environment, aggregationLimits: budget.proof() } }));
    } else {
      const result = await runScenarioWorker(request, budget);
      let records = result.records;
      const limits = budget.proof();
      if (budget.signal.aborted) {
        const reason: unknown = budget.signal.reason;
        records = await invalidJobRecords(request, reason instanceof WorkerBudgetError ? reason.code : 'worker_aborted', 0);
      }
      await atomicJson(request.resultFile, workerResultSchema.parse({ schemaVersion: 1, jobId: request.job.id,
        options: request.options, records, fixtureDigest: result.fixtureDigest, workload: result.workload, limits }));
    }
  } finally { budget.close(); }
}
