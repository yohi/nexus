import { it } from 'vitest';
import { executePerformanceWorker } from './worker.js';

it('executes one private performance request', async () => {
  const requestFile = process.env.NEXUS_PERF_REQUEST_FILE;
  if (requestFile === undefined) throw new Error('missing_performance_request');
  await executePerformanceWorker(requestFile);
});
