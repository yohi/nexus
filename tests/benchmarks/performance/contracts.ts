import { z } from 'zod';
import { TOOL_DEFINITIONS } from '../../../src/server/tools/registry/definitions.js';
import { toZodV3Shape } from '../../../src/server/tools/registry/adapters/v1-adapter.js';
import { createReportSchemas } from './report-contracts.js';
import { cacheAccountingSchema } from './cache-accounting.js';
import { effectiveLimitSchema } from './execution-contracts.js';

export const profileSchema = z.enum(['smoke', 'small', 'medium', 'large']);
export type Profile = z.infer<typeof profileSchema>;
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const chunkHashSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const durationSchema = z.number().finite().nonnegative();
export const countSchema = z.number().int().nonnegative();
export const logicalPathSchema = z.string().min(1).refine((value) =>
  !value.startsWith('/') && !/^[A-Za-z]:/.test(value) &&
  !value.includes('\\') && !value.includes('\0') &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'invalid_logical_path',
);
export const revisionSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), dirty: z.boolean().nullable(),
}).strict().readonly();
export const runOptionsSchema = z.object({
  profile: profileSchema,
  outputMode: z.enum(['stdout', 'file']),
  revision: revisionSchema,
  timeoutMs: z.number().int().positive(),
  auditPageSize: z.number().int().min(1).max(512),
  cacheSeedBatchSize: z.literal(512),
  memoryLimitMb: z.number().int().positive(),
  sampleMode: z.enum(['smoke', 'full']),
}).strict().readonly();
export type RunOptions = z.infer<typeof runOptionsSchema>;

const spanSchema = z.object({
  startByte: countSchema, endByte: countSchema,
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
});
export const expectedRowSchema = spanSchema.extend({
  key: z.string().min(1), name: z.string().min(1),
  kind: z.enum(['function', 'import']),
  contentHash: chunkHashSchema, sourceHash: digestSchema,
}).strict().readonly();
export type ExpectedRow = z.infer<typeof expectedRowSchema>;
export const declarationSchema = spanSchema.extend({
  name: z.string().min(1), kind: z.literal('function'),
  signature: z.string().min(1), sourceHash: digestSchema,
}).strict().readonly();
export const importSchema = spanSchema.extend({
  moduleSpecifier: z.string().min(1), sourceHash: digestSchema,
}).strict().readonly();
export const fixtureFileSchema = z.object({
  path: logicalPathSchema, sourceHash: digestSchema, merkleHash: chunkHashSchema,
  bytes: countSchema, recipeIndex: countSchema, variant: z.enum(['initial', 'modified']),
  declarations: z.array(declarationSchema).readonly(),
  imports: z.array(importSchema).readonly(),
  legacyRows: z.array(expectedRowSchema).readonly(),
  structuredRows: z.array(expectedRowSchema).readonly(),
}).strict().readonly();
export type FixtureFile = z.infer<typeof fixtureFileSchema>;
const submatchSchema = z.object({
  start: countSchema, end: countSchema, contentDigest: digestSchema,
}).strict().readonly();
export const expectedMatchSchema = z.object({
  path: logicalPathSchema, line: z.number().int().positive(), lineDigest: digestSchema,
  submatches: z.array(submatchSchema).readonly(),
}).strict().readonly();
export type ExpectedMatch = z.infer<typeof expectedMatchSchema>;
const toolSchema = z.enum(['grep_search', 'semantic_search', 'hybrid_search',
  'get_file_outline', 'get_symbol_source', 'get_symbol_context']);
const argumentValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]);
export const queryCaseSchema = z.object({
  id: codeSchema.or(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)),
  tool: toolSchema,
  args: z.record(z.string(), argumentValueSchema).readonly(),
  expectedMatches: z.array(expectedMatchSchema).readonly(),
  requestedMaximum: z.number().int().positive(),
  limits: z.array(effectiveLimitSchema).readonly(),
}).strict().superRefine((query, context) => {
  const definition = TOOL_DEFINITIONS.find((item) => item.name === query.tool);
  if (definition === undefined || !z.object(toZodV3Shape(definition.input)).strict().safeParse(query.args).success) {
    context.addIssue({ code: 'custom', message: 'invalid_tool_arguments', path: ['args'] });
  }
}).readonly();
export type QueryCase = z.infer<typeof queryCaseSchema>;
export const fixtureManifestSchema = z.object({
  version: z.literal('retrieval-performance-v1'), digest: digestSchema, profile: profileSchema,
  bytes: countSchema, declarationsPerFile: z.number().int().positive(), maxChunkChars: z.literal(4096),
  provider: z.literal('test'), model: z.literal('nexus-synthetic-sha256-v1'), dimensions: z.literal(128),
  files: z.array(fixtureFileSchema).min(1).readonly(),
  queries: z.array(queryCaseSchema).min(1).readonly(),
}).strict().readonly();
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export const validGrepMultisetProofSchema = z.object({ status: z.literal('valid'), algorithm: z.literal('sha256-multiset-v1'),
  lineMatchCount: countSchema, submatchCount: countSchema, digest: digestSchema }).strict().readonly();
