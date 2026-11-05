import type { ScenarioRequest, WorkerDiagnosticRequest } from '../tests/benchmarks/performance/worker-contracts.js';

export type PreparedDiagnosticRun = Readonly<{
  runId: string;
  diagnosticOnly: true;
  runDirectory: string;
  traceDirectory: string;
  workerRequestFile: string;
  workerDiagnosticRequestFile: string;
  resultFile: string;
  phaseFile: string;
  scenarioRequest: ScenarioRequest;
  workerDiagnosticRequest: WorkerDiagnosticRequest;
}>;

export type DiagnosticPreparationServices = Readonly<{
  repository?: string;
  runId?: string;
  sourceMetadata?: (repository: string) => Promise<Readonly<{
    revision: Readonly<{ commit: string | null; dirty: boolean | null }>;
    environment: Readonly<{ sourceFingerprint?: string | undefined }>;
  }>>;
  nowMs?: () => number;
}>;

export function prepareDiagnosticRun(
  options: Readonly<{ diagnosticsRoot: string }>,
  services?: DiagnosticPreparationServices,
): Promise<PreparedDiagnosticRun>;
