import { it } from 'vitest';
import { runDiagnosticWorkerEntry } from './diagnostic-worker-entry.js';

it('executes one private diagnostic performance request', async () => {
  const result = await runDiagnosticWorkerEntry(process.env);
  if (result.status !== 'completed') throw new Error('diagnostic_worker_scenario_failed');
});