export const grepMultisetProofSchema = z.discriminatedUnion('status', [
  validGrepMultisetProofSchema.unwrap(),
  z.object({ status: z.literal('invalid'), algorithm: z.literal('sha256-multiset-v1'), reason: codeSchema,
    lineMatchCount: countSchema.optional(), submatchCount: countSchema.optional(), digest: digestSchema.optional() }).strict(),
]).readonly();
export type GrepMultisetProof = z.infer<typeof grepMultisetProofSchema>;
export const failureSchema = z.object({ code: codeSchema, count: countSchema,
  examples: z.array(logicalPathSchema).max(20).readonly() }).strict().readonly();
const auditCountsSchema = z.object({ legacyRows: countSchema, legacyFiles: countSchema,
  structuredRows: countSchema, structuredFiles: countSchema, declarations: countSchema,
  imports: countSchema, legacyGetStats: countSchema }).strict().readonly();
export const validAuditResultSchema = z.object({ status: z.literal('valid'), counts: auditCountsSchema,
  durationMs: durationSchema }).strict().readonly();
export const auditResultSchema = z.discriminatedUnion('status', [
  validAuditResultSchema.unwrap(),
  z.object({ status: z.literal('invalid'), counts: auditCountsSchema,
    durationMs: durationSchema, failures: z.array(failureSchema).readonly() }).strict(),
]).readonly();
export type AuditResult = z.infer<typeof auditResultSchema>;
export const validRetrievalValidationSchema = z.object({ status: z.literal('valid'), resultCount: countSchema,
    identities: z.array(z.object({ path: logicalPathSchema, name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).optional(),
      line: countSchema.optional(), origin: z.enum(['grep', 'semantic', 'structured', 'hybrid']),
      stage: z.enum(['legacy', 'structured', 'grep', 'outline', 'symbol', 'context']).optional(),
      identityDigest: digestSchema.optional() }).strict()).readonly(),
    grepProof: validGrepMultisetProofSchema.optional() }).strict().readonly();
export const retrievalValidationSchema = z.discriminatedUnion('status', [
  validRetrievalValidationSchema.unwrap(),
  z.object({ status: z.literal('invalid'), failures: z.array(failureSchema).readonly() }).strict(),
]).readonly();
export type RetrievalValidation = z.infer<typeof retrievalValidationSchema>;

export const readinessProbeInfoSchema = z.object({ tool: z.literal('get_symbol_source'),
  identity: z.object({ path: logicalPathSchema, name: z.string() }).strict().readonly(),
  warmedDependencies: z.array(z.enum(['sqlite_catalog', 'filesystem_read', 'safe_path_resolution',
    'source_hash_verification', 'runtime_initialization_barrier'])).readonly(),
}).strict().readonly();

export const readinessEndpointsSchema = z.object({ runtime_ready_ms: durationSchema, audit_validation_ms: durationSchema,
  retrieval_probe_ms: durationSchema, audited_ready_ms: durationSchema,
  indexing_diagnostic_ms: durationSchema.optional(), indexing_operation_ms: durationSchema.optional() }).strict().readonly();
export const validReadinessRecordSchema = z.object({ status: z.literal('valid'), endpoints: readinessEndpointsSchema,
  audit: validAuditResultSchema, validation: validRetrievalValidationSchema, cacheAccounting: cacheAccountingSchema,
  readinessProbe: readinessProbeInfoSchema }).strict().readonly();

export const { scenarioRecordSchema, reportSchema, resourcesSchema, endpointsSchema, environmentSchema, artifactBytesSchema } = createReportSchemas({
  validAuditResultSchema, codeSchema, countSchema, digestSchema, durationSchema,
  failureSchema, revisionSchema, runOptionsSchema, validRetrievalValidationSchema, readinessProbeInfoSchema, validReadinessRecordSchema,
});
export type ScenarioRecord = z.infer<typeof scenarioRecordSchema>;
export type PerformanceReport = z.infer<typeof reportSchema>;
