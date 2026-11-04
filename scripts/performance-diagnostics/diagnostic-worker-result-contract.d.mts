import type { z } from 'zod';

export type DiagnosticScenarioRecordStatus = 'valid' | 'invalid' | 'skipped' | 'blocked';
export type DiagnosticWorkerScenario = Readonly<{
  records: readonly Readonly<{ status: DiagnosticScenarioRecordStatus }>[];
  readonly [key: string]: unknown;
}>;
export type DiagnosticWorkerResult = Readonly<{
  schemaVersion: 1;
  diagnosticOnly: true;
  runId: string;
  jobId: 'cold_initial_index';
  recipeDigest: string;
  sourceFingerprint: string;
  status: 'completed' | 'failed';
  exitCode: number;
  diagnosticAdmissible: false;
  observerFailure: boolean;
  traceIncomplete: boolean;
  scenario: DiagnosticWorkerScenario;
  readonly [key: string]: unknown;
}>;

export const diagnosticWorkerScenarioSchema: z.ZodType<DiagnosticWorkerScenario>;
export const diagnosticWorkerResultSchema: z.ZodType<DiagnosticWorkerResult>;
