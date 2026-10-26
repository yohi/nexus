import { z } from 'zod';
import { environmentSchema, failureSchema, runOptionsSchema, scenarioRecordSchema } from './contracts.js';
import { workloadSchema } from './workload.js';
import { limitProofSchema } from './worker-proof.js';
export { limitProofSchema } from './worker-proof.js';

export const jobKindSchema = z.enum(['cold_initial_index', 'l1_replay', 'l2_rebuild', 'warm_restart', 'incremental', 'siblings', 'warm', 'first_call']);
export const phaseSchema = z.enum(['setup', 'construction', 'initialization', 'indexing', 'audit', 'probe', 'retrieval', 'worker']);
export const jobSchema = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/), kind: jobKindSchema,
  repeat: z.number().int().nonnegative() }).strict().readonly();
export const transportSchema = z.object({ jobId: z.string(), kind: jobKindSchema, repeat: z.number().int().nonnegative(),
  resultFile: z.string(), phaseFile: z.string(), exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  spawnFailed: z.boolean(), timedOut: z.boolean(), aborted: z.boolean(), oom: z.boolean(), cleanupFailed: z.boolean(),
  elapsedMs: z.number().finite().nonnegative() }).strict().readonly();
const common = { schemaVersion: z.literal(1), runId: z.string().uuid(), ownerRoot: z.string().min(1),
  resultFile: z.string().min(1), phaseFile: z.string().min(1), deadlineEpochMs: z.number().finite().positive(),
  memoryLimitMb: z.number().int().positive(), timeoutMs: z.number().int().positive() };
export const workerRequestSchema = z.discriminatedUnion('mode', [
  z.object({ ...common, mode: z.literal('scenario'), options: runOptionsSchema, job: jobSchema }).strict(),
  z.object({ ...common, mode: z.literal('aggregate'), options: runOptionsSchema.nullable(),
    environment: environmentSchema, transports: z.array(transportSchema).readonly(),
    diagnostics: z.array(failureSchema).readonly() }).strict(),
]).readonly();
export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export type ScenarioRequest = Extract<WorkerRequest, { mode: 'scenario' }>;
export type AggregateRequest = Extract<WorkerRequest, { mode: 'aggregate' }>;
export type JobKind = z.infer<typeof jobKindSchema>;
export type JobTransport = z.infer<typeof transportSchema>;
export const workerResultSchema = z.object({ schemaVersion: z.literal(1), jobId: z.string(),
  options: runOptionsSchema, records: z.array(scenarioRecordSchema).readonly(),
  fixtureDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), workload: workloadSchema.nullable(),
  limits: limitProofSchema }).strict().readonly();
export type WorkerResult = z.infer<typeof workerResultSchema>;
