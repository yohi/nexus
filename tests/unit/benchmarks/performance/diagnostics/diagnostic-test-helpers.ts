import { createTraceRecorder } from '../../../../benchmarks/performance/diagnostics/trace-recorder.js';

export const operationId = 'op_0000000000000001';
export const attemptId = 'attempt_1';
const runId = '00000000-0000-4000-8000-000000000001';

export function createDiagnosticTestContext() {
  return {
    recorder: createTraceRecorder({
      runId,
      jobId: 'cold_initial_index',
      recipeDigest: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      pid: 3002,
      processStartTicks: '4567',
      ppid: 2000,
      processRole: 'vitest_worker',
      clockDomain: 'process_local_monotonic',
    }, { nowNs: () => process.hrtime.bigint() }),
    operationId,
    attemptId,
  };
}
