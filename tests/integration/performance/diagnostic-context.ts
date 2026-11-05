import { createRuntimeDiagnosticContext } from '../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { createTraceRecorder } from '../../benchmarks/performance/diagnostics/trace-recorder.js';

export function createDiagnosticWorkerContext() {
  const workerContext = {
    recorder: createTraceRecorder({
      runId: '00000000-0000-4000-8000-000000000001',
      jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      pid: 3002,
      processStartTicks: '4567',
      ppid: 2000,
      processRole: 'vitest_worker',
      clockDomain: 'process_local_monotonic',
    }, { nowNs: () => process.hrtime.bigint() }),
    operationId: 'op_0000000000000001',
    attemptId: 'attempt_1',
  };
  return { workerContext, runtimeContext: createRuntimeDiagnosticContext(workerContext) };
}
