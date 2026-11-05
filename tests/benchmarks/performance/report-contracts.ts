import { z } from 'zod';
import type * as Contracts from './contracts.js';
import { cacheAccountingSchema } from './cache-accounting.js';
import { cacheSeedResultSchema, validCacheSeedResultSchema } from './cache-seed.js';
import { workloadSchema } from './workload.js';
import { workerInfoSchema } from './worker-proof.js';
import { limitProofSchema } from './worker-proof.js';
import { grepExecutionSchema, queryMetadataSchema } from './execution-contracts.js';

type ReportDependencies = Pick<typeof Contracts, 'validAuditResultSchema' | 'codeSchema' | 'countSchema' |
  'digestSchema' | 'durationSchema' | 'failureSchema' | 'revisionSchema' | 'runOptionsSchema' |
  'validRetrievalValidationSchema' | 'readinessProbeInfoSchema' | 'validReadinessRecordSchema'>;

export function createReportSchemas(dependencies: Readonly<ReportDependencies>) {
  const { validAuditResultSchema, codeSchema, countSchema, digestSchema, durationSchema, failureSchema,
    revisionSchema, runOptionsSchema, validRetrievalValidationSchema, readinessProbeInfoSchema, validReadinessRecordSchema } = dependencies;
  const unavailable = z.object({ status: z.literal('not_collected') }).strict().readonly();
  const resourcesSchema = z.object({
    node_worker: z.object({ cpuUserUs: countSchema, cpuSystemUs: countSchema, heapUsedBytes: countSchema,
      rssBytes: countSchema, lifetimePeakRssBytes: countSchema,
      cpuScope: z.enum(['runtime_to_completion', 'operation_to_completion', 'handler_group', 'setup_to_completion', 'worker_lifetime']),
      heapScope: z.literal('end_snapshot'), peakRssScope: z.literal('worker_lifetime'),
    }).strict().readonly(), external_ripgrep: unavailable, process_tree: unavailable,
  }).strict().readonly();
  const endpointsSchema = z.object({ runtime_ready_ms: durationSchema.optional(), audit_validation_ms: durationSchema.optional(),
    retrieval_probe_ms: durationSchema.optional(), audited_ready_ms: durationSchema.optional(), benchmark_completion_ms: durationSchema.optional(),
    setup_ms: durationSchema, cache_seed_ms: durationSchema.optional(), indexing_operation_ms: durationSchema.optional(),
    indexing_diagnostic_ms: durationSchema.optional() }).strict().readonly();
  const artifactBytesSchema = z.object({ metadataBytes: countSchema, vectorBytes: countSchema, totalBytes: countSchema,
    measurement: z.literal('apparent_bytes'), phase: z.literal('settled') }).strict().readonly();
  const idSchema = codeSchema.or(z.string().regex(/^[a-z][a-z0-9-]{0,95}$/));
  const base = { id: idSchema, revision: revisionSchema,
    boundary: z.enum(['handler-internal', 'runtime-assembly-to-ready', 'indexing-operation']),
    cacheState: z.enum(['empty', 'l1', 'l2', 'persisted']), sampleMode: z.enum(['smoke', 'full']),
    memoryLimitMb: z.number().int().positive(), fixtureDigest: digestSchema.optional(), worker: workerInfoSchema.optional() };
  const scenarioRecordSchema = z.discriminatedUnion('status', [
    z.object({ ...base, status: z.literal('valid'), rawSamples: z.array(durationSchema).min(1).readonly(),
      sampleKind: z.enum(['warm', 'lifecycle', 'first_call']), resources: resourcesSchema, endpoints: endpointsSchema,
      audit: validAuditResultSchema, validation: validRetrievalValidationSchema, cacheAccounting: cacheAccountingSchema.optional(),
      cacheSeed: validCacheSeedResultSchema.optional(), indexingMode: z.enum(['full_rebuild', 'incremental_queue', 'startup_reconciliation']).optional(),
      readinessProbe: readinessProbeInfoSchema.optional(), readinessRuns: z.array(validReadinessRecordSchema).readonly().optional(),
      warmupCalls: countSchema.optional(), measuredCalls: countSchema.optional(), artifactBytes: artifactBytesSchema.optional(),
      queryMetadata: queryMetadataSchema.optional(), grepExecution: z.array(grepExecutionSchema).readonly().optional(),
    }).strict(),
    z.object({ ...base, status: z.literal('invalid'), phase: z.enum(['setup', 'construction', 'initialization', 'indexing', 'audit', 'probe', 'retrieval', 'worker']),
      failures: z.array(failureSchema).min(1).readonly(), elapsedMs: durationSchema, candidateEndpoints: endpointsSchema.optional(),
      candidateSamples: z.array(durationSchema).readonly().optional(), cacheSeed: cacheSeedResultSchema.optional(),
      queryMetadata: queryMetadataSchema.optional(), grepExecution: z.array(grepExecutionSchema).readonly().optional(),
    }).strict(),
    z.object({ ...base, status: z.literal('skipped'), reason: codeSchema }).strict(),
    z.object({ ...base, status: z.literal('blocked'), reason: codeSchema }).strict(),
  ]).readonly();
  const environmentSchema = z.object({ node: z.string(), os: z.string(), architecture: z.string(), cpuModel: z.string(),
    cpuCount: countSchema, memoryBytes: countSchema, rgVersion: z.string().nullable(), gitVersion: z.string().nullable(),
    osCache: z.literal('uncontrolled'), dependencies: z.record(z.string(), z.string()).readonly().optional(),
    lockfileDigest: digestSchema.optional(), sourceFingerprint: digestSchema.optional(), aggregationLimits: limitProofSchema.optional(),
  }).strict().readonly();
  const warm = z.object({ kind: z.literal('warm'), id: idSchema, count: z.number().int().positive(),
    p50: durationSchema, p95: durationSchema, p99: durationSchema }).strict();
  const lifecycle = z.object({ kind: z.enum(['lifecycle', 'first_call']), id: idSchema, raw: z.array(durationSchema).min(1).readonly(),
    min: durationSchema, median: durationSchema, max: durationSchema }).strict();
  const reportSchema = z.object({ schemaVersion: z.literal(1), recipeVersion: z.literal('retrieval-performance-v1'),
    status: z.enum(['complete', 'incomplete']), runId: z.string().uuid(), fixtureDigest: digestSchema.nullable(),
    workload: workloadSchema.nullable(),
    environment: environmentSchema, options: runOptionsSchema.nullable(), scenarios: z.array(scenarioRecordSchema).readonly(),
    summaries: z.array(z.union([warm, lifecycle])).readonly(), warnings: z.array(codeSchema).readonly(),
    diagnostics: z.array(failureSchema).readonly(), coverage: z.object({ expectedIds: z.array(idSchema).readonly(),
      missingIds: z.array(idSchema).readonly(), validRecords: countSchema, invalidRecords: countSchema,
      skippedRecords: countSchema, blockedRecords: countSchema }).strict().readonly(),
  }).strict().superRefine((report, context) => {
    if (report.status === 'complete' && (report.options === null || report.fixtureDigest === null || report.workload === null || report.scenarios.length === 0 ||
      report.coverage.missingIds.length > 0 || report.scenarios.some((record) => record.status !== 'valid'))) {
      context.addIssue({ code: 'custom', message: 'incomplete_report_claimed_complete' });
    }
  }).readonly();
  return { scenarioRecordSchema, reportSchema, resourcesSchema, endpointsSchema, environmentSchema, artifactBytesSchema };
}
