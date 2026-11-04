import { z } from 'zod';

export const diagnosticWorkerScenarioSchema = z.object({
  records: z.array(z.object({
    status: z.enum(['valid', 'invalid', 'skipped', 'blocked']),
  }).passthrough()).min(1),
}).passthrough();

export const diagnosticWorkerResultSchema = z.object({
  schemaVersion: z.literal(1),
  diagnosticOnly: z.literal(true),
  runId: z.string().uuid(),
  jobId: z.literal('cold_initial_index'),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['completed', 'failed']),
  exitCode: z.number().int(),
  diagnosticAdmissible: z.literal(false),
  observerFailure: z.boolean(),
  traceIncomplete: z.boolean(),
  scenario: diagnosticWorkerScenarioSchema,
}).passthrough();
